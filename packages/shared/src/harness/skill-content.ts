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
- Treat files under \`custom/\` as user-owned extensions when present.

If the app is unreachable, run \`volli app launch\` explicitly and retry. Surface every CLI error; never silently continue after a failed mutation.
`;

export const VOLLI_CLI_REFERENCE = `# Volli workflow

This is a workflow guide. For command and flag syntax, run \`volli help\` (full reference) or \`volli help <command>\` (one command) — never guess flags.

Start every task with \`volli identify\` to learn your project, ticket, and session.

## Read before you write

Inspect state before mutating it: read the board and the target ticket first, so an edit builds on the current record rather than a stale assumption.

- \`volli board\` for the column overview; \`volli ticket show <id>\` for one ticket.
- Add \`--json\` to anything you intend to parse; the plain output is for reading.
- Keep \`volli session peek\` narrow — raw terminal output consumes your context.

## Comment vs move vs signal

- Comment (\`volli ticket comment\`) to record findings or hand off context.
- Move (\`volli ticket move\`) only for a deliberate, real status change.
- Signal (\`volli session done\` / \`volli session blocked\`) to report your own session's outcome; use exact body edits so a stale read fails instead of clobbering.

Surface every CLI error; never continue silently after a failed mutation.
`;

export const VOLLI_ORCHESTRATION = `# Volli orchestration

1. Read before writing: identify, then inspect the board and target ticket.
2. Work your own board unless explicitly asked to reach another project.
3. Prefer ticket comments and moves for coordination; never drive another session's terminal.
4. Do not opt out of worktree isolation unless instructed.
5. Do not chain-spawn work merely because a ticket entered Doing.
6. Use exact body edits for existing prose so stale reads fail instead of clobbering changes.
7. Keep session peeks narrow; raw terminal output consumes the caller's context.
`;

export const VOLLI_OPENCODE_COMMAND = `You are in a Volli terminal session. Run \`volli identify\`, then use the bundled \`volli\` CLI as your planning interface. It is self-documenting: \`volli help\` for the full reference, \`volli help <command>\` for details. Follow the volli skill (when installed) for norms.
`;

export const VOLLI_FENCED_INSTRUCTIONS = `You are in a Volli-tracked project / terminal session. Use the bundled \`volli\` CLI as your planning interface for tickets, board moves, comments, and session signals. Run \`volli identify\` first, then read the relevant board or ticket before writing. The CLI is self-documenting: \`volli help\` for the full reference, \`volli help <command>\` for details. If the app is unreachable, run \`volli app launch\` explicitly before retrying; surface every CLI error.`;
