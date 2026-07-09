# What this is

**Volli Code** — a desktop app that merges project planning (Linear-style kanban) with terminal-agent execution (cmux-style embedded terminals). Every ticket is both a unit of planning *and* a live terminal workspace: moving a ticket to **Doing** boots a coding agent (Claude Code, Codex, Opencode, or any CLI harness) in an isolated git worktree, with the ticket's title/description/attachments composed into the starting prompt. Agent lifecycle events move the ticket across the board and fire native notifications. Over time each project accumulates an auditable history of every agent session run against it.

This repo is the **Electron + React + TypeScript rewrite** of the native Swift original at `../volli-swift`. The product is unchanged; the platform switched because agent-driven development in SwiftUI proved much slower than in TS. The full product concept, decision log, and v1 roadmap live in `docs/CONCEPT.md` — read it before making product or architecture decisions. `docs/SWIFT-REFERENCE.md` records what the Swift app had built (the near-term parity target), its data formats, and its design lessons.

**Status: M0 scaffold, monorepo restructure complete.** The pnpm + Vite+ (`vp`) monorepo (decision 25 in `docs/CONCEPT.md`) is in place: a React + TS hello-world Electron window builds and runs from `apps/desktop`, `packages/shared` (`@volli/shared`) holds the first pure-domain code (branch/slug rules) with passing tests, and the `vp` quality stack (lint/fmt/test) plus CI are wired. Remote is `github.com/hussainph/volli-code`. Next: the terminal spike (xterm.js + node-pty). Nothing else is built.

## Locked architecture decisions

Decided deliberately with the owner — do not relitigate them casually (rationale in `docs/CONCEPT.md`):

1. **Electron + React + TypeScript**, macOS-only v1. Zustand for renderer state; electron-builder for packaging (when packaging matters). The repo **is** a pnpm + Vite+ (`vp`) monorepo — the Electron app (`apps/desktop`) as a single app inside the workspace (decision 25, executed): a mobile client is a live option, and retrofitting a monorepo under a grown app is the expensive direction (T3 Code ships this exact layout).
2. **Terminal: xterm.js in the renderer, node-pty in the main process** (`@xterm/xterm` + fit/WebGL addons), wired over IPC behind a `TerminalEngine` interface. Renderer code never touches node-pty; main-process code never reaches into xterm. Same lesson as the original's Ghostty decision: agent TUIs need real terminal emulation, and the engine stays swappable behind the interface.
3. **Local SQLite** (better-sqlite3, WAL, owned by the main process) for all data (tickets, sessions, events). Local-first, single-player v1; Convex is a candidate future sync layer, not a v1 concern. Session transcripts stored as files on disk, indexed in SQLite.
4. **Worktree-per-ticket by default.** Moving a ticket to Doing creates a git worktree + branch for it; a per-ticket toggle allows running in the main checkout instead.
5. **Agent-agnostic core, first-class adapters.** The core abstraction is a command template (bring your own harness). Claude Code, Codex, and Opencode get first-class adapters: hook wiring, resume commands, transcript capture.
6. **Agents talk to the planning layer via a bundled CLI** (`volli`) on PATH — e.g. `volli ticket move --to review`, `volli comment`. Harness hooks (Claude Code Stop/Notification hooks etc.) call the same CLI. No MCP server.
7. **Primary session + splits.** Each ticket has one *primary* agent terminal whose lifecycle drives the board, plus cmux-style additional tabs/splits (shells, logs, second agents).
8. **Full lifecycle automation**: Doing → auto-launch agent; agent events → auto-move to Needs Review + native notification; Done → offer branch push + PR creation.
9. **Sessions are app-lifetime; restarts use resume commands** (`claude --resume` etc.), the cmux pattern — persist layout + working dir + resume command, not live PTYs. A daemon that owns PTYs is a possible future, not v1.
10. **Fixed semantic columns** in v1: Backlog · Todo · Doing · Needs Review · Done. Each has baked-in behavior. Customizable SDLC layouts are a future consideration.
11. **Standalone tracker** — this app replaces Linear for the owner's projects; no Linear integration in v1.
12. **Symmetric lifecycle moves.** Primary agent stops *or* blocks (permission/question) → Needs Review with a reason badge; new primary-session activity → back to Doing. Needs Review always means "blocked on a human". Notifications suppressed while the ticket's terminal is focused.
13. **Manual moves win.** Backward moves interrupt the primary session (Esc-equivalent), never kill terminals; hook events arriving right after a manual move are stale. Re-entering Doing resumes the prior session by default.
14. **Agent commits its own work** (taught via the brief); the Done flow catches dirty worktrees with a one-click commit offer before push/PR. The app never commits behind the user's back.
15. **Worktree prep**: per-project setup command + copy-globs for gitignored files (`.env*` etc.), run visibly in the primary terminal. Attachments are materialized into a gitignored `.volli/attachments/` dir and listed by path in the brief.
16. **Nothing destroyed by automation.** Worktrees are cleaned on PR merge (or Done-TTL) via a prompt; cleaned tickets move to a per-project Archive retaining event log, transcripts, branch, PR link. Only explicit deletion from the Archive destroys data.
17. **Scratch sessions**: per-project ticket-less sessions (main checkout, no board involvement), recorded in the same session history, promotable to tickets. Hook automation is wired to the primary session only, but explicit `volli` CLI commands work from any pane.

## Structure

- `apps/desktop/src/main/` — Electron main process: window management, PTY host (node-pty), SQLite, git/worktree execution, the `volli` CLI socket, notifications. The only place Node APIs run.
- `apps/desktop/src/preload/` — the typed `contextBridge` API: the only door between renderer and main. Keep it thin and explicit.
- `apps/desktop/src/renderer/` — React UI (project rail, board, ticket detail, terminal panes) and Zustand stores. No Node imports.
- `apps/desktop/scripts/` — Node build/dev orchestration: the dev loop (`dev.mjs`) and the Electron-binary/lifecycle helpers (`ensure-electron.mjs`, `dev-electron.mjs`, `start-electron.mjs`, `wait-for-resources.mjs`). Not renderer or main code.
- `packages/shared/` (`@volli/shared`) — pure domain code: models, the ticket state machine, event-log types, branch/slug rules. No Electron, Node, or DOM imports; fully unit-tested. Everything that moves tickets automatically lives here. (Replaces the old planned `src/shared`.)
- Root `vite.config.ts` owns the cross-cutting `vp` quality stack (test / fmt / lint / staged); `tsconfig.base.json` holds the shared strict-TS compiler options every package's tsconfig extends.

Planned, not yet built: the `volli` agent-facing CLI as a separate bin talking to the main process over a Unix socket.

App data lives under Electron's `userData` dir — a deliberate fresh start, NOT sharing the Swift app's `~/Library/Application Support/VolliCode/` (that schema is documented in `docs/SWIFT-REFERENCE.md` if an import is ever wanted).

## Commands

- `vp install` (or `pnpm install`) — install workspace deps. NOTE: Electron ≥43 ships **no** lifecycle install scripts (pre-43 it fetched its binary on install); instead `apps/desktop/scripts/ensure-electron.mjs` fetches the ~100MB Electron binary on demand — auto-run by `dev`, `start`, and CI, so the first run downloads it.
- `pnpm dev` — full dev loop: renderer dev server (HMR) + `vp pack --watch` (main/preload) + Electron auto-relaunch on every main/preload rebuild.
- `pnpm run build` — production build: renderer → `apps/desktop/dist`, main/preload (CJS) → `apps/desktop/dist-electron`.
- `pnpm start` — run the built app.
- `vp run -r typecheck` · `vp run -r test` — typecheck / test every package. `vp lint` · `vp fmt` · `vp check` (= fmt + lint) — the quality stack.
- `vp` is the global toolchain CLI (install: `curl -fsSL https://vite.plus | bash`); Node and pnpm are pinned via `engines` / `packageManager` in the root `package.json`.

## Conventions

- The ticket state machine and everything that moves tickets automatically must be pure, tested TypeScript in `packages/shared` (`@volli/shared`); UI observes it.
- All terminal access goes through the `TerminalEngine` interface over the preload bridge — never import node-pty outside `apps/desktop/src/main`; xterm.js stays inside the renderer's terminal components.
- Branch naming for ticket worktrees: `volli/<TICKET-ID>-<slug>` (e.g. `volli/VC-12-mcp-server`).
- All changes from a session go through a branch + commit + PR flow — never commit directly to `main`.
- Surface every failed mutation to the user (alert/toast); never silently swallow errors — the Swift app's top systemic defect.
- Design tokens (spacing, radii, timing, palette) live in one shared module, not per-component. Accent: ember orange `#E8652A`; frosted/dark two-tier sidebar aesthetic.
- Live terminals must never be unmounted incidentally (e.g. by selecting a card) — keep session state model-resident, views lazy.
- Strict TypeScript; no `any` at module boundaries.

## Reference implementations

When solving a problem these already solved, check how they did it first:

- **The Swift original** (`../volli-swift`) — same product, one milestone ahead: working tracker UI + terminal spike. `docs/SWIFT-REFERENCE.md` indexes it; read its source for exact behaviors (rail reorder, panel grip, board interactions).
- **T3 Code** ([pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT) — the closest TS/Electron sibling: a GUI over coding-agent CLIs with worktree-per-thread isolation. Independently landed on Electron + electron-builder + xterm.js + node-pty + SQLite + Zustand, which validates our stack. Borrowable patterns: provider-adapter layer per harness, per-turn checkpoints as hidden git refs, `@dnd-kit` for board drag-drop, and its thin-Electron-shell-over-local-server split (our parked daemon idea, decision 9 — they prove it works, we still defer it).
- **cmux** ([manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)) — session restore via resume commands, OSC 9/777 + CLI notifications, Unix-socket scriptability, split-pane management.
- **Vibe Kanban** ([BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)) — kanban-for-agents product shape: worktree-per-task, statuses driven by what the agent is actually doing.
- **Linear** — UX source of truth for the tracker surface (board interactions, ticket detail, keyboard-first flows).
