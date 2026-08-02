// The only file in the repo that imports the mongodb driver. Everything above
// it talks to the SyncTarget interface, which is what lets the push/restore
// logic be tested with an in-memory fake and no cluster.
//
// Bun note: mongodb@7 cannot run here — its bson@7 calls `node:v8`
// isBuildingSnapshot at import time, which Bun does not implement. The 6.x line
// (bson 6.x) works, so the dependency is deliberately pinned to ^6.
import { Binary, type Collection, type Db, MongoClient } from "mongodb";
import type { MongoConfig } from "../../config";
import type {
  CoverDoc,
  MangaDoc,
  ReadingEventDoc,
  SiteAdapterDoc,
} from "./sync.mapper";

/** Everything a push needs to know about the replica, in one round trip set. */
export interface ReplicaKeys {
  mangaIds: Set<string>;
  eventIds: Set<string>;
  adapterDomains: Set<string>;
  /** mangaId -> coverVersion, so covers diff without moving any bytes. */
  coverVersions: Map<string, number>;
}

export type ReplicaDoc = Record<string, unknown>;

/** Every collection here is keyed by a uuid (or a domain), never an ObjectId. */
type Keyed = { _id: string };

/** Cover shape as read for diffing: keys and versions, deliberately no bytes. */
type CoverVersionDoc = { _id: string; coverVersion: number };

export interface SyncTarget {
  connect(): Promise<void>;
  close(): Promise<void>;
  readKeys(): Promise<ReplicaKeys>;
  upsertMangas(docs: MangaDoc[]): Promise<void>;
  insertEvents(docs: ReadingEventDoc[]): Promise<void>;
  upsertAdapters(docs: SiteAdapterDoc[]): Promise<void>;
  upsertCovers(docs: CoverDoc[]): Promise<void>;
  deleteMangas(ids: string[]): Promise<void>;
  deleteEvents(ids: string[]): Promise<void>;
  deleteAdapters(domains: string[]): Promise<void>;
  deleteCovers(ids: string[]): Promise<void>;
  readMangas(): Promise<ReplicaDoc[]>;
  readEvents(): Promise<ReplicaDoc[]>;
  readAdapters(): Promise<ReplicaDoc[]>;
  /** One cover at a time: the whole set can be hundreds of megabytes. */
  readCover(mangaId: string): Promise<ReplicaDoc | null>;
}

const MANGAS = "mangas";
const EVENTS = "readingEvents";
const ADAPTERS = "siteAdapters";
const COVERS = "covers";

export function createMongoTarget(config: MongoConfig): SyncTarget {
  const client = new MongoClient(config.url, {
    // A stalled cluster must surface as a sync error, never as a hung request.
    serverSelectionTimeoutMS: 15_000,
  });
  let db: Db | null = null;

  const database = (): Db => {
    if (db === null) {
      throw new Error("Sync target used before connect()");
    }
    return db;
  };

  // The driver's generics assume `_id` is an ObjectId and require an index
  // signature (its `Document`). Our documents are closed shapes keyed by the
  // uuids SQLite already generates, which is what makes a push idempotent — so
  // the cast buys back precise filter types instead of losing them.
  const collection = <T extends Keyed>(name: string): Collection<T> =>
    database().collection(name) as unknown as Collection<T>;

  const ids = async (name: string): Promise<Set<string>> => {
    const docs = await collection<Keyed>(name)
      .find({}, { projection: { _id: 1 } })
      .toArray();
    return new Set(docs.map((doc) => doc._id));
  };

  // Restore reads hand documents straight to the defensive `from*Doc` mappers,
  // which validate every field, so widening to an untyped record is safe here.
  const asDocs = (docs: object[]): ReplicaDoc[] => docs as ReplicaDoc[];

  return {
    async connect() {
      await client.connect();
      db = client.db(config.db);
      // Idempotent: mirrors the constraints SQLite already enforces.
      await collection<MangaDoc>(MANGAS).createIndex(
        { normalizedSlug: 1 },
        { unique: true },
      );
      await collection<ReadingEventDoc>(EVENTS).createIndex({
        mangaId: 1,
        readAt: -1,
      });
    },

    async close() {
      await client.close();
      db = null;
    },

    async readKeys() {
      const [mangaIds, eventIds, adapterDomains, covers] = await Promise.all([
        ids(MANGAS),
        ids(EVENTS),
        ids(ADAPTERS),
        collection<CoverVersionDoc>(COVERS)
          // Never project `data`: the whole point is diffing covers without
          // pulling megabytes across the wire.
          .find({}, { projection: { _id: 1, coverVersion: 1 } })
          .toArray(),
      ]);

      return {
        mangaIds,
        eventIds,
        adapterDomains,
        coverVersions: new Map(
          covers.map((doc) => [
            doc._id,
            // A document written without a version can never match a local
            // one, so it re-uploads instead of being silently skipped.
            typeof doc.coverVersion === "number" ? doc.coverVersion : -1,
          ]),
        ),
      };
    },

    async upsertMangas(docs) {
      if (docs.length === 0) {
        return;
      }
      await collection<MangaDoc>(MANGAS).bulkWrite(
        docs.map((doc) => ({
          replaceOne: {
            filter: { _id: doc._id },
            replacement: doc,
            upsert: true,
          },
        })),
      );
    },

    async insertEvents(docs) {
      if (docs.length === 0) {
        return;
      }
      // Events are append-only and already filtered to the missing ids, so an
      // ordered insert would only stop the batch on a race. Keep going.
      await collection<ReadingEventDoc>(EVENTS).insertMany(docs, {
        ordered: false,
      });
    },

    async upsertAdapters(docs) {
      if (docs.length === 0) {
        return;
      }
      await collection<SiteAdapterDoc>(ADAPTERS).bulkWrite(
        docs.map((doc) => ({
          replaceOne: {
            filter: { _id: doc._id },
            replacement: doc,
            upsert: true,
          },
        })),
      );
    },

    async upsertCovers(docs) {
      if (docs.length === 0) {
        return;
      }
      // One at a time: each of these can be 5 MB, and a bulkWrite would build
      // the whole batch in memory before sending it.
      for (const doc of docs) {
        await collection<Keyed>(COVERS).replaceOne(
          { _id: doc._id },
          {
            _id: doc._id,
            data: new Binary(doc.data),
            contentType: doc.contentType,
            coverVersion: doc.coverVersion,
          },
          { upsert: true },
        );
      }
    },

    async deleteMangas(idList) {
      if (idList.length === 0) {
        return;
      }
      await collection<Keyed>(MANGAS).deleteMany({ _id: { $in: idList } });
    },

    async deleteEvents(idList) {
      if (idList.length === 0) {
        return;
      }
      await collection<Keyed>(EVENTS).deleteMany({ _id: { $in: idList } });
    },

    async deleteAdapters(domains) {
      if (domains.length === 0) {
        return;
      }
      await collection<Keyed>(ADAPTERS).deleteMany({ _id: { $in: domains } });
    },

    async deleteCovers(idList) {
      if (idList.length === 0) {
        return;
      }
      await collection<Keyed>(COVERS).deleteMany({ _id: { $in: idList } });
    },

    readMangas: async () =>
      asDocs(await collection<MangaDoc>(MANGAS).find({}).toArray()),
    readEvents: async () =>
      asDocs(await collection<ReadingEventDoc>(EVENTS).find({}).toArray()),
    readAdapters: async () =>
      asDocs(await collection<SiteAdapterDoc>(ADAPTERS).find({}).toArray()),
    readCover: async (mangaId) => {
      const doc = await collection<Keyed>(COVERS).findOne({ _id: mangaId });
      return doc === null ? null : (asDocs([doc])[0] ?? null);
    },
  };
}
