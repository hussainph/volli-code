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
  /** What listeners threw, in order: reported here, never to the write. */
  listenerErrors: readonly unknown[];
}

/**
 * The host's post-commit wake bus in miniature (host-core's `session-wake.ts`):
 * wraps an Engine so every write, once it settles — resolved or rejected —
 * announces each event it appended, including the ones `submit` appends and
 * does not return, to every listener, in ledger order, before the write's
 * promise settles. Both are held to `describeCommittedSessionStreamContract`.
 *
 * Reads back per Session from the Engine rather than from a global sequence,
 * so it starts announcing a Session from its first event.
 */
export function createCommittedSessionStream(base: SessionEngine): CommittedSessionStream {
  const listeners = new Set<(event: SessionEvent) => void>();
  const listenerErrors: unknown[] = [];
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
      for (const listener of settled) {
        // As the bus does: a listener's failure cannot unwind a committed write.
        try {
          listener(event);
        } catch (error) {
          listenerErrors.push(error);
        }
      }
    }
  }
  /** Announce after the write settles, whether it resolved or threw: a write can commit and still reject. */
  async function afterCommit<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } finally {
      await announce(sessionId);
    }
  }
  // Every method listed, as the bus lists them: a new Engine write is then a
  // compile error here rather than a write that commits unannounced.
  const engine: SessionEngine = {
    // One transaction: a create that rejects committed nothing to announce.
    createSession: async (request) => {
      const result = await base.createSession(request);
      await announce(result.session.id);
      return result;
    },
    getOrRecordSessionInput: (request) =>
      afterCommit(request.sessionId, () => base.getOrRecordSessionInput(request)),
    recordToolRefresh: (request) =>
      afterCommit(request.sessionId, () => base.recordToolRefresh(request)),
    observe: (observation) => afterCommit(observation.sessionId, () => base.observe(observation)),
    submit: (request) => afterCommit(request.sessionId, () => base.submit(request)),
    completeModelSelection: (request) =>
      afterCommit(request.sessionId, () => base.completeModelSelection(request)),
    getSession: (query) => base.getSession(query),
    getBaseSession: (query) => base.getBaseSession(query),
    listSessions: (query) => base.listSessions(query),
    countSessions: (query) => base.countSessions(query),
    listAttachedSessions: () => base.listAttachedSessions(),
    listSessionStarts: (query) => base.listSessionStarts(query),
    listLatestTicketSignals: (query) => base.listLatestTicketSignals(query),
    listEvents: (query) => base.listEvents(query),
    latestEventSequence: (query) => base.latestEventSequence(query),
    getProjectionCheckpoint: (query) => base.getProjectionCheckpoint(query),
    saveProjectionCheckpoint: (checkpoint) => base.saveProjectionCheckpoint(checkpoint),
    reportUsage: (query) => base.reportUsage(query),
  };
  const committed: SubscribeCommittedSessionEvents = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { engine, committed, listeners, listenerErrors };
}
