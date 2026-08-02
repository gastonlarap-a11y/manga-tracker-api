// In-memory SyncTarget for tests: it makes push/restore semantics verifiable
// without a cluster, which matters because CI has none. It also counts calls,
// so "the second push moved nothing" is an assertion rather than a hope.
import type {
  CoverDoc,
  MangaDoc,
  ReadingEventDoc,
  SiteAdapterDoc,
} from "./sync.mapper";
import type { ReplicaDoc, SyncTarget } from "./sync.target";

export interface FakeTarget extends SyncTarget {
  readonly mangas: Map<string, MangaDoc>;
  readonly events: Map<string, ReadingEventDoc>;
  readonly adapters: Map<string, SiteAdapterDoc>;
  readonly covers: Map<string, CoverDoc>;
  readonly calls: { eventsInserted: number; coversUploaded: number };
}

export function createFakeTarget(): FakeTarget {
  const mangas = new Map<string, MangaDoc>();
  const events = new Map<string, ReadingEventDoc>();
  const adapters = new Map<string, SiteAdapterDoc>();
  const covers = new Map<string, CoverDoc>();
  const calls = { eventsInserted: 0, coversUploaded: 0 };

  const clone = (doc: object): ReplicaDoc =>
    JSON.parse(JSON.stringify(doc)) as ReplicaDoc;

  return {
    mangas,
    events,
    adapters,
    covers,
    calls,

    connect: async () => {},
    close: async () => {},

    readKeys: async () => ({
      mangaIds: new Set(mangas.keys()),
      eventIds: new Set(events.keys()),
      adapterDomains: new Set(adapters.keys()),
      coverVersions: new Map(
        [...covers.values()].map((doc) => [doc._id, doc.coverVersion]),
      ),
    }),

    upsertMangas: async (docs) => {
      for (const doc of docs) {
        mangas.set(doc._id, doc);
      }
    },

    insertEvents: async (docs) => {
      for (const doc of docs) {
        if (events.has(doc._id)) {
          // The service must never re-send an event it already pushed.
          throw new Error(`duplicate event insert: ${doc._id}`);
        }
        events.set(doc._id, doc);
      }
      calls.eventsInserted += docs.length;
    },

    upsertAdapters: async (docs) => {
      for (const doc of docs) {
        adapters.set(doc._id, doc);
      }
    },

    upsertCovers: async (docs) => {
      for (const doc of docs) {
        covers.set(doc._id, doc);
      }
      calls.coversUploaded += docs.length;
    },

    deleteMangas: async (ids) => {
      for (const id of ids) {
        mangas.delete(id);
      }
    },
    deleteEvents: async (ids) => {
      for (const id of ids) {
        events.delete(id);
      }
    },
    deleteAdapters: async (domains) => {
      for (const domain of domains) {
        adapters.delete(domain);
      }
    },
    deleteCovers: async (ids) => {
      for (const id of ids) {
        covers.delete(id);
      }
    },

    // Restore reads go through a clone so a test cannot accidentally assert on
    // the very objects the push wrote; dates survive as ISO strings, which is
    // also what a real driver hands back for anything it did not type as a Date.
    readMangas: async () => [...mangas.values()].map(clone),
    readEvents: async () => [...events.values()].map(clone),
    readAdapters: async () => [...adapters.values()].map(clone),
    readCover: async (mangaId) => {
      const doc = covers.get(mangaId);
      return doc === undefined
        ? null
        : {
            _id: doc._id,
            data: doc.data,
            contentType: doc.contentType,
            coverVersion: doc.coverVersion,
          };
    },
  };
}
