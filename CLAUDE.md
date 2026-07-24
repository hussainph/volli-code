# Volli Code

A macOS desktop app (Electron + React + TypeScript) merging Linear-style kanban planning with cmux-style embedded terminal agents. A ticket *is* a terminal workspace: moving it to **Doing** boots a coding agent (Claude Code / Codex / Opencode / any CLI harness) in an isolated git worktree; the agent's lifecycle drives the board and fires native notifications. Rewrite of the native Swift original at `../volli-swift` (SwiftUI proved slower for agent-driven dev than TS).

**Read `docs/CONCEPT.md` before any product/architecture decision** — the full concept + settled decision log (don't relitigate casually). `CONTEXT.md` (root) is the domain glossary — use its terms. `docs/DESIGN.md` owns spacing/type; `docs/SWIFT-REFERENCE.md` is the Swift parity/data-model reference.

## Structure

- `apps/desktop/src/main/` — Electron main: node-pty, SQLite, git/worktree exec, the `volli` CLI socket, notifications. **The only place Node APIs run.**
- `apps/desktop/src/preload/` — the typed `contextBridge` API; the only door between renderer and main. Thin and explicit.
- `apps/desktop/src/renderer/` — React UI + Zustand stores. **No Node imports.**
- `packages/shared/` (`@volli/shared`) — pure, unit-tested domain code (models, ticket state machine, event-log types, branch/slug rules). **No Electron/Node/DOM imports.** All automatic ticket-movement logic lives here.
- `packages/cli/` — the agent-facing `volli` CLI (built; Unix socket to main). App data lives under Electron's `userData` dir.

## Conventions

- Ticket state machine + all auto-move logic: pure, tested TS in `@volli/shared`; the UI only observes it.
- Terminal access goes through the `TerminalEngine` seam: node-pty never leaves `src/main`, restty (ghostty-derived WebGPU renderer, decision #26) never leaves the renderer's terminal components. Native modules (node-pty, better-sqlite3) need `pnpm -C apps/desktop run rebuild:native` after every install (Electron ABI).
- Domain data lives in SQLite at `<userData>/volli.db` behind `src/main/db`; renderer stores hydrate at boot and write through semantic preload commands (`api.projects` / `api.tickets` / …). No renderer-side persistence, no localStorage.
- Live terminals must never be unmounted incidentally (e.g. selecting a card) — session state is model-resident, views lazy.
- Design tokens live only in `apps/desktop/src/renderer/src/globals.css` (shadcn CSS variables; dark-only, `class="dark"` pinned); TS-consumable domain colors (project-tile palette) live in `@volli/shared`. Accent: ember `#E8652A`. Spacing/width/type follow `docs/DESIGN.md` (decision #31: six-step type scale, no arbitrary `text-[Npx]`; `<ContentColumn>` for Tier-A reading surfaces, `gutter` token for Tier-B workbench edges).
- Every context-menu action carries a neighboring Phosphor icon (`weight="fill"`) via the shared context-menu primitive.
- Surface every failed mutation (alert/toast) — never silently swallow errors (the Swift app's top systemic defect).
- Ticket worktree branches: `volli/<TICKET-ID>-<slug>` (e.g. `volli/VC-12-mcp-server`).
- Changes go through branch + commit + PR — never commit directly to `main`. Strict TypeScript; no `any` at module boundaries.

## Commands

- `pnpm dev` — full dev loop (renderer HMR + main/preload watch + Electron auto-relaunch). `pnpm run build` then `pnpm start` runs the built app.
- `vp run -r typecheck` · `vp run -r test` · `vp check` (= `vp fmt` + `vp lint`) — the quality stack. `vp` is the global toolchain CLI (Node/pnpm pinned in root `package.json`).
- `vp install` / `pnpm install` for deps; `pnpm run ensure:electron` (`apps/desktop`) prefetches Electron's lazily-fetched binary.
- CI: PRs run one lean Linux job and must be green before shipping. **Desktop e2e smokes (`apps/desktop/e2e/*.mjs`) do NOT run in CI — run the relevant ones locally before shipping any desktop-touching PR.** The macOS smoke lane is manual-only (`gh workflow run ci.yml -f desktop-smoke=true`); `act pull_request --container-architecture linux/amd64` mirrors the Linux job locally.

## Settled stack (rationale in CONCEPT.md — don't reach for alternatives)

- **Data**: local SQLite (better-sqlite3, WAL, main-process-owned); transcripts as indexed files on disk. Local-first, single-player.
- **Agents**: worktree-per-ticket; agent-agnostic command templates with first-class Claude Code / Codex / Opencode adapters; agents reach the planner via the bundled `volli` CLI, **not MCP**.
- **Board**: fixed columns Backlog · Todo · Doing · Needs Review · Done. Manual moves win over stale hook events; automation only ever de-escalates (interrupt / park / archive-on-TTL) and never destroys data (worktrees are retained, never force-deleted while dirty).

## Reference implementations

Check how these solved a problem before inventing one: **`../volli-swift`** (parity reference) · **[T3 Code](https://github.com/pingdotgg/t3code)** (closest TS/Electron sibling — validated the stack) · **[cmux](https://github.com/manaflow-ai/cmux)** (resume commands, notifications, socket scriptability) · **[Vibe Kanban](https://github.com/BloopAI/vibe-kanban)** · **Linear** (tracker UX).
