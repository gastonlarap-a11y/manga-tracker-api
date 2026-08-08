// The only file in the repo that imports the mongodb driver. Everything above
// it talks to the SyncTarget interface, which is what lets the merge logic be
// tested with an in-memory fake and no cluster.
//
// There is deliberately no way to delete a manga, an event or an adapter. An
// earlier version deleted whatever was missing locally, which destroyed a peer's
// data the moment a stale machine recorded a chapter. Absence means "not synced
// yet", never "deleted" — deletion travels as Manga.deletedAt instead.
//
// Bun note: mongodb@7 cannot run here — its bson@7 calls `node:v8`
// isBuildingSnapshot at import time, which Bun does not implement. The 6.x line
// (bson 6.x) works, so the dependency is pinned to ^6.
import { Binary, type Collection, type Db, MongoClient } from "mongodb";
import type { MongoConfig } from "../../config";
import type {
  CoverDoc,
  DismissalDoc,
  MangaDoc,
  ReadingEventDoc,
  SiteAdapterDoc,
} from "./sync.mapper";

export type ReplicaDoc = Record<string, unknown>;

/** Every collection is keyed by a natural key (slug, domain, uuid). */
type Keyed = { _id: string };

type CoverVersionDoc = { _id: string; coverVersion: number };

export interface SyncTarget {
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Small enough to read whole; last-write-wins needs their timestamps. */
  readMangas(): Promise<ReplicaDoc[]>;
  readAdapters(): Promise<ReplicaDoc[]>;
  /** Rejected duplicate pairs; a set union, like events — never removed. */
  readDismissals(): Promise<ReplicaDoc[]>;
  /** Ids first, so only genuinely new events are transferred. */
  readEventIds(): Promise<Set<string>>;
  readEventDocs(ids: string[]): Promise<ReplicaDoc[]>;
  /** Versions without bytes, so covers can be diffed for free. */
  readCoverVersions(): Promise<Map<string, number>>;
  readCover(slug: string): Promise<ReplicaDoc | null>;
  upsertMangas(docs: MangaDoc[]): Promise<void>;
  insertEvents(docs: ReadingEventDoc[]): Promise<void>;
  upsertAdapters(docs: SiteAdapterDoc[]): Promise<void>;
  upsertDismissals(docs: DismissalDoc[]): Promise<void>;
  upsertCovers(docs: CoverDoc[]): Promise<void>;
  /**
   * Driven by a manga whose merged state says it has no stored bytes — a
   * value, never an absence. This is the one removal the design allows.
   */
  deleteCovers(slugs: string[]): Promise<void>;
}

const MANGAS = "mangas";
const EVENTS = "readingEvents";
const ADAPTERS = "siteAdapters";
const COVERS = "covers";
const DISMISSALS = "duplicateDismissals";

// Chunk id lookups so a growing history never builds an unbounded $in.
const ID_BATCH = 500;

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
  // signature (its `Document`). Our documents are closed shapes keyed by
  // natural keys, so the cast buys back precise filter types instead of losing
  // them.
  const collection = <T extends Keyed>(name: string): Collection<T> =>
    database().collection(name) as unknown as Collection<T>;

  // Reads feed the defensive `from*Doc` mappers, which validate every field,
  // so widening to an untyped record is safe here.
  const asDocs = (docs: object[]): ReplicaDoc[] => docs as ReplicaDoc[];

  return {
    async connect() {
      await client.connect();
      db = client.db(config.db);
      // Mangas are keyed by normalizedSlug, so _id already enforces the
      // uniqueness SQLite gets from its unique index — no extra index needed.
      await collection<ReadingEventDoc>(EVENTS).createIndex({
        mangaSlug: 1,
        readAt: -1,
      });
    },

    async close() {
      await client.close();
      db = null;
    },

    readMangas: async () =>
      asDocs(await collection<MangaDoc>(MANGAS).find({}).toArray()),

    readAdapters: async () =>
      asDocs(await collection<SiteAdapterDoc>(ADAPTERS).find({}).toArray()),

    readDismissals: async () =>
      asDocs(await collection<DismissalDoc>(DISMISSALS).find({}).toArray()),

    async readEventIds() {
      const docs = await collection<Keyed>(EVENTS)
        .find({}, { projection: { _id: 1 } })
        .toArray();
      return new Set(docs.map((doc) => doc._id));
    },

    async readEventDocs(ids) {
      const found: ReplicaDoc[] = [];
      for (let i = 0; i < ids.length; i += ID_BATCH) {
        const batch = ids.slice(i, i + ID_BATCH);
        const docs = await collection<ReadingEventDoc>(EVENTS)
          .find({ _id: { $in: batch } })
          .toArray();
        found.push(...asDocs(docs));
      }
      return found;
    },

    async readCoverVersions() {
      const docs = await collection<CoverVersionDoc>(COVERS)
        // Never project `data`: the point is diffing covers without pulling
        // megabytes across the wire.
        .find({}, { projection: { _id: 1, coverVersion: 1 } })
        .toArray();
      return new Map(
        docs.map((doc) => [
          doc._id,
          // A document written without a version can never match, so it is
          // re-pushed rather than silently skipped.
          typeof doc.coverVersion === "number" ? doc.coverVersion : -1,
        ]),
      );
    },

    async readCover(slug) {
      const doc = await collection<Keyed>(COVERS).findOne({ _id: slug });
      return doc === null ? null : (asDocs([doc])[0] ?? null);
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
      // Already filtered to the ids the replica lacks, so an ordered insert
      // would only stop the batch when two machines push the same event at
      // once. Keep going and let the duplicate lose.
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

    async upsertDismissals(docs) {
      if (docs.length === 0) {
        return;
      }
      await collection<DismissalDoc>(DISMISSALS).bulkWrite(
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
      // One at a time: each can be 5 MB, and a bulkWrite would build the whole
      // batch in memory before sending it.
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

    async deleteCovers(slugs) {
      if (slugs.length === 0) {
        return;
      }
      await collection<Keyed>(COVERS).deleteMany({ _id: { $in: slugs } });
    },
  };
}
