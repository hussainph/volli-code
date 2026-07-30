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
 * Three things govern whether a codex hook runs at all, all of them silent from
 * inside Volli, and all found by running 0.144.6 rather than by reading it.
 *
 * 1. **`async=true` is skipped outright.** `codexHookOverrides` renders
 *    `delivery: "async"` as `async=true`, and codex answers `warning: skipping
 *    async hook … async hooks are not supported yet` and runs nothing — its own
 *    hooks panel counts such a binding as `Installed 0`. So every binding here
 *    is `sync`, which is not a preference: it is the only rendering codex runs,
 *    and it is a true description of what codex does with a command hook.
 *
 *    The blocking cost was measured rather than assumed. Codex waits for the
 *    hook's full wall time, one-for-one: `codex exec` with a no-op
 *    `UserPromptSubmit` hook took a 4.4s median, and with a 6s hook 10.6s
 *    (+6.2s, and the variance collapsed to ±0.3s because the hook dominates).
 *    So the cost of a sync binding is exactly what `volli hook` costs, and that
 *    is ~100ms — an ELECTRON_RUN_AS_NODE boot, dominated by the boot. A socket
 *    path that does not exist fails fast (~107ms) rather than burning the
 *    budget, and no `VOLLI_SESSION` returns in ~102ms without opening anything.
 *    The one pathological case is a socket that is PRESENT and wedged — accepts
 *    the connection and never answers — which self-bounds at `HOOK_BUDGET_MS`
 *    and was measured at 2.56s before exiting 0. Against a turn that already
 *    costs seconds, ~100ms is not perceptible and 2.56s is survivable; a dead
 *    Volli, the common failure, costs nothing.
 *
 * 2. **The hook trust gate.** Hash-keyed over the hook config, interactive, and
 *    blocking at startup. Observed in a pty rather than described: codex opens
 *    with `Hooks need review / 1 hook is new or changed. / Hooks can run outside
 *    the sandbox after you trust them.` over `1. Review hooks`, `2. Trust all
 *    and continue`, `3. Continue without trusting (hooks won't run)`, with
 *    `Review hooks` preselected — so declining is deliberate, not the default,
 *    but so is accepting. Answering `2` persists, and the next launch of the
 *    same config shows nothing. Adding the `SessionStart` binding changes the
 *    hash, so every existing install is asked exactly once. This is also why the
 *    launch config carries nothing session-specific: it keeps the hash stable,
 *    so the question stays once-ever rather than once-per-launch.
 *
 * 3. **`SessionStart` is not a launch-time event in the TUI**, which is the
 *    mode Volli launches. Under `codex exec` it fires before the prompt is read;
 *    in the TUI, a fully trusted config fires NOTHING at boot and fires
 *    `SessionStart` on the first turn, alongside `UserPromptSubmit`. Codex has
 *    no session until there is a turn. Hence `startupEvent: null` — the channel
 *    genuinely cannot prove itself alive until the agent acts, and claiming
 *    otherwise would accuse every healthy codex session that has not been typed
 *    into yet, which is the exact bug this field exists to prevent.
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
    // Every `hooks:` binding is `sync` — see 1. above. `volli hook` is built to
    // be waited on: it exits 0 in silence however badly it goes, inside a budget
    // shorter than any harness's deadline, so the worst a wedged Volli can do to
    // a codex turn is delay it.
    { event: "session.started", native: "hooks:SessionStart", delivery: "sync" },
    { event: "turn.started", native: "hooks:UserPromptSubmit", delivery: "sync" },
    { event: "turn.completed", native: "notify:agent-turn-complete", delivery: "async" },
    // A permission prompt is the only way codex says a human is blocking it, so
    // one native name carries two canonical events and codex runs the hook
    // twice. Two invocations of ~100ms, in front of a prompt that is about to
    // stop and wait for a human anyway. Verified live not to disturb the
    // decision: with these bound, an approval request still appeared and still
    // took the answer — the hook writes nothing to stdout, and codex's schema
    // only fails closed on a hook that returns decision fields.
    { event: "permission.requested", native: "hooks:PermissionRequest", delivery: "sync" },
    { event: "input.needed", native: "hooks:PermissionRequest", delivery: "sync" },
  ],
  // Null, and measured — see 3. above. Codex has no session until the first
  // turn, so nothing it does at launch is observable and it may not be held to
  // a launch-time promise.
  startupEvent: null,
  launchSettings: [],
  // Empty until a marker is observed on a real codex session — a guessed name is
  // a variable deleted from the user's environment for no reason.
  sessionMarkers: [],
};
