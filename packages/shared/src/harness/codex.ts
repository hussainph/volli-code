import { HARNESS_LABELS } from "../ticket";
import type { HarnessAdapter } from "./types";

/**
 * Codex needs two mechanisms, because neither is sufficient alone: its
 * `hooks.json` has no `Stop`, no `SessionEnd` and no `Notification`, so turn
 * completion is reachable only through the legacy `notify` key and its
 * `agent-turn-complete` payload. Hence the `hooks:` / `notify:` namespace on
 * the native names — two mechanisms, one harness.
 *
 * PROVISIONAL: the `-c key=value` injection path is still being confirmed
 * against a live binary. Codex ignores unrecognized config keys without
 * `--strict-config`, so a botched install fails silently rather than loudly —
 * treat a codex session that never reports as unconfirmed, not as broken.
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
