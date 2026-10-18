/**
 * The per-harness resume reference (VC-401): for each built-in harness, the
 * command line a native resume runs, what a fresh launch is, and the minimum
 * harness version the builder assumes. The docs site renders its "Terminal
 * resume" page from this (`apps/docs/src/lib/harness-resume.ts`), so the page
 * is the builder's output and cannot drift from it.
 *
 * The command cells are not transcribed from the adapters: they are what
 * {@link buildResumeCommand} itself returns, with a sentinel id swapped back to
 * a placeholder. Registered (user) harnesses are out of scope — they declare
 * their own resume argv, and the reference describes only what Volli ships.
 */
import { buildResumeCommand, shellSingleQuote } from "../harness-command";
import type { FirstClassHarnessId, HarnessId } from "../ticket";
import { harnessAdapters } from "./core";
import type { HarnessAdapter, HarnessSessionIdSource } from "./types";

/** What a by-id line shows where the harness's own session id goes. */
const ID_PLACEHOLDER = "<id>";

/** What a fresh-launch line shows where a Volli-minted session id goes. */
const MINTED_ID_PLACEHOLDER = "<uuid>";

/**
 * Handed to the builder in place of a real id. Shell-safe on purpose, so its
 * quoted form is one exact string to find and replace in the output.
 */
const SENTINEL_ID = "volli-resume-reference-id";
const QUOTED_SENTINEL_ID = shellSingleQuote(SENTINEL_ID);

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
  /** The resume line for a known session, `<id>` standing for it; `null` without by-id resume. */
  readonly byId: string | null;
  /** The resume line used when no session id is known; `null` without one. */
  readonly latest: string | null;
  /**
   * The harness argv a fresh (non-resume) launch carries for Volli: the session
   * flag and `<uuid>` when Volli mints the id, the bare command otherwise.
   */
  readonly freshLaunch: string;
  /** Where the id a later resume needs comes from. */
  readonly sessionIdSource: HarnessSessionIdSource["kind"];
  /** `null`: not pinned. */
  readonly minimumVersion: string | null;
}

/** The by-id line as the builder renders it, or `null` when it has none. */
function byIdLine(adapter: HarnessAdapter): string | null {
  const withId = buildResumeCommand(adapter, SENTINEL_ID, null);
  // Without a by-id template the builder falls through to the latest line, so
  // a line that never received the sentinel is not a by-id line.
  /* v8 ignore next -- every built-in declares a by-id resume; the pinned table test changes first if one stops. */
  if (withId === null || !withId.includes(QUOTED_SENTINEL_ID)) return null;
  return withId.replaceAll(QUOTED_SENTINEL_ID, ID_PLACEHOLDER);
}

/** One row per built-in harness, in registry order, from the builder's own output. */
export function harnessResumeReference(): HarnessResumeReference[] {
  return harnessAdapters.map((adapter) => {
    const { sessionId } = adapter;
    return {
      harnessId: adapter.id,
      label: adapter.label,
      byId: byIdLine(adapter),
      latest: buildResumeCommand(adapter, null, null),
      freshLaunch:
        sessionId.kind === "argv"
          ? `${adapter.command} ${sessionId.flag} ${MINTED_ID_PLACEHOLDER}`
          : adapter.command,
      sessionIdSource: sessionId.kind,
      // The registry holds the built-ins alone — the test pins its ids to
      // FIRST_CLASS_HARNESS_IDS — so its ids index this Record exactly.
      minimumVersion: RESUME_MINIMUM_VERSIONS[adapter.id as FirstClassHarnessId],
    };
  });
}
