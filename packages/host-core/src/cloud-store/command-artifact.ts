/** One body hydration path for ordinary commands and follow-up controls. */
import type { SessionTranscriptArtifact, TranscriptArtifactStore } from "@volli/session-engine";
import type { TranscriptReference } from "@volli/shared";
import type { JobOutcome } from "@volli/shared/cloud";

/**
 * Reads a staged message body from the backend for a Session this runner
 * holds: `transcripts.commandArtifact({ sessionId, generation, digest })`
 * with this runner's token and claim generation, answering its `body`, or
 * `null` when the backend has none staged. A transport failure throws (the
 * job retries).
 */
export type CommandArtifactSource = (input: {
  sessionId: string;
  digest: string;
}) => Promise<string | null>;

const failed = (code: string, detail: string): JobOutcome => ({
  status: "failed",
  code,
  detail,
  retryable: false,
});

type Hydrated = { artifact: SessionTranscriptArtifact } | { outcome: JobOutcome };

/**
 * The backend's typed refusals of a body read (`transcripts.commandArtifact`),
 * each with a fixed, path-free sentence of its own: the backend's message is
 * never journaled. Final: no runner holds the Session, or the reference names
 * no staged body. A claim that moved on is retried: a claim handed to this
 * runner is read under its new generation once the drain has learnt it, and
 * the job follows the claim otherwise.
 */
const BODY_REFUSALS: Readonly<Record<string, { detail: string; retryable: boolean }>> = {
  not_claimed: { detail: "No runner holds this Session's claim.", retryable: false },
  invalid_argument: {
    detail: "This command's message reference names no staged body.",
    retryable: false,
  },
  revoked: { detail: "This runner was removed from its account.", retryable: false },
  not_a_runner: { detail: "This connection is not a runner.", retryable: false },
  stale_claim: {
    detail: "This runner does not hold the Session's current claim.",
    retryable: true,
  },
};

function refusalOf(error: unknown): JobOutcome | null {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  if (typeof code !== "string" || !Object.hasOwn(BODY_REFUSALS, code)) return null;
  const { detail, retryable } = BODY_REFUSALS[code]!;
  return { status: "failed", code, detail, retryable };
}

/**
 * The referenced body: from this runner's store, else staged by the backend
 * and written here first. One check for every staged body, a person's or an
 * agent's: the store's own codec
 * re-derives the reference from the canonical bytes it verified, and only a
 * body whose reference is the command's is delivered.
 */
export async function readMessageBody(
  artifacts: TranscriptArtifactStore,
  source: CommandArtifactSource | undefined,
  sessionId: string,
  reference: TranscriptReference,
): Promise<Hydrated> {
  try {
    return { artifact: await artifacts.read(reference) };
  } catch (error) {
    const digest = reference.digest;
    if (source === undefined || digest === null) throw error;
    let body: string | null;
    try {
      body = await source({ sessionId, digest });
    } catch (refusal) {
      // Anything else (offline, a timeout, an expired token) throws: the inbox retries.
      const outcome = refusalOf(refusal);
      if (outcome === null) throw refusal;
      return { outcome };
    }
    // Nothing staged: the local failure is the one to report.
    if (body === null) throw error;
    let parsed: SessionTranscriptArtifact;
    try {
      parsed = JSON.parse(body) as SessionTranscriptArtifact;
    } catch {
      return { outcome: failed("invalid_artifact", "The staged message body is unreadable.") };
    }
    // A store write that fails (its disk, or a shape it refuses) throws: retried, then dead-lettered.
    const written = await artifacts.write(parsed);
    if (written.id !== reference.id || written.digest !== reference.digest) {
      return {
        outcome: failed(
          "artifact_mismatch",
          "The staged message body does not match its reference.",
        ),
      };
    }
    return { artifact: await artifacts.read(reference) };
  }
}
