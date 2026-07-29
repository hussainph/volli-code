import { HARNESS_LABELS } from "../ticket";
import type { HarnessAdapter } from "./types";

/**
 * Codex needs two mechanisms, because neither is sufficient alone, hence the
 * `hooks:` / `notify:` namespace on the native names.
 *
 * Hooks are an inline `hooks` table in codex's own config, rendered by
 * `codexHookOverrides`. The event fields that exist on codex-cli 0.144.6 are
 * `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
 * `PermissionRequest`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`
 * and `PostCompact`; `SessionEnd` and `Notification` do not. Read off codex's
 * own deserializer, which is the only reliable way to tell a real field from a
 * typo — unknown keys under `hooks` are ignored in silence, while a real field
 * given the wrong type raises a type error:
 *
 *   codex --strict-config -c 'model="__nope__"' -c '<override>' \
 *     exec --skip-git-repo-check "x"
 *
 * `turn.completed` stays on `notify` even though `Stop` exists. Two reasons.
 * Binding both would report one turn twice and nothing dedupes them. And
 * `notify` is the measured mechanism: in a live run whose inline hook config
 * codex's deserializer accepts, `notify` fired and no hook did — hooks sit
 * behind the trust gate below, and `notify` does not. Turn completion is the
 * most load-bearing lifecycle signal we have, so it stays on the route that
 * survives a declined gate. Moving it is a one-line change here if a live run
 * ever proves `Stop` fires.
 *
 * Codex ignores unrecognized config keys without `--strict-config`, so a wrong
 * key fails silently rather than loudly — treat a codex session that never
 * reports as unconfirmed, not as broken. That is exactly how an earlier
 * `hooks_path` guess survived this whole branch reporting nothing.
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
  injection: { kind: "codex-config-override", flag: "-c" },
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
  // Empty until a marker is observed on a real codex session — a guessed name is
  // a variable deleted from the user's environment for no reason.
  sessionMarkers: [],
};
