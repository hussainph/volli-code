/**
 * The per-harness resume reference (VC-401): for each built-in harness, the
 * command line a native resume runs, what a fresh launch is, and the minimum
 * harness version the builder assumes. The docs site renders its "Terminal
 * resume" page from this, so the page is the builder's output and cannot drift
 * from it.
 *
 * The command cells are not transcribed from the adapters: they are what
 * {@link buildResumeCommand} itself returns, with a sentinel id swapped back to
 * a placeholder. Registered (user) harnesses are out of scope — they declare
 * their own resume argv, and the reference describes only what Volli ships.
 */
import { buildResumeCommand, shellSingleQuote } from "../harness-command";
import { isFirstClassHarnessId, type FirstClassHarnessId, type HarnessId } from "../ticket";
import type { HarnessAdapter, HarnessSessionIdSource } from "./types";

/** What a by-id cell shows where the harness's own session id goes. */
export const RESUME_REFERENCE_ID_PLACEHOLDER = "<id>";

/** What a fresh-launch cell shows where a Volli-minted session id goes. */
export const RESUME_REFERENCE_MINTED_ID_PLACEHOLDER = "<uuid>";

/**
 * Handed to the builder in place of a real id. Shell-safe on purpose, so its
 * quoted form is one exact string to find and replace in the output.
 */
const SENTINEL_ID = "volli-resume-reference-id";

/**
 * The lowest harness version each built-in's resume line is known to need,
 * `null` meaning the builder assumes none — no version is checked before a
 * resume runs, and none is guessed here. A Record so a new built-in id fails
 * to compile until someone decides its entry.
 */
const RESUME_MINIMUM_VERSIONS: Record<FirstClassHarnessId, string | null> = {
  "claude-code": null,
  codex: null,
  cursor: null,
  opencode: null,
};

export interface HarnessResumeReference {
  readonly harnessId: HarnessId;
  readonly label: string;
  /** The resume line for a known session, with {@link RESUME_REFERENCE_ID_PLACEHOLDER}; `null` without by-id resume. */
  readonly byId: string | null;
  /** The resume line used when no session id is known; `null` without one. */
  readonly latest: string | null;
  /**
   * The harness argv a fresh (non-resume) launch carries for Volli: the session
   * flag and {@link RESUME_REFERENCE_MINTED_ID_PLACEHOLDER} when Volli mints the
   * id, the bare command otherwise.
   */
  readonly freshLaunch: string;
  /** Where the id a later resume needs comes from. */
  readonly sessionIdSource: HarnessSessionIdSource["kind"];
  /** `null`: not pinned. */
  readonly minimumVersion: string | null;
}

/** One adapter's row, from the builder's own output. */
export function describeHarnessResume(
  adapter: HarnessAdapter,
  minimumVersion: string | null,
): HarnessResumeReference {
  const quotedSentinel = shellSingleQuote(SENTINEL_ID);
  // Without a by-id template the builder falls through to `latest`, so a line
  // that never received the sentinel is not a by-id line.
  const withId = buildResumeCommand(adapter, SENTINEL_ID, null);
  const byId =
    withId?.includes(quotedSentinel) === true
      ? withId.replaceAll(quotedSentinel, RESUME_REFERENCE_ID_PLACEHOLDER)
      : null;
  const { sessionId } = adapter;
  return {
    harnessId: adapter.id,
    label: adapter.label,
    byId,
    latest: buildResumeCommand(adapter, null, null),
    freshLaunch:
      sessionId.kind === "argv"
        ? `${adapter.command} ${sessionId.flag} ${RESUME_REFERENCE_MINTED_ID_PLACEHOLDER}`
        : adapter.command,
    sessionIdSource: sessionId.kind,
    minimumVersion,
  };
}

/**
 * The reference rows for `adapters`, which must all be built-ins — pass
 * `harnessAdapters`. Throws on any other id rather than inventing a row for a
 * harness Volli does not ship.
 */
export function harnessResumeReference(
  adapters: readonly HarnessAdapter[],
): HarnessResumeReference[] {
  return adapters.map((adapter) => {
    if (!isFirstClassHarnessId(adapter.id)) {
      throw new Error(`The resume reference covers built-in harnesses only, not ${adapter.id}`);
    }
    return describeHarnessResume(adapter, RESUME_MINIMUM_VERSIONS[adapter.id]);
  });
}
