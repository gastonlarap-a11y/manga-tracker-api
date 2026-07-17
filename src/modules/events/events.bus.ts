// In-process notification bus: anything that changes the library projection
// publishes here, and the SSE stream (GET /api/events/stream) forwards it to
// connected dashboards. Sibling slices (library) may import this bus — it is
// the one sanctioned cross-slice dependency.

type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeLibraryChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishLibraryChanged(): void {
  for (const listener of listeners) {
    listener();
  }
}
