import { HARNESS_LABELS } from "../ticket";
import type { HarnessAdapter } from "./types";

/**
 * Cursor's CLI ships as `cursor-agent`, not `cursor` (that name belongs to the
 * editor's shell command).
 *
 * Hooks do NOT come from `CURSOR_CONFIG_DIR`. That variable redirects
 * `cli-config.json` and the chat store, and Volli used to write its hooks
 * there; `cursor-agent` loads hooks from a separate fixed ladder that consults
 * no environment variable at all, so none of them could ever fire. Read out of
 * the installed bundle, the rungs are: an OS-level enterprise file,
 * `~/.cursor/hooks.json`, `<cwd>/.cursor/hooks.json`, a team file under
 * `~/.cursor/managed` (home, despite the shape of its path), and the
 * Claude-compatibility `settings.json` files in `~/.claude` and `<cwd>/.claude`.
 * Only the `<cwd>` project rung is per-ticket isolatable, because a ticket's
 * working directory is a worktree Volli made — hence `cursor-hooks-file`.
 *
 * `sessionStart` fires on a FRESH session only; `--resume` and `--continue`
 * skip it. So a resumed cursor session proves itself alive at its first turn
 * rather than at launch.
 *
 * It declares no `input.needed` and no `permission.requested`, and that is
 * confirmed rather than merely undocumented: its Claude-Code-compatibility
 * event map sends both `Notification` and `PermissionRequest` to `null`. It
 * ships deliberately degraded and says so, so Volli claims neither.
 */
export const cursorAdapter: HarnessAdapter = {
  id: "cursor",
  label: HARNESS_LABELS.cursor,
  command: "cursor-agent",
  promptFlag: null,
  surfaces: {
    skillsDir: "{home}/.cursor/skills",
    // `~/.cursor/commands` does not exist for the CLI.
    commandsDir: null,
    instructionsFile: "{home}/AGENTS.md",
  },
  injection: { kind: "cursor-hooks-file" },
  // `--new-session-id` exists but is hidden (`.hideHelp()`).
  sessionId: { kind: "argv", flag: "--new-session-id", format: "uuid" },
  resume: {
    byId: ["--resume", "{id}"],
    latest: ["--continue"],
    userResumeTokens: ["--resume", "--continue"],
  },
  events: [
    { event: "session.started", native: "sessionStart", delivery: "async" },
    { event: "session.ended", native: "sessionEnd", delivery: "async" },
    { event: "turn.started", native: "beforeSubmitPrompt", delivery: "async" },
    { event: "turn.completed", native: "stop", delivery: "async" },
    { event: "tool.started", native: "preToolUse", delivery: "async" },
  ],
  // Live run, cursor-agent 2026.07.23: `sessionStart` fires at boot from
  // `<cwd>/.cursor/hooks.json`, which is the rung `cursor-hooks-file` writes —
  // the first confirmation that the hooks Volli writes for cursor are reachable
  // at all. A RESUMED session skips it (see above), so the window this anchors
  // is a fresh launch's.
  startupEvent: "session.started",
  launchSettings: [],
  // Empty until a marker is observed on a real cursor-agent session — a guessed
  // name is a variable deleted from the user's environment for no reason.
  sessionMarkers: [],
};
