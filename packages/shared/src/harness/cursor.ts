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
 *
 * Everything it DOES bind was then confirmed against a live TUI, and the mode
 * matters: `cursor-agent -p` is headless and fires only `sessionStart` and
 * `sessionEnd`, which reads as four dead bindings and is an artefact of the
 * mode. In the interactive TUI — the one Volli launches — a fresh session and
 * one prompt produced `sessionStart` at boot, then `beforeSubmitPrompt`,
 * `preToolUse` and `stop`. Cursor reports everything it claims.
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
    // `~/AGENTS.md` is a user-owned global rules file — Volli claims no
    // instructions file here. The skills symlink carries session context when
    // `VOLLI_TICKET` / `VOLLI_SESSION` are present.
    instructionsFile: null,
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
  // Live TUI run, cursor-agent 2026.07.23: `sessionStart` fires at boot, before
  // any input, from `<cwd>/.cursor/hooks.json` — the rung `cursor-hooks-file`
  // writes, and the first confirmation that the hooks Volli writes for cursor
  // are reachable at all. A RESUMED session skips it (see above), so the window
  // this anchors is a fresh launch's.
  startupEvent: "session.started",
  launchSettings: [],
  // Empty until a marker is observed on a real cursor-agent session — a guessed
  // name is a variable deleted from the user's environment for no reason.
  sessionMarkers: [],
};
