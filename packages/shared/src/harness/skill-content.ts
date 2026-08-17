export const VOLLI_SKILL = `---
name: volli
description: Coordinates Volli planning, tickets, and terminal sessions through the bundled CLI. Use when working in a Volli-tracked project or a Volli terminal session.
---

# Volli

You are working in a Volli-tracked project / Volli terminal session (the \`VOLLI_TICKET\`/\`VOLLI_SESSION\` env vars are present). From here on, use the bundled \`volli\` CLI as your planning interface: tickets, board moves, comments, and session signals go through it, not through ad-hoc notes.

The CLI is self-documenting — it is the authoritative reference, not this skill:

- \`volli help\` — the full command reference.
- \`volli help <command>\` — details for one command.
- Start with \`volli identify\` to resolve your project/ticket/session context.

- Read [cli.md](cli.md) for the workflow (when to read, comment, move, or signal).
- Read [orchestration.md](orchestration.md) before coordinating multiple tickets or sessions.
- Read [plugin.md](plugin.md) to register the harness you are running inside, when Volli does not already know it.
- Treat files under \`custom/\` as user-owned extensions when present.

If the app is unreachable, run \`volli app launch\` explicitly and retry. Surface every CLI error; never silently continue after a failed mutation.
`;

export const VOLLI_CLI_REFERENCE = `# Volli workflow

This is a workflow guide. For command and flag syntax, run \`volli help\` (full reference) or \`volli help <command>\` (one command) — never guess flags.

Start every task with \`volli identify\` to learn your project, ticket, and session.

## Orient yourself

Your working directory is the ticket's git worktree — every edit happens there, in your \`cwd\`. \`VOLLI_PROJECT_DIR\` names the main checkout: it is reference-only, never your edit target. Inspect the worktree through the CLI rather than reaching for raw git: \`volli worktree status\` (branch, base, and ahead/behind/unpushed sync state) and \`volli worktree diff\` (the merge-base PR range by default, or \`--working-tree\` for uncommitted changes).

## Read before you write

Inspect state before mutating it: read the board and the target ticket first, so an edit builds on the current record rather than a stale assumption.

- \`volli board\` for the column overview; \`volli ticket show <id>\` for one ticket.
- Add \`--json\` to anything you intend to parse; the plain output is for reading.
- \`volli session peek\` reads any id \`session list\` prints: a terminal's output, or a chat's activity and transcript tail. Keep it narrow — output consumes your context.

## Comment vs move vs signal

- Comment (\`volli ticket comment\`) to record findings or hand off context; use exact body edits so a stale read fails instead of clobbering.
- Move (\`volli ticket move\`) only for a deliberate, real status change. Signals never move the board: when the ticket is ready, the move is its own explicit step.
- Signal \`volli session blocked\` when you are stuck and need a person — the \`--reason\` is exactly what they see.
- Signal \`volli session done\` to record that your session finished; it lands in the session ledger only, so pair it with the comment and move that actually hand the work over.

Surface every CLI error; never continue silently after a failed mutation.
`;

export const VOLLI_ORCHESTRATION = `# Volli orchestration

1. Read before writing: identify, then inspect the board and target ticket.
2. Work your own board unless explicitly asked to reach another project.
3. Prefer ticket comments and moves for coordination; never drive another session's terminal.
4. Do not opt out of worktree isolation unless instructed.
5. Do not chain-spawn work merely because a ticket entered Doing.
6. Use exact body edits for existing prose so stale reads fail instead of clobbering changes.
7. Peek a session (terminal or chat) to learn whether it is alive, what it is doing, and when it last moved; keep peeks narrow, because their output consumes the caller's context.
`;

/**
 * The `/volli plugin` subskill: the manifest schema, written for whoever has to
 * author one — a third party, or an agent doing it for the harness it is running
 * inside. Reference material, so it states what the fields are and what happens,
 * and leaves the reasoning to the modules that implement it.
 */
export const VOLLI_PLUGIN_DOC = `# Registering a harness

A manifest at \`~/.agents/harnesses/<slug>/harness.json\` registers a harness Volli ships no adapter for. Volli reads it at startup — nothing is compiled in, and no Volli release is involved. The directory name and the \`slug\` field must match.

A registered harness and a built-in one are the same kind of thing to Volli: it reads the capabilities the manifest declares and never branches on which harness it is holding.

## Fields

| field | required | value |
| --- | --- | --- |
| \`manifestVersion\` | yes | \`1\` |
| \`slug\` | yes | lowercase letters, digits and dashes, starting with a letter, 2–32 characters. Not one of \`claude-code\`, \`codex\`, \`cursor\`, \`opencode\` |
| \`label\` | yes | display name |
| \`command\` | yes | bare executable name — no path, no whitespace, no metacharacters, and not \`volli\` |
| \`promptFlag\` | no | the flag that carries the initial prompt (\`--prompt\`). Omit for a positional prompt |
| \`surfaces\` | no | where the harness reads shared agent assets from |
| \`injection\` | no | how the harness accepts configuration at launch |
| \`sessionId\` | no | where the harness's own session id comes from |
| \`resume\` | no | argv that resumes a prior session |
| \`events\` | no | which harness-native signals map to which Volli events |
| \`startupEvent\` | no | the bound event the harness fires at boot, before the user acts |
| \`launchSettings\` | no | harness-native settings Volli forces at launch |

Every omitted optional field means "this harness cannot do that".

## surfaces

Paths start with \`{home}/\`, which Volli replaces with the user's home directory, and may not contain \`..\`.

- \`skillsDir\` — the harness reads \`<dir>/<name>/SKILL.md\`. Volli symlinks the \`volli\` skill into it.
- \`commandsDir\` — the harness reads slash commands from \`<dir>/*.md\`. Used only when \`skillsDir\` is absent.
- \`instructionsFile\` — a global instructions file. Volli maintains a fenced block in it and leaves the rest of the file alone.

## injection

One object, discriminated by \`kind\`. Every kind either passes configuration on the command line or points an environment variable at a file Volli owns. There is no kind that merges into the user's own configuration.

Each kind is named after the harness it was written against, and declaring it claims your harness reads what that one reads — the same flag, the same hook schema, the same file.

- \`{"kind": "none"}\` — the harness takes no configuration at launch.
- \`{"kind": "claude-settings-json", "flag": "--settings"}\` — the flag takes Claude Code's settings JSON as a string.
- \`{"kind": "codex-config-override", "flag": "-c"}\` — the flag takes one TOML \`key=value\` override, repeated.
- \`{"kind": "config-dir-env", "envVar": "MY_CONFIG_DIR", "filename": "config.json"}\` — the variable names a directory; the harness finds \`filename\` inside it, holding \`{"<Native>": [{"command": "…"}]}\`.
- \`{"kind": "opencode-plugin", "envVar": "MY_CONFIG", "filename": "config.json"}\` — the variable names the file itself, and Volli also emits the plugin module that file loads.

\`filename\` is a bare filename. Volli writes it under its own per-harness directory; a manifest cannot write anywhere else.

## sessionId

- \`{"kind": "argv", "flag": "--session-id"}\` — Volli mints a UUID and passes it at spawn.
- \`{"kind": "reported"}\` — the id arrives on the harness's own events.
- \`{"kind": "none"}\` — the agent runs \`volli session link\` to report it.

## resume

- \`byId\` — argv template containing exactly one \`{id}\` token, substituted with the prior session id.
- \`latest\` — argv that resumes the most recent session in the working directory.
- \`userResumeTokens\` — argv words meaning the user is driving resume themselves. When one appears on their command line, Volli stops injecting a session id.

## events

Each binding maps one harness-native signal to one Volli event:

\`\`\`
{ "event": "input.needed", "native": "Notification", "delivery": "async" }
\`\`\`

- \`event\` — one of \`session.started\`, \`session.ended\`, \`turn.started\`, \`turn.completed\`, \`input.needed\`, \`permission.requested\`, \`tool.started\`, \`subagent.completed\`.
- \`native\` — the harness's own name for the signal. Opaque to Volli. When a harness delivers signals by more than one mechanism, prefix the name with the mechanism (\`hooks:PermissionRequest\`, \`notify:agent-turn-complete\`).
- \`delivery\` — \`async\` reports and returns. \`sync\` blocks the harness until Volli answers.

Volli sets the hook timeout itself, the same for every binding of every harness. A binding does not declare one.

\`input.needed\` means a human is blocking the agent. It sorts the session to the top of the sidebar's Active band and drives the native notification.

## startupEvent

One event name, or omitted. It must be an event \`events\` also binds, and it must be one the harness fires on boot before the user does anything — a launch of the harness alone has to produce it.

Volli reads silence against it. Declare one and a launch that reports nothing means the configuration did not take, and Volli says so. Omit it and Volli expects nothing until the agent acts, which is the right answer for a harness that only speaks once there is a conversation.

## launchSettings

Dotted paths into the harness's own configuration, with scalar values whose JSON types are preserved:

\`\`\`
[{ "path": "notifications.enabled", "value": false }]
\`\`\`

## Trust

A manifest declares a command line Volli will execute, so:

1. A manifest is inert until trusted. A new manifest, or one changed by a single byte, does not launch.
2. Trust requires confirmation showing the slug, the resolved binary path, the exact argv, and the claimed events.
3. Arguments reach the harness only from the declared argv arrays, which is what makes that confirmation exact.
4. A manifest cannot declare a global configuration merge, and files it supplies are written only under Volli's own per-harness directory.

Declaring an event gains nothing on its own. An event becomes verified on its first real delivery, and only verified events drive automatic board moves and notifications; until then the capability reads as unconfirmed.

## Example

\`\`\`json
{
  "manifestVersion": 1,
  "slug": "acme-agent",
  "label": "Acme Agent",
  "command": "acme",
  "promptFlag": "--prompt",
  "surfaces": {
    "skillsDir": "{home}/.acme/skills",
    "commandsDir": null,
    "instructionsFile": "{home}/.acme/AGENTS.md"
  },
  "injection": { "kind": "claude-settings-json", "flag": "--settings" },
  "sessionId": { "kind": "argv", "flag": "--session-id" },
  "resume": {
    "byId": ["--resume", "{id}"],
    "latest": ["--continue"],
    "userResumeTokens": ["--resume", "-r"]
  },
  "events": [
    { "event": "session.started", "native": "SessionStart", "delivery": "async" },
    { "event": "turn.completed", "native": "Stop", "delivery": "async" },
    { "event": "input.needed", "native": "Notification", "delivery": "async" }
  ],
  "startupEvent": "session.started",
  "launchSettings": [{ "path": "notifications.enabled", "value": false }]
}
\`\`\`

## Errors

A manifest that does not validate is reported field by field, each error naming a path such as \`events[1].delivery\`. Fix the named fields and the manifest is re-read.
`;

/** The slash-command doc for a harness that reads commands but no skills. */
export const VOLLI_COMMAND_DOC = `You are in a Volli terminal session. Run \`volli identify\`, then use the bundled \`volli\` CLI as your planning interface. It is self-documenting: \`volli help\` for the full reference, \`volli help <command>\` for details. Follow the volli skill (when installed) for norms.
`;

export const VOLLI_FENCED_INSTRUCTIONS = `You are in a Volli-tracked project / terminal session. Use the bundled \`volli\` CLI as your planning interface for tickets, board moves, comments, and session signals. Run \`volli identify\` first, then read the relevant board or ticket before writing. The CLI is self-documenting: \`volli help\` for the full reference, \`volli help <command>\` for details. If the app is unreachable, run \`volli app launch\` explicitly before retrying; surface every CLI error.`;
