import { HARNESS_LABELS } from "../ticket";
import type { HarnessAdapter } from "./types";

/**
 * Codex needs two mechanisms, because neither is sufficient alone: its
 * `hooks.json` has no `Stop`, no `SessionEnd` and no `Notification`, so turn
 * completion is reachable only through the legacy `notify` key and its
 * `agent-turn-complete` payload. Hence the `hooks:` / `notify:` namespace on
 * the native names — two mechanisms, one harness.
 *
 * `-c key=value` is confirmed against codex-cli 0.144.6: it parses its value as
 * TOML rather than taking a string, verified by control — a malformed array
 * fails `codex doctor` where a well-formed one passes. What remains unconfirmed
 * is the key naming the external hooks file (see `CODEX_HOOKS_PATH_KEY`).
 *
 * Codex ignores unrecognized config keys without `--strict-config`, so a wrong
 * key fails silently rather than loudly — treat a codex session that never
 * reports as unconfirmed, not as broken.
 *
 * Its hook trust gate is hash-keyed and interactive: a changed hook config
 * re-prompts, and one wrong keypress turns our events off for good. That is why
 * the launch config carries nothing session-specific — see `buildLaunchConfig`.
 */
export const codexAdapter: HarnessAdapter = {
  id: "codex",
  label: HARNESS_LABELS.codex,
  command: "codex",
  promptFlag: null,
  detection: { executable: "codex" },
  surfaces: {
    skillsDir: "{home}/.codex/skills",
    commandsDir: null,
    instructionsFile: "{home}/.codex/AGENTS.md",
  },
  injection: { kind: "argv-config-override", flag: "-c" },
  // The id is discovered from the rollout file, not accepted at launch.
  sessionId: { kind: "none" },
  resume: {
    byId: ["resume", "{id}"],
    latest: ["resume", "--last"],
    userResumeTokens: ["resume"],
  },
  events: [
    {
      event: "turn.started",
      native: "hooks:UserPromptSubmit",
      delivery: "async",
      timeoutMs: 5000,
    },
    {
      event: "turn.completed",
      native: "notify:agent-turn-complete",
      delivery: "async",
      timeoutMs: 5000,
    },
    {
      event: "permission.requested",
      native: "hooks:PermissionRequest",
      delivery: "async",
      timeoutMs: 5000,
    },
    // A permission prompt is the only way codex says a human is blocking it.
    {
      event: "input.needed",
      native: "hooks:PermissionRequest",
      delivery: "async",
      timeoutMs: 5000,
    },
  ],
  launchSettings: [],
};
