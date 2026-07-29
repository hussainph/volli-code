import { HARNESS_LABELS } from "../ticket";
import type { HarnessAdapter } from "./types";

/**
 * The only harness that can report all eight canonical events. Its hook
 * settings merge additively across scopes, so an injected `--settings` payload
 * composes with the user's own `settings.json` instead of replacing it — the
 * fact the whole wrapper design rests on.
 *
 * `Stop` and `SessionEnd` are both bound because `SessionEnd` fires on Ctrl-C
 * where `Stop` does not; between them a session always closes out.
 * `SubagentStop` is telemetry and must never notify, or every subagent
 * finishing would read as the parent finishing.
 */
export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  label: HARNESS_LABELS["claude-code"],
  command: "claude",
  promptFlag: null,
  detection: { executable: "claude" },
  surfaces: {
    skillsDir: "{home}/.claude/skills",
    commandsDir: "{home}/.claude/commands",
    // It reads CLAUDE.md, never AGENTS.md — and a user's CLAUDE.md is theirs,
    // so Volli claims no instructions file here. The skills symlink carries
    // everything the fenced block would have said.
    instructionsFile: null,
  },
  injection: { kind: "argv-settings-json", flag: "--settings" },
  sessionId: { kind: "argv", flag: "--session-id", format: "uuid" },
  resume: {
    byId: ["--resume", "{id}"],
    latest: ["--continue"],
    userResumeTokens: ["--resume", "-r", "--continue", "-c", "--from-pr"],
  },
  events: [
    { event: "session.started", native: "SessionStart", delivery: "async", timeoutMs: 5000 },
    { event: "session.ended", native: "SessionEnd", delivery: "async", timeoutMs: 5000 },
    { event: "turn.started", native: "UserPromptSubmit", delivery: "async", timeoutMs: 5000 },
    { event: "turn.completed", native: "Stop", delivery: "async", timeoutMs: 5000 },
    { event: "input.needed", native: "Notification", delivery: "async", timeoutMs: 5000 },
    {
      event: "permission.requested",
      native: "PermissionRequest",
      delivery: "async",
      timeoutMs: 5000,
    },
    { event: "tool.started", native: "PreToolUse", delivery: "async", timeoutMs: 5000 },
    { event: "subagent.completed", native: "SubagentStop", delivery: "async", timeoutMs: 5000 },
  ],
  launchSettings: [{ path: "preferredNotifChannel", value: "notifications_disabled" }],
};
