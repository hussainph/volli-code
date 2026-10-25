import type { SessionEvent } from "@volli/shared";
import type { SessionEngine } from "../session-engine";
import type { SubscribeCommittedSessionEvents } from "../session-runtime";

/** An Engine that announces what it commits, and the door to listen. */
export interface CommittedSessionStream {
  /** The Engine every writer must use: the one handed in, plus the announcement. */
  engine: SessionEngine;
  committed: SubscribeCommittedSessionEvents;
  /** The live listener set, so a test can see who is still subscribed. */
  listeners: ReadonlySet<(event: SessionEvent) => void>;
}

/**
 * The host's post-commit wake bus in miniature (host-core's `session-wake.ts`):
 * wraps an Engine so every write, once it settles, announces each event it
 * appended — including the ones `submit` appends and does not return — to
 * every listener, in ledger order, before the write's promise settles. Both are
 * held to `describeCommittedSessionStreamContract`.
 *
 * Reads back per Session from the Engine rather than from a global sequence,
 * so it starts announcing a Session from its first event.
 */
export function createCommittedSessionStream(base: SessionEngine): CommittedSessionStream {
  const listeners = new Set<(event: SessionEvent) => void>();
  const announced = new Map<string, number>();
  async function announce(sessionId: string): Promise<void> {
    let events: readonly SessionEvent[];
    try {
      events = await base.listEvents({ sessionId, afterSequence: announced.get(sessionId) ?? 0 });
    } catch {
      // As the real bus does: a read-back that failed must not fail the write
      // it followed, and the next write's announce picks these events up.
      return;
    }
    // Two writes can overlap at the read's await, and both reads can return the
    // same events. The mark is re-read after the await, so whichever settles
    // second announces only what the first did not: exactly once, as the bus.
    const fresh = events.filter(({ sequence }) => sequence > (announced.get(sessionId) ?? 0));
    if (fresh.length === 0) return;
    announced.set(sessionId, fresh[fresh.length - 1]!.sequence);
    for (const event of fresh) {
      // A snapshot, as the real bus takes: a listener may unsubscribe on the event.
      const settled = [...listeners];
      for (const listener of settled) listener(event);
    }
  }
  const engine: SessionEngine = {
    ...base,
    createSession: async (request) => {
      const result = await base.createSession(request);
      await announce(result.session.id);
      return result;
    },
    getOrRecordSessionInput: async (request) => {
      const result = await base.getOrRecordSessionInput(request);
      await announce(request.sessionId);
      return result;
    },
    recordToolRefresh: async (request) => {
      const result = await base.recordToolRefresh(request);
      await announce(request.sessionId);
      return result;
    },
    observe: async (observation) => {
      const result = await base.observe(observation);
      await announce(result.sessionId);
      return result;
    },
    submit: async (request) => {
      const result = await base.submit(request);
      await announce(request.sessionId);
      return result;
    },
    completeModelSelection: async (request) => {
      const result = await base.completeModelSelection(request);
      await announce(request.sessionId);
      return result;
    },
  };
  const committed: SubscribeCommittedSessionEvents = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { engine, committed, listeners };
}
