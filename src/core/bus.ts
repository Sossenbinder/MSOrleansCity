// Typed one-way event bus.
//
// This is half of structural rule #2 (outline: Approach). sim/ emits discrete
// SimEvents; world/ and ui/ consume them. Events travel one way only — nothing
// a listener does can reach back into simulation state, because listeners
// receive plain data and the bus exposes no mutation path.
//
// Two consumption styles are supported deliberately:
//   - on(...)   live subscription, for UI that reacts immediately
//   - drain()   frame-batched, for the renderer, which wants every event that
//               happened since the last frame in order and nothing more

export type Listener<E> = (event: E) => void;

export interface Bus<E> {
  emit(event: E): void;
  on(listener: Listener<E>): () => void;
  /** Returns every event buffered since the last drain, in emission order. */
  drain(): E[];
  /** Discards buffered events without dispatching. Used when resetting. */
  clear(): void;
}

export function createBus<E>(): Bus<E> {
  const listeners = new Set<Listener<E>>();
  let buffer: E[] = [];

  return {
    emit(event) {
      buffer.push(event);
      for (const listener of listeners) listener(event);
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    drain() {
      const drained = buffer;
      buffer = [];
      return drained;
    },
    clear() {
      buffer = [];
    },
  };
}
