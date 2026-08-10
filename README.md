# Volli Code

**A local-first workspace for planning and running coding sessions.**

Volli Code brings tickets, isolated worktrees, coding harnesses, and local history into one macOS app.

> [!NOTE]
> Volli Code is under active development. The current app is terminal-first; the planned architecture is a chat-first Session UI backed by a Pi-backed `@volli/agent-runtime`, with external and bring-your-own TUI harnesses retained as manual terminal companions rather than a structured fallback.

![Volli Code kanban board](docs/assets/volli-code-board.png)

## What works today

- A local SQLite-backed tracker with tickets, comments, activity, labels, and project settings.
- Isolated ticket worktrees, Change Sets, publishing flows, and project file editing.
- Embedded terminal sessions with tabs, splits, history, interruption, parking, and harness-specific resume support.
- A capability-aware harness registry with exact-manifest trust, launch configuration, wrapper generation, hook evidence, and custom TUI adapters.
- The bundled `volli` CLI for explicit ticket, session, notification, and diagnostic commands.

## Where it is going

The target Session model is durable independently of any live executor. A Session will own its local ordered event history before the Pi-backed `@volli/agent-runtime` attaches; external and bring-your-own TUI harnesses run only as manual terminal companions, never a structured fallback pretending to have feature parity.

That redesign still needs an immutable Session event ledger, idempotent command delivery and receipts, retry reconciliation, and structured attention states. The existing terminal infrastructure remains useful compatibility machinery, but it is not the future source of Session truth.

## Development

Volli Code currently targets macOS and requires Node `^24.13` and pnpm 11.

```bash
pnpm install
pnpm dev
```

Build and run the production bundle locally:

```bash
pnpm run build
pnpm start
```

Run the quality checks:

```bash
vp run -r typecheck
vp run -r test
vp check
```

Canonical domain language lives in [`CONTEXT.md`](CONTEXT.md); the living visual language lives in [`docs/DESIGN.md`](docs/DESIGN.md).
