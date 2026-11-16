/**
 * The one line between the transcript and its checkpoint rail (VC-1211).
 *
 * The rail sits outside the transcript's scroller (outside its `role="log"`,
 * so a new mark is never read out as conversation) and the transcript owns
 * its own window of mounted rows, so neither can reach into the other. This
 * object is what they share, one per chat plane:
 *
 * - the transcript publishes which checkpoint the reader is in, and the rail
 *   subscribes to it through `useSyncExternalStore` — so a scroll that changes
 *   the answer re-renders the rail alone, never the transcript;
 * - the transcript attaches its jump, and the rail calls it.
 *
 * Nothing here measures or stores layout. Publishing the same id twice is a
 * no-op, so a caller may publish on every signal it gets without waking the rail.
 */
export interface CheckpointNavigator {
  /** The checkpoint the reader is in, or `null` before the transcript says. */
  current(): string | null;
  subscribe(listener: () => void): () => void;
  /** Called by the transcript whenever its answer may have changed. */
  publish(id: string | null): void;
  /** Called by the rail: take the transcript to the checkpoint `id`. */
  jump(id: string): void;
  /** The transcript's jump, until the returned detach runs. */
  attach(jump: (id: string) => void): () => void;
}

export function createCheckpointNavigator(): CheckpointNavigator {
  let current: string | null = null;
  let target: ((id: string) => void) | null = null;
  const listeners = new Set<() => void>();
  return {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(id) {
      if (id === current) return;
      current = id;
      for (const listener of listeners) listener();
    },
    jump(id) {
      target?.(id);
    },
    attach(jump) {
      target = jump;
      return () => {
        if (target === jump) target = null;
      };
    },
  };
}
