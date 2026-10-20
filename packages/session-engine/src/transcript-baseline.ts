/**
 * The plan and reply baseline of a Session whose transcript predates digests
 * (VC-315).
 *
 * A bounded open answers "the plan as it stands" and "what `/copy` copies"
 * from the projection, which folds them from each transcript fact's
 * {@link SessionTranscriptDigest}. Facts written before digests existed carry
 * none, so for a Session that already had history on upgrade the projection
 * cannot say — and the window, which holds only the newest frames, usually
 * cannot either.
 *
 * This recovers both from the history itself, newest first, stopping at the
 * first answer for each:
 *
 * - **The plan** is the newest transcript message whose last settled plan call
 *   left a list (`[]` included: a cleared list is an answer).
 * - **The reply** is the newest assistant message that said something, unless
 *   a user message — a submit, a steer, an interaction answer, or a user
 *   transcript message — comes first, which means the current turn has not
 *   spoken yet.
 *
 * A fact with a digest is read from its digest. A fact without one is read
 * from its body: from the window's frames when it is in them, otherwise from
 * the artifact store, a pool of reads at a time, so the scan reads at most one
 * pool past the answer. Events are read in indexed backward ranges; nothing
 * above the answer is touched. The worst case — no plan was ever written — is
 * every legacy body once: what opening the Session cost before the window, and
 * the host caches the result so it is paid once.
 *
 * Best effort: a body that cannot be read is skipped and reported, never a
 * failed open. The worst outcome is no baseline, which is what a projection
 * without one already shows.
 */
import type {
  SessionEvent,
  SessionProjection,
  SessionReplyLocation,
  SessionTodoList,
  SessionTranscriptDigest,
  TranscriptReference,
} from "@volli/shared";

import type { SessionTranscriptArtifact } from "./transcript-artifacts";
import { transcriptDigest } from "./transcript-digest";

/** How many events one backward range read asks the ledger for. */
export const BASELINE_SCAN_CHUNK = 256;

export interface BaselineRecoveryPorts {
  /** The events with `afterSequence < sequence < before`, oldest first: one indexed range read. */
  range(afterSequence: number, before: number): Promise<readonly SessionEvent[]>;
  read(reference: TranscriptReference): Promise<SessionTranscriptArtifact>;
  /** Bodies already in hand (the open's window), by sequence. Never read again. */
  held: ReadonlyMap<number, SessionTranscriptArtifact>;
  /** How many bodies may be in flight at once. */
  concurrency: number;
  /** A body that could not be read. The scan goes on without it. */
  onSkipped(sequence: number, error: unknown): void | Promise<void>;
}

export interface RecoveredBaseline {
  /** The plan as it stands; absent when no message ever left one. */
  todoList?: SessionTodoList;
  /** The current turn's latest reply; absent when it has not spoken. */
  latestReply?: SessionReplyLocation;
  /** The bodies this recovery read from the store, by sequence, for the caller to reuse. */
  read: ReadonlyMap<number, SessionTranscriptArtifact>;
}

/**
 * Recovers what `projection` cannot say about the plan and the reply from the
 * events at or below `throughSequence`. A baseline the projection already
 * holds is kept as it is and not looked for.
 */
export async function recoverTranscriptBaseline(
  projection: Pick<SessionProjection, "todoList" | "latestReply">,
  throughSequence: number,
  ports: BaselineRecoveryPorts,
): Promise<RecoveredBaseline> {
  const read = new Map<number, SessionTranscriptArtifact>();
  const unreadable = new Set<number>();
  let todoList = projection.todoList;
  let latestReply = projection.latestReply;
  let planDone = todoList !== undefined;
  let replyDone = latestReply !== undefined;

  const legacy = (event: SessionEvent): TranscriptReference | null =>
    event.payload.kind === "transcript.referenced" &&
    event.payload.digest === undefined &&
    !ports.held.has(event.sequence)
      ? event.payload.reference
      : null;

  /** The next pool of legacy bodies from `from` on, newest first, read together. */
  const prefetch = async (newestFirst: readonly SessionEvent[], from: number): Promise<void> => {
    const batch: { sequence: number; reference: TranscriptReference }[] = [];
    for (
      let index = from;
      index < newestFirst.length && batch.length < ports.concurrency;
      index++
    ) {
      const event = newestFirst[index]!;
      const reference = legacy(event);
      if (reference !== null && !read.has(event.sequence) && !unreadable.has(event.sequence)) {
        batch.push({ sequence: event.sequence, reference });
      }
    }
    await Promise.all(
      batch.map(async ({ sequence, reference }) => {
        try {
          read.set(sequence, await ports.read(reference));
        } catch (error) {
          unreadable.add(sequence);
          try {
            await ports.onSkipped(sequence, error);
          } catch {
            // Reporting a skipped body must not fail the scan it reports on.
          }
        }
      }),
    );
  };

  const digestOf = (
    sequence: number,
    payload: Extract<SessionEvent["payload"], { kind: "transcript.referenced" }>,
  ): SessionTranscriptDigest | null => {
    if (payload.digest !== undefined) return payload.digest;
    const body = ports.held.get(sequence) ?? read.get(sequence);
    if (body === undefined) return null;
    try {
      return transcriptDigest(body.message);
    } catch (error) {
      // A body that decoded but is not a message is as unreadable as one that
      // did not decode.
      try {
        void Promise.resolve(ports.onSkipped(sequence, error)).catch(() => undefined);
      } catch {
        // As in `prefetch`: a reporter that fails changes nothing here.
      }
      return null;
    }
  };

  let before = throughSequence + 1;
  while (!(planDone && replyDone) && before > 1) {
    const afterSequence = Math.max(0, before - 1 - BASELINE_SCAN_CHUNK);
    const newestFirst = (await ports.range(afterSequence, before))
      .filter(({ sequence }) => sequence > afterSequence && sequence < before)
      .toSorted((left, right) => right.sequence - left.sequence);
    for (let index = 0; index < newestFirst.length && !(planDone && replyDone); index++) {
      const event = newestFirst[index]!;
      const reference = legacy(event);
      if (reference !== null && !read.has(event.sequence) && !unreadable.has(event.sequence)) {
        await prefetch(newestFirst, index);
      }
      const { payload } = event;
      if (payload.kind === "command.recorded") {
        const intent = payload.command.intent.kind;
        // The same resets the projection folds: a user message opens a turn.
        if (intent === "message.submit" || intent === "interaction.resolve") replyDone = true;
        continue;
      }
      if (payload.kind !== "transcript.referenced") continue;
      const digest = digestOf(event.sequence, payload);
      if (digest === null) continue;
      if (!planDone && digest.todoList !== undefined) {
        todoList = digest.todoList;
        planDone = true;
      }
      if (!replyDone) {
        if (digest.role === "user") replyDone = true;
        else if (digest.role === "assistant" && digest.reply === true) {
          latestReply = { sequence: event.sequence, reference: payload.reference };
          replyDone = true;
        }
      }
    }
    before = afterSequence + 1;
  }
  return {
    ...(todoList === undefined ? {} : { todoList }),
    ...(latestReply === undefined ? {} : { latestReply }),
    read,
  };
}
