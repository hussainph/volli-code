# Volli Code

A macOS desktop app (Electron + React + TypeScript) that merges Linear-style kanban planning with cmux-style embedded terminal agents. A ticket *is* a terminal workspace: moving it to **Doing** boots a coding agent (Claude Code / Codex / Opencode / any CLI harness) in an isolated git worktree; the agent's lifecycle drives the board and fires native notifications. Rewrite of the native Swift original at `../volli-swift` (agent-driven dev proved slower in SwiftUI than in TS).

**Read `docs/CONCEPT.md` before any product or architecture decision** — it holds the full concept and the settled decision log (the rationale behind everything here; don't relitigate casually). `docs/SWIFT-REFERENCE.md` is the Swift app's feature-parity and data-model reference.

## Structure

- `apps/desktop/src/main/` — Electron main: node-pty, SQLite, git/worktree execution, the `volli` CLI socket, notifications. **The only place Node APIs run.**
- `apps/desktop/src/preload/` — the typed `contextBridge` API; the only door between renderer and main. Thin and explicit.
- `apps/desktop/src/renderer/` — React UI + Zustand stores. **No Node imports.**
- `apps/desktop/scripts/` — Node build/dev orchestration.
- `packages/shared/` (`@volli/shared`) — pure, unit-tested domain code: models, the ticket state machine, event-log types, branch/slug rules. **No Electron/Node/DOM imports.** Everything that moves tickets automatically lives here.

App data lives under Electron's `userData` dir (a fresh start, not the Swift app's data). The `volli` agent-facing CLI (a separate bin over a Unix socket) is planned, not yet built.

## Conventions

- The ticket state machine and all auto-move logic: pure, tested TypeScript in `@volli/shared`; the UI only observes it.
- Terminal access goes through the `TerminalEngine` interface over the preload bridge — node-pty never leaves `src/main`; xterm.js never leaves the renderer's terminal components.
- Ticket worktree branches: `volli/<TICKET-ID>-<slug>` (e.g. `volli/VC-12-mcp-server`).
- Changes go through a branch + commit + PR flow — never commit directly to `main`.
- Surface every failed mutation to the user (alert/toast); never silently swallow errors — the Swift app's top systemic defect.
- Design tokens (spacing, radii, timing, palette) live in one shared module, not per-component. Accent: ember orange `#E8652A`; frosted/dark two-tier sidebar.
- Live terminals must never be unmounted incidentally (e.g. by selecting a card) — session state model-resident, views lazy.
- Strict TypeScript; no `any` at module boundaries.

## Commands

- `pnpm dev` — full dev loop (renderer HMR + main/preload watch + Electron auto-relaunch). `pnpm run build` then `pnpm start` runs the built app.
- `vp run -r typecheck` · `vp run -r test`; `vp check` (= `vp fmt` + `vp lint`) — the quality stack.
- `vp install` / `pnpm install` for deps — Electron's binary is fetched lazily on first `require("electron")`; `pnpm run ensure:electron` (`apps/desktop`) prefetches it. `vp` is the global toolchain CLI; Node/pnpm are pinned in the root `package.json`.

## Settled stack (rationale in CONCEPT.md — don't reach for alternatives)

- **Data**: local SQLite (better-sqlite3, WAL, main-process-owned); transcripts as indexed files on disk. Local-first, single-player.
- **Agents**: worktree-per-ticket by default; agent-agnostic command templates with first-class Claude Code / Codex / Opencode adapters; agents reach the planner via the bundled `volli` CLI, **not MCP**.
- **Board**: fixed columns Backlog · Todo · Doing · Needs Review · Done; one *primary* session per ticket drives automation. Manual moves win over stale hook events; automation never destroys data (worktrees are archived, not deleted).

## Reference implementations

Check how these solved a problem before inventing one: **`../volli-swift`** (parity reference, further along) · **[T3 Code](https://github.com/pingdotgg/t3code)** (closest TS/Electron sibling — validated the stack) · **[cmux](https://github.com/manaflow-ai/cmux)** (resume commands, notifications, socket scriptability) · **[Vibe Kanban](https://github.com/BloopAI/vibe-kanban)** · **Linear** (tracker UX).
