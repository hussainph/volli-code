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

Codex hooks are an **inline `hooks` table in the config**, not a file the config points at.
There is no `hooks_path` key — see the live-run section below, where an earlier design that
assumed one was measured reporting nothing at all.

The shape, read off codex 0.144.6's own deserializer:

```toml
[hooks]
Stop = [ { matcher = "…", hooks = [ { type = "command", command = "<string>" } ] } ]
```

`matcher` is optional. `type` is one of `command`, `prompt`, `agent`. For `command`, the value
is a **string**, so the shim path must be shell-quoted — it lives under `Application Support/`,
and an unquoted path is shredded on the only OS we ship. The handler also takes `async` (bool)
and `statusMessage` (string), and a `timeout` that is a bare `u64` **whose unit is stated
nowhere**. We omit `timeout` deliberately: the two readings differ by 1000×, and while
5-as-seconds merely fails to time out a wedged hook, 5-as-milliseconds kills every hook before
it can open the socket. Codex's own default is the safe choice. Do not "fix" this by guessing.

The event fields that exist are `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact` and
`PostCompact`. `SessionEnd` and `Notification` do not. Unknown fields under `hooks` are
silently ignored, which is what makes the whole surface so easy to get wrong: the way to tell
a real field from a typo is that a real one raises a *type* error, and a typo raises nothing.

`SessionStart` existing is worth a decision the adapter has not yet made. The Tiers section
revokes Hooked when no `session.started` arrives in the grace window, and codex declares no
`session.started` binding today even though the field is available to it.

`Stop` existing means turn completion is no longer structurally dependent on the legacy
`notify` argv key. It stays on `notify` anyway. `notify` is the route that has actually been
measured delivering, it sits outside the interactive trust gate, and binding both would report
one turn twice — a dedupe would have to know these two natives mean one turn, which is exactly
the harness-identity knowledge the engine is forbidden to hold. Moving it later is a one-line
data change in the adapter, which is the point of keeping adapters data-only.

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

## What a live run actually proved

Run 2026-07-29 against the real binaries, with the app booted on an isolated profile and only
the hook target swapped for a recorder. Everything between harness and recorder was
production code.

- **claude-code 2.1.220** fired all four bound lifecycle hooks — `SessionStart`,
  `UserPromptSubmit`, `Stop`, `SessionEnd` — each payload carrying `session_id`. This is the
  claim the whole design rests on, and it is now measured rather than inferred.
- **opencode** loaded the generated plugin and reported `turn.started` and `turn.completed`.
- **codex 0.144.6** reported `turn.completed` and nothing else. That event comes from the
  `notify` argv key; the two bindings written into the hooks file — `UserPromptSubmit` and
  `PermissionRequest` — produced no call at all. The cause was then found by probing codex's
  own config loader: **`hooks_path` is not a configuration key**, and codex ignores unknown
  keys unless `--strict-config` is passed, so the hooks file was never read by anything. The
  adapter had been pointing at it for the whole of this branch's life while every test passed,
  because the tests asserted what we wrote rather than what codex accepts.

  The probe that settles questions like this cheaply, for the next person:

  ```
  codex --strict-config -c 'model="__nope__"' -c '<override>' exec --skip-git-repo-check "x"
  ```

  Config errors are reported before any work happens, and the bad model short-circuits the
  run. An unknown field says so by name; a *real* field with a wrong value raises a type error
  instead, and that difference is the only reliable way to tell one from the other. Two traps:
  always include a known-bogus control (`-c bogus_key=1`) in the same sweep, because
  enforcement differs per subcommand and `doctor` and `debug` accept overrides that `exec`
  rejects; and always probe with a **deliberately wrong type**. A field probed with a valid
  value is accepted whether or not it exists, which reads like confirmation and is not one.

  Fixing the key was not the end of it. With a deserializer-accepted inline `hooks` config —
  the byte-exact production argv, confirmed clean by `--strict-config` — a headless `exec` run
  still fired `notify` and **not one hook**. So the shape is confirmed *accepted* and remains
  unconfirmed *firing*, with two live candidates that `RUST_LOG=debug` did not separate: the
  hash-keyed trust gate declining silently, or `exec` not raising hooks at all. Settling it
  needs an interactive TUI, exactly like the `Notification` question below.

  One consequence for whoever ships this: because the hooks file was never read, codex sessions
  have never hit the trust gate. They will now, once, on first launch.
- **cursor** was asserted against its written config only, not run.

`--print` never blocks on a human, so it raises no `Notification` however correct the binding
is. That left the event the whole feature exists for unproven, and it took an interactive run
to settle. Driving the real TUI under a pty — `script -q /dev/null` fails here with
`tcgetattr/ioctl: Operation not supported on socket`, so allocate the pty pair directly, e.g.
Python's `pty.fork` — with our production settings gives:

```json
{ "hook_event_name": "Notification", "notification_type": "idle_prompt",
  "message": "Claude is waiting for your input", "session_id": "…" }
```

So **`preferredNotifChannel: "notifications_disabled"` does not suppress the `Notification`
hook.** It silences Claude's own terminal notification and leaves ours alone, which is exactly
the arrangement the design assumed and had no evidence for. `input.needed` is confirmed
reaching us from the real binary, not only through the shim.

## The PATH failure, and what it cost

Wrapper-first injection rests on one property: Volli's `bin/` is what a session's shell finds
first. `agentSessionEnv` prepends it, every test agreed it was there, and the property never
held on macOS for a single session.

A PTY spawns `$SHELL -l`. `/etc/zprofile` then runs `path_helper`, which rebuilds `PATH` with
`/etc/paths` first and appends whatever it inherited; then each user prepend in `.zprofile`
and `.zshrc` lands on top of that. Measured on a stock host, a directory prepended into
`$SHELL -l` finishes at **position 20 of 30**. No wrapper ever ran. No hook ever fired. Every
component was individually correct, which is why nothing caught it.

Two mechanisms close it, because there are two ways a harness starts:

- A launch Volli initiates names the generated wrapper **by absolute path**. Deterministic on
  every shell, and the wrapper path is a required parameter so a new call site cannot omit it
  in silence.
- A harness the user types by hand can only be routed by the shell, so `ZDOTDIR` points at a
  Volli-owned directory whose files source the user's own and then re-assert the prepend —
  VS Code's shell-integration mechanism. Nothing is written to the user's dotfiles. zsh only:
  bash and fish reach no equivalent post-startup hook without reimplementing their login
  semantics, so those sessions are launched-wrapped but not typed-wrapped and report the tier
  they can actually deliver.

Measured after, against real dotfiles: position 1 of 29, all four harnesses resolving to their
wrapper.

Three defects were inert only because the bin dir kept losing, and became live the moment it
won. `volli hook` never checked `endedAt`, so an event from an environment that outlived its
session — a tmux server or daemon started inside a Volli terminal — was accepted in full,
including the notification and a sidebar row for a dead session. A manifest could claim a
command name like `git`, and a wrapper under that name would have shadowed the real tool in
every Volli terminal. And `volli` itself resolved through `/usr/local/bin`, so the CLI worked
only for users who had accepted the global link.

The lesson is the one `volli doctor` is built on: **assert outcomes, not configuration.** "The
bin dir is on PATH" was true for the whole outage. "Typing `claude` here runs the wrapper" was
not, and nothing asked it.

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
- Codex has no `hooks_path` configuration key. Hooks are an inline `hooks` table. This one was
  ours, not the documentation's — it was a guess that shipped behind a `PROVISIONAL` comment
  and then passed every test for the length of the branch, because nothing asserted against
  codex itself.
- Codex hooks **do** include `Stop`. The earlier claim that turn completion is reachable only
  through the legacy `notify` key is wrong.
- Prepending `PATH` in a spawned process's environment does **not** survive a macOS login
  shell, and no amount of care makes it. Anything that must win `PATH` has to run after the
  user's shell startup, not before it. This one was ours too, and it made the whole feature
  inert while every test passed.

## Out of scope for the first landing

Volli answering permission requests on the agent's behalf. The events are observed and
reported; the approval UI, and the sync bindings that would block a harness for up to two
minutes waiting on a human, are a product surface of their own and come later.
