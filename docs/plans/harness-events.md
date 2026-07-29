# Harness events

How Volli learns what an agent is doing without asking it to cooperate.

Today every signal is voluntary: the board moves, notifications fire, and the "Needs you"
tier fills only because an agent chose to run `volli session done` / `blocked` / `link`.
An agent that is interrupted, hits a context limit, or simply never read the skill leaves
the board frozen with no indication anything is wrong. This document specifies the
involuntary channel that replaces that guesswork, and the tiers a harness falls back
through when it can't support one.

Every per-harness claim below was verified against the installed binary — `--help` output,
config probes, live event dumps, or a source read. Published documentation was wrong often
enough (see [Corrections](#corrections)) that it is not a citable source here.

## The shape of it

A Volli-owned `bin/` directory is already prepended to `PATH` for Volli's PTYs and nothing
else, by `agentSessionEnv` (`packages/shared/src/volli-dir.ts`), which also exports
`VOLLI_SESSION` and `VOLLI_SOCKET`. Harness wrappers land in that directory beside the
existing `volli` shim.

A wrapper is a passthrough. With `VOLLI_SESSION` unset it execs the real binary unchanged,
so a harness invoked from a normal terminal is untouched. Inside a Volli session it execs
the real binary with configuration injected on the command line — a session id we generate,
and a hook configuration pointing back at `volli hook`.

Nothing is written to the user's harness configuration. That is the whole point: no
`~/.claude/settings.json` merge, no manifest, no conflict detection, no uninstall, and no
"am I inside a Volli worktree" guard on every hook fire. The machinery in
`apps/desktop/src/main/harness-install.ts` stays exactly as it is and keeps serving the
baseline asset tier (skill files, the `AGENTS.md` fenced block), which does write real
files and does need that protection.

Because we mint the session id at spawn, `sessions.harness_session_id` is known before the
agent produces a single byte. `volli session link` survives for harnesses that can't accept
an id at launch.

## Canonical events

Harness-native event names never leave the adapter. The rest of the app consumes one union.

```ts
export const HARNESS_EVENTS = [
  "session.started", "session.ended",
  "turn.started", "turn.completed",
  "input.needed", "permission.requested",
  "tool.started", "subagent.completed",
] as const;
export type HarnessEvent = (typeof HARNESS_EVENTS)[number];
```

`input.needed` is the one that earns the feature. It means a human is blocking the agent's
progress, and it is what drives the sidebar's "Needs you" tier and the native notification.

## What each harness can actually do

| | per-launch injection | session id at launch | `input.needed` | turn start / complete |
|---|---|---|---|---|
| **claude-code** | `--settings <inline json>` | `--session-id <uuid>` | `Notification` (`idle_prompt`, `permission_prompt`) | `UserPromptSubmit` / `Stop` |
| **codex** | `-c key=value` (TOML-valued) | discovered from rollout file | `PermissionRequest` | `UserPromptSubmit` / `notify` only |
| **cursor** | `CURSOR_CONFIG_DIR` (layers) | `--new-session-id <uuid>` | **absent** | `beforeSubmitPrompt` / `stop` |
| **opencode** | `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` (layers) | reported on every event | `permission.asked` | `message.updated` / `session.idle` |

### claude-code

Hooks aggregate additively across scopes, so an injected `--settings` payload composes with
the user's own `settings.json` rather than replacing it — this is what makes wrapper
injection safe rather than destructive. Every hook payload carries `session_id`. Payload
arrives on stdin; exit 2 blocks; default timeout is 60s.

The real event list, from a source read of v2.1.220, is twelve: `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `Notification`, `UserPromptSubmit`, `SessionStart`,
`SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`.

Set `preferredNotifChannel: "notifications_disabled"` so the harness's own terminal
notifications don't double up with Volli's. `SubagentStop` is telemetry — it must never
notify, or every subagent finishing reads as the parent finishing. `SessionEnd` fires on
Ctrl-C where `Stop` does not, so both are needed to close a session out.

Hooks are silently skipped when `disableAllHooks` is set or workspace trust hasn't been
accepted. Neither is detectable up front; both surface as a session that never reports.

Skills live at `~/.claude/skills/<name>/SKILL.md`, commands at `~/.claude/commands/*.md`.
It does not read `AGENTS.md` — `CLAUDE.md` only.

### codex

Codex needs two mechanisms, because neither is sufficient alone. Its `hooks.json` has no
`Stop`, no `SessionEnd`, and no `Notification`, so turn completion is only reachable through
the legacy `notify` argv key and its `agent-turn-complete` payload. `PermissionRequest`
comes from `hooks.json`. Any model that assumes one hook mechanism per harness is wrong
here.

Configuration is injectable at launch. `-c key=value` overrides any value that would come
from `~/.codex/config.toml`, and it parses TOML values rather than plain strings — verified
by control: `-c 'notify=["/bin/echo","volli"]'` passes `codex doctor` clean while
`-c 'notify=["unclosed'` fails it. `-p, --profile` layers a named config file over the base
user config as an alternative. Nothing global needs writing.

Hooks are trust-gated, and the gate is interactive and hash-keyed: a new or changed hook
config raises a startup review offering *Trust all and continue* or *Continue without
trusting (hooks won't run)*. A `--dangerously-bypass-hook-trust` flag exists, but it
bypasses review for the user's own hooks too, so it is not an option.

This imposes a hard constraint on the adapter: **the injected hook configuration must be
byte-stable across sessions.** If it varies, its hash changes, and every Volli-launched
Codex session opens on a trust prompt that one wrong keypress turns into silently missing
events. Nothing session-specific may appear in a hook command line — the session id reaches
the harness through `VOLLI_SESSION` in the environment, which is why `buildLaunchConfig` is
session-independent by construction. Do not "simplify" that by threading a session id back
into the command.

Unrecognized config keys are ignored without `--strict-config`, so a botched install fails
silently rather than loudly.

Skills live at `~/.codex/skills/<name>/SKILL.md`. It reads a global `~/.codex/AGENTS.md`
plus a per-directory walk, deepest winning.

The build validated locally is `0.144.6`, bundled with the ChatGPT desktop app and likely
ahead of the public OSS CLI most users run. Feature-detect; do not assume.

### cursor

Cursor cannot report `input.needed`, and this is confirmed rather than merely undocumented:
its source carries a Claude-Code-compatibility event map in which `PermissionRequest` and
`Notification` are both mapped to `null`. It ships deliberately degraded and says so.

Everything else is available — `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `stop`,
`afterAgentResponse`, `preToolUse`, `postToolUseFailure`, and a large shell/MCP/file event
set. Contract is stdin JSON in, stdout JSON out; exit 2 denies; hooks fail *open* unless
`failClosed: true`.

`CURSOR_CONFIG_DIR` redirects `cli-config.json` without touching authentication, which is
hardcoded to `~/.cursor/auth.json` — so pointing it at a Volli-owned directory layers
rather than replaces. `--new-session-id` exists but is hidden (`.hideHelp()`).

Two open risks. Hooks load *after* the auth and server round-trip, so a logged-out or
offline Cursor loads no hooks at all. And a community report claims the CLI only emits the
shell events in practice despite the fuller catalog in source — unverified, because the
validation machine wasn't logged in.

It reads `AGENTS.md`, and `CLAUDE.md` only behind a `thirdPartyExtensibility` flag.
`~/.cursor/commands` does not exist for the CLI.

### opencode

`OPENCODE_CONFIG` layers over the user's configuration — verified by load order, with the
user's providers and auth loading first. A config containing `"plugin": ["/abs/path.js"]`
loads that plugin with zero writes under `~/.config/opencode`.

The documented `permission.ask` blocking hook does not fire. Use the generic `event` hook to
observe `permission.asked`, and reply asynchronously via
`POST /permission/{requestID}/reply` — the same approach cmux's shipped plugin takes.
`sessionID` is present on nearly every event.

Plugins run under Bun, dependency-free single files work, and shell-outs are awaited.

Traps: the published SDK types are stale relative to the binary (`permission.updated` in
the `.d.ts`, `permission.asked` at runtime), so don't trust the types alone. `--pure` /
`OPENCODE_PURE=1` and `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` disable plugins and must never be
set by the wrapper. And `opencode run` auto-rejects permissions without `--auto` or a
replying plugin, which silently fails tool calls.

`--prompt` exists only on the default TUI command, not on `run`.

## Tiers

A harness's tier is derived from what it declares and confirmed by what it delivers. It is
never asserted.

**Hooked** — the launch went through our wrapper and the harness declares both an injection
strategy and event bindings. Generated resume id, live turn and idle state, automatic board
moves, native notifications.

**Known** — no usable injection path. Launch with a prompt, resume by id or latest, baseline
skill and fenced block, activity inferred from the PTY foreground-process heuristic. The
session header states that activity is inferred and why.

**Declared** — an unknown or user-registered harness. It still launches with its prompt, and
the entire agentic surface still works, because `volli` reaches the app through
`VOLLI_SOCKET` and a PATH entry that are harness-agnostic. The agent can identify itself,
move its ticket, comment, and signal done or blocked. What it does not get is automatic idle
detection, permission interception, or by-id resume unless it declares them.

Hooked is revocable at runtime. If we launch expecting hooks and no `session.started`
arrives within a grace window — the user ran `/opt/homebrew/bin/claude` directly, bypassing
the wrapper — the session drops to Known with that stated reason. A harness never appears to
report events it isn't reporting.

## Bring your own harness

A third party should be able to integrate a harness into Volli without a Volli release, and
an agent should be able to do it on the harness's behalf from inside a session.

A manifest at `~/.agents/harnesses/<slug>/harness.json` — sibling to the existing
`~/.agents/skills/volli/` — declares the same data a built-in adapter does: command, prompt
flag, resume argv, instruction file, injection strategy, and event bindings. A built-in
adapter and a registered one are the same type; the engine reads capabilities and never
branches on identity.

`~/.agents/skills/volli/plugin.md` documents the schema so an agent can author a correct
manifest for whatever harness it is running inside.

### Trust

A manifest declares a command line Volli will execute. Four rules, and they are not
negotiable:

1. A manifest is inert until trusted. New, or changed by one byte, means it does not launch.
2. Trust requires explicit confirmation showing the slug, the resolved binary path, the exact
   argv Volli will run, and the claimed events.
3. `command` must be a bare executable name — no slashes, no whitespace, no shell
   metacharacters. Arguments come only from declared argv arrays. This makes the
   confirmation dialog's claim literally true.
4. Manifests may not declare a global config merge, and plugin files they supply are written
   only under `<userData>/harness/<slug>/`. Writing outside Volli-owned directories is
   reserved to built-ins.

Declared events gate nothing. An event becomes *verified* on first real delivery, and only
verified events drive automatic board moves and notifications. Until then the capability
shows as unconfirmed. A manifest can claim anything and gain nothing by lying.

## Corrections

Prior research and published documentation asserted several things that are false. They are
recorded here so nobody reintroduces them.

- Claude Code does **not** have ~30 hook events. It has twelve.
- Claude Code settings **do** merge additively across scopes. The claim that they replace
  wholesale is wrong, and the entire wrapper design depends on the correct version.
- opencode does **not** load `CLAUDE.md` as live agent context.
- opencode's `permission.ask` hook does not fire; its published SDK types are stale.
- cmux does **not** install global hooks. It uses PATH-shimmed wrappers and per-launch
  injection, which is where this design comes from.

## Out of scope for the first landing

Volli answering permission requests on the agent's behalf. The events are observed and
reported; the approval UI, and the sync bindings that would block a harness for up to two
minutes waiting on a human, are a product surface of their own and come later.
