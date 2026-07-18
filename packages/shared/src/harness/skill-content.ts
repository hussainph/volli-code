export const VOLLI_SKILL = `---
name: volli
description: Coordinates Volli planning, tickets, and terminal sessions through the bundled CLI. Use when working in a Volli-tracked project or a Volli terminal session.
---

# Volli

Use the bundled \`volli\` CLI as the planning interface. Start with \`volli identify\`, then read the relevant board or ticket before writing.

- Read [cli.md](cli.md) for commands and examples.
- Read [orchestration.md](orchestration.md) before coordinating multiple tickets or sessions.
- Treat files under \`custom/\` as user-owned extensions when present.

If the app is unreachable, run \`volli app launch\` explicitly and retry. Surface every CLI error; never silently continue after a failed mutation.
`;

export const VOLLI_CLI_REFERENCE = `# Volli CLI

Run \`volli identify\` first. Add \`--json\` to any command for structured output.

## Read

\`volli board [--project <name|prefix|path>]\`
\`volli ticket list [--status doing] [--label bug] [--priority high]\`
\`volli ticket show VC-12 [--events 5] [--comments 5]\`
\`volli ticket events VC-12\`
\`volli project list\`
\`volli label list\`
\`volli session list [--ticket VC-12]\`
\`volli session peek abcdef12 [--lines 60]\`

## Write

\`volli ticket create --title "Fix auth" --label bug\`
\`volli ticket update VC-12 --edit "old" "new"\`
\`volli ticket update VC-12 --append "## Findings"\`
\`volli ticket move VC-12 --to needs-review\`
\`volli ticket comment VC-12 -m "Ready for review"\`
\`volli ticket archive VC-12\`
\`volli session done --reason "Tests pass"\`
\`volli session blocked --reason "Needs credentials"\`
\`volli notify -m "Needs input"\`

Ticket handles are display ids only. Session handles are the short ids printed by \`session list\`. Context resolves by explicit flag, then Volli environment, then current directory; ambiguity is an error.
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

export const VOLLI_OPENCODE_COMMAND = `Load the volli skill, run \`volli identify\`, and follow the relevant CLI and orchestration guidance for this project.
`;

export const VOLLI_FENCED_INSTRUCTIONS = `When working in a Volli-tracked project, run \`volli identify\` first. Read the relevant board or ticket before writing. Use display ticket ids and short session ids only. If the app is unreachable, run \`volli app launch\` explicitly before retrying.`;
