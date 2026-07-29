import { HARNESS_LABELS } from "../ticket";
import type { HarnessAdapter } from "./types";

/**
 * Cursor's CLI ships as `cursor-agent`, not `cursor` (that name belongs to the
 * editor's shell command). `CURSOR_CONFIG_DIR` redirects `cli-config.json`
 * without touching authentication, which is hardcoded to `~/.cursor/auth.json`
 * — so pointing it at a Volli-owned directory layers rather than replaces.
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
  detection: { executable: "cursor-agent" },
  surfaces: {
    skillsDir: "{home}/.cursor/skills",
    // `~/.cursor/commands` does not exist for the CLI.
    commandsDir: null,
    instructionsFile: "{home}/AGENTS.md",
  },
  injection: { kind: "config-dir-env", envVar: "CURSOR_CONFIG_DIR", filename: "cli-config.json" },
  // `--new-session-id` exists but is hidden (`.hideHelp()`).
  sessionId: { kind: "argv", flag: "--new-session-id", format: "uuid" },
  resume: {
    byId: ["--resume", "{id}"],
    latest: ["--continue"],
    userResumeTokens: ["--resume", "--continue"],
  },
  events: [
    { event: "session.started", native: "sessionStart", delivery: "async", timeoutMs: 5000 },
    { event: "session.ended", native: "sessionEnd", delivery: "async", timeoutMs: 5000 },
    { event: "turn.started", native: "beforeSubmitPrompt", delivery: "async", timeoutMs: 5000 },
    { event: "turn.completed", native: "stop", delivery: "async", timeoutMs: 5000 },
    { event: "tool.started", native: "preToolUse", delivery: "async", timeoutMs: 5000 },
  ],
  launchSettings: [],
  // Empty until a marker is observed on a real cursor-agent session — a guessed
  // name is a variable deleted from the user's environment for no reason.
  sessionMarkers: [],
};
