// In-memory SyncTarget for tests: it makes merge semantics verifiable without a
// cluster, which matters because CI has none. It doubles as the stand-in for
// "the other machine" — a test writes documents into it directly to simulate
// what a peer pushed, then syncs and asserts what this machine did with them.
import type {
  CoverDoc,
  DismissalDoc,
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
  readonly dismissals: Map<string, DismissalDoc>;
  readonly calls: { eventsInserted: number; coversUploaded: number };
}

export function createFakeTarget(): FakeTarget {
  const mangas = new Map<string, MangaDoc>();
  const events = new Map<string, ReadingEventDoc>();
  const adapters = new Map<string, SiteAdapterDoc>();
  const covers = new Map<string, CoverDoc>();
  const dismissals = new Map<string, DismissalDoc>();
  const calls = { eventsInserted: 0, coversUploaded: 0 };

  // Reads go through a clone so a test cannot accidentally assert on the very
  // objects a push wrote; dates survive as ISO strings, which is also what a
  // real driver hands back for anything it did not type as a Date.
  const clone = (doc: object): ReplicaDoc =>
    JSON.parse(JSON.stringify(doc)) as ReplicaDoc;

  return {
    mangas,
    events,
    adapters,
    covers,
    dismissals,
    calls,

    connect: async () => {},
    close: async () => {},

    readMangas: async () => [...mangas.values()].map(clone),
    readAdapters: async () => [...adapters.values()].map(clone),
    readDismissals: async () => [...dismissals.values()].map(clone),
    readEventIds: async () => new Set(events.keys()),
    readEventDocs: async (ids) =>
      ids
        .map((id) => events.get(id))
        .filter((doc): doc is ReadingEventDoc => doc !== undefined)
        .map(clone),
    readCoverVersions: async () =>
      new Map([...covers.values()].map((doc) => [doc._id, doc.coverVersion])),
    readCover: async (slug) => {
      const doc = covers.get(slug);
      return doc === undefined
        ? null
        : {
            _id: doc._id,
            data: doc.data,
            contentType: doc.contentType,
            coverVersion: doc.coverVersion,
          };
    },

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

    upsertDismissals: async (docs) => {
      for (const doc of docs) {
        dismissals.set(doc._id, doc);
      }
    },

    upsertCovers: async (docs) => {
      for (const doc of docs) {
        covers.set(doc._id, doc);
      }
      calls.coversUploaded += docs.length;
    },

    deleteCovers: async (slugs) => {
      for (const slug of slugs) {
        covers.delete(slug);
      }
    },
  };
}
