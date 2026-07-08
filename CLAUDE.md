# What this is

**Volli Code** — a desktop app that merges project planning (Linear-style kanban) with terminal-agent execution (cmux-style embedded terminals). Every ticket is both a unit of planning *and* a live terminal workspace: moving a ticket to **Doing** boots a coding agent (Claude Code, Codex, Opencode, or any CLI harness) in an isolated git worktree, with the ticket's title/description/attachments composed into the starting prompt. Agent lifecycle events move the ticket across the board and fire native notifications. Over time each project accumulates an auditable history of every agent session run against it.

This repo is the **Electron + React + TypeScript rewrite** of the native Swift original at `../volli-swift`. The product is unchanged; the platform switched because agent-driven development in SwiftUI proved much slower than in TS. The full product concept, decision log, and v1 roadmap live in `docs/CONCEPT.md` — read it before making product or architecture decisions. `docs/SWIFT-REFERENCE.md` records what the Swift app had built (the near-term parity target), its data formats, and its design lessons.

**Status: M0 scaffold.** electron-vite + React + TS hello-world window; remote is `github.com/hussainph/volli-code`. Next, in order: restructure into the pnpm + Vite+ monorepo (decision 25 in `docs/CONCEPT.md`), then the terminal spike (xterm.js + node-pty). Nothing else is built.

## Locked architecture decisions

Decided deliberately with the owner — do not relitigate them casually (rationale in `docs/CONCEPT.md`):

1. **Electron + React + TypeScript**, macOS-only v1. Zustand for renderer state; electron-builder for packaging (when packaging matters). Build tooling is electron-vite today, but the repo restructures into a **pnpm + Vite+ (`vp`) monorepo** — the Electron app as a single app inside the workspace — **before feature work begins**: a mobile client is a live option, and retrofitting a monorepo under a grown app is the expensive direction (decision 25; T3 Code ships this exact layout).
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

- `src/main/` — Electron main process: window management, PTY host (node-pty), SQLite, git/worktree execution, the `volli` CLI socket, notifications. The only place Node APIs run.
- `src/preload/` — the typed `contextBridge` API: the only door between renderer and main. Keep it thin and explicit.
- `src/renderer/` — React UI (project rail, board, ticket detail, terminal panes) and Zustand stores. No Node imports.
- `src/shared/` — pure domain code: models, the ticket state machine, event-log types, branch/slug rules. No Electron, Node, or DOM imports; fully unit-tested. Everything that moves tickets automatically lives here.

Planned, not yet built: the `volli` agent-facing CLI as a separate bin talking to the main process over a Unix socket.

App data lives under Electron's `userData` dir — a deliberate fresh start, NOT sharing the Swift app's `~/Library/Application Support/VolliCode/` (that schema is documented in `docs/SWIFT-REFERENCE.md` if an import is ever wanted).

## Commands

- `npm install` — note: our `postinstall` runs `node node_modules/electron/install.js` deliberately; Electron ≥43 no longer downloads its binary on install (it fetches lazily on first `require('electron')`), but electron-vite reads `node_modules/electron/path.txt` directly and fails if the binary was never fetched. Don't remove the postinstall.
- `npm run dev` — electron-vite dev with HMR (main/preload rebuild + renderer HMR)
- `npm run build` — production build to `out/`
- `npm run typecheck` — tsc over node (main/preload) and web (renderer) configs
- `npm start` — run the built app (electron-vite preview)

## Conventions

- The ticket state machine and everything that moves tickets automatically must be pure, tested TypeScript in `src/shared`; UI observes it.
- All terminal access goes through the `TerminalEngine` interface over the preload bridge — never import node-pty outside `src/main`; xterm.js stays inside the renderer's terminal components.
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
