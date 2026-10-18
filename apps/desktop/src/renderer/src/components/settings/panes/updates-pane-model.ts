/**
 * What Settings → Updates says about the updater (VC-294): pure, so every word
 * is tested without the pane.
 *
 * The pane used to show "Check now", then "Checking…", then "Check now" again
 * — whatever the check found, the page looked the same afterwards, and a
 * failure lived only as long as a toast. This is the one line that stays: the
 * current phase while something is happening, and otherwise what the last
 * check that answered said and when, persisted by main across relaunches.
 */
import { compareVersions } from "@volli/shared";

import type { UpdateUiState } from "../../../../../ipc/contract";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { relativeTime } from "@renderer/lib/relative-time";

export interface UpdateStatus {
  readonly state: StatusDotState;
  /** The Health word, with the check's age when there is one: "Up to date · 3h ago". */
  readonly label: string;
  /** The failure's message, when the line is one. */
  readonly detail: string | null;
  /** The row's button. "Retry" after a failure — the same check, named for what it does. */
  readonly action: "Check now" | "Retry";
}

/** The Updates pane's status line for one updater snapshot, as of `now`. */
export function updateStatus(state: UpdateUiState, now: number): UpdateStatus {
  if (!state.supported) {
    return {
      state: "exited",
      label: "Off in development builds",
      detail: null,
      action: "Check now",
    };
  }
  const last = state.lastCheck;
  const aged = (word: string): string =>
    last === null ? word : `${word} · ${relativeTime(last.at, now)}`;
  /** A failure's word: the download's own, or the check's. */
  const failed = last?.result === "download-error" ? "Download failed" : "Check failed";
  switch (state.phase) {
    case "checking":
      return { state: "working", label: "Checking…", detail: null, action: "Check now" };
    case "downloading": {
      const what = state.targetVersion === null ? "update" : `Volli ${state.targetVersion}`;
      const percent = state.percent === null ? "" : ` · ${Math.round(state.percent)}%`;
      return {
        state: "working",
        label: `Downloading ${what}${percent}`,
        detail: null,
        action: "Check now",
      };
    }
    case "downloaded":
      return {
        state: "ready",
        label:
          state.targetVersion === null
            ? "Ready to restart"
            : `Volli ${state.targetVersion} ready to restart`,
        detail: null,
        action: "Check now",
      };
    case "error":
      return { state: "error", label: aged(failed), detail: state.error, action: "Retry" };
    case "idle":
      break;
  }
  // Idle: nothing is happening, so the line is the last answer — this run's,
  // or the one a previous run recorded.
  if (last === null) {
    return { state: "idle", label: "Not checked yet", detail: null, action: "Check now" };
  }
  switch (last.result) {
    case "error":
    case "download-error":
      return { state: "error", label: aged(failed), detail: last.error, action: "Retry" };
    case "available":
      // Found by an earlier run whose download never finished — unless the
      // running build is already that version or newer (installed since, or
      // by hand). Then the record is stale, but no check ever said "up to
      // date" either: say only when the last check was.
      if (last.version !== null && compareVersions(last.version, state.currentVersion) <= 0) {
        return {
          state: "idle",
          label: `Checked ${relativeTime(last.at, now)}`,
          detail: null,
          action: "Check now",
        };
      }
      return {
        state: "waiting",
        label: aged(last.version === null ? "Update available" : `Volli ${last.version} available`),
        detail: null,
        action: "Check now",
      };
    case "up-to-date":
      return { state: "ready", label: aged("Up to date"), detail: null, action: "Check now" };
  }
}
