import {
  harnessAdapters,
  harnessResumeReference,
  type HarnessResumeReference,
} from "@volli/shared";

/** The built-in TUIs' resume rows, rendered by the builder itself (VC-401). */
export const resumeRows: readonly HarnessResumeReference[] = harnessResumeReference(harnessAdapters);

/** Where a fresh launch's session id comes from — the part of "fresh" that decides how a later resume finds it. */
export const SESSION_ID_SOURCE_NOTES: Record<HarnessResumeReference["sessionIdSource"], string> = {
  argv: "Volli mints the session id.",
  reported: "The TUI reports its session id on its events.",
  none: "Volli learns the session id from the TUI's hooks or a manual link.",
};

/** What a cell with no command or no pinned version reads as. */
export const NO_COMMAND = "Not supported";
export const NOT_PINNED = "Not pinned";
