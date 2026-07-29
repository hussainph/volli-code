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
 * codex's deserializer accepts, `notify` fired and no hook did. Turn completion
 * is the most load-bearing lifecycle signal we have, so it stays on the route
 * that survives everything below. Moving it is a one-line change here if a live
 * run ever proves `Stop` fires.
 *
 * Codex ignores unrecognized config keys without `--strict-config`, so a wrong
 * key fails silently rather than loudly — treat a codex session that never
 * reports as unconfirmed, not as broken. That is exactly how an earlier
 * `hooks_path` guess survived this whole branch reporting nothing.
 *
 * Two measured reasons a codex hook does not run, both of them silent from
 * inside Volli, and both found by running 0.144.6 rather than by reading it:
 *
 * 1. **`async=true` is skipped outright.** `codexHookOverrides` renders
 *    `delivery: "async"` as `async=true`, and codex answers `warning: skipping
 *    async hook … async hooks are not supported yet` and runs nothing. Every
 *    binding below that says `async` is therefore dead on this version, which is
 *    the real explanation for the "no hook fired" run recorded above — it was
 *    read as the trust gate, and it was not. `session.started` says `sync`
 *    because that is the only rendering codex will run; the others are left as
 *    they are rather than changed by a stage that was not weighing what it means
 *    for codex to BLOCK on a permission hook.
 * 2. **The hook trust gate.** Hash-keyed over the hook config and interactive: a
 *    changed config re-prompts, and one wrong keypress turns our events off for
 *    good. Adding the `SessionStart` binding below changes the hash, so every
 *    existing install re-prompts once. An unreviewed config runs no hooks and
 *    says nothing about it — `codex exec` with a valid sync `SessionStart`
 *    prints no warning and fires nothing, while the same run under
 *    `--dangerously-bypass-hook-trust` prints `hook: SessionStart` and fires.
 *    That is why the launch config carries nothing session-specific: it keeps the
 *    hash stable, so the prompt is once ever rather than once per launch.
 */
export const codexAdapter: HarnessAdapter = {
  id: "codex",
  label: HARNESS_LABELS.codex,
  command: "codex",
  promptFlag: null,
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
    // `sync` is not a preference — see 1. above. Codex runs a command hook
    // inline and waits for it, which is what `sync` has always meant here, and
    // `volli hook` is built to be waited on: it exits 0 in silence however badly
    // it goes, inside a budget shorter than any harness's deadline.
    {
      event: "session.started",
      native: "hooks:SessionStart",
      delivery: "sync",
    },
    {
      event: "turn.started",
      native: "hooks:UserPromptSubmit",
      delivery: "async",
    },
    {
      event: "turn.completed",
      native: "notify:agent-turn-complete",
      delivery: "async",
    },
    {
      event: "permission.requested",
      native: "hooks:PermissionRequest",
      delivery: "async",
    },
    // A permission prompt is the only way codex says a human is blocking it.
    {
      event: "input.needed",
      native: "hooks:PermissionRequest",
      delivery: "async",
    },
  ],
  // Claimed, and revocable by the user: a codex whose hook review was declined
  // reports nothing at launch, and saying so is the point. A codex that never
  // reported anything and never showed a review prompt is a codex whose config
  // did not take.
  startupEvent: "session.started",
  launchSettings: [],
  // Empty until a marker is observed on a real codex session — a guessed name is
  // a variable deleted from the user's environment for no reason.
  sessionMarkers: [],
};
