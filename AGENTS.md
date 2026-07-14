# Volli Code — Agent Instructions

Volli Code is a macOS desktop app built with Electron, React, and TypeScript. It merges Linear-style kanban planning with cmux-style embedded terminal agents. A ticket is a terminal workspace: moving it to **Doing** boots a coding agent (Claude Code, Codex, Opencode, or another CLI harness) in an isolated git worktree. The agent lifecycle drives the board and native notifications.

This is a rewrite of the native Swift original at `../volli-swift`; agent-driven development proved slower in SwiftUI than in TypeScript.

## Required context

Read `docs/CONCEPT.md` before making any product or architecture decision. It contains the full concept and settled decision log; do not casually relitigate those decisions.

Use `docs/SWIFT-REFERENCE.md` for the Swift app's feature-parity and data-model reference.

## Structure

- `apps/desktop/src/main/` — Electron main process: node-pty, SQLite, git/worktree execution, the `volli` CLI socket, and notifications. This is the only place Node APIs run.
- `apps/desktop/src/preload/` — the typed `contextBridge` API and the only bridge between renderer and main. Keep it thin and explicit.
- `apps/desktop/src/renderer/` — React UI and Zustand stores. Do not import Node APIs.
- `apps/desktop/scripts/` — Node build and development orchestration.
- `packages/shared/` (`@volli/shared`) — pure, unit-tested domain code: models, ticket state machine, event-log types, and branch/slug rules. Do not import Electron, Node, or DOM APIs. Put all automatic ticket transitions here.

App data lives under Electron's `userData` directory as a fresh start, separate from the Swift app's data. The agent-facing `volli` CLI is planned but not yet built; it will be a separate binary over a Unix socket.

## Conventions

- Keep the ticket state machine and all automatic movement logic pure, tested TypeScript in `@volli/shared`; the UI only observes it.
- Route terminal access through the `TerminalEngine` interface over the preload bridge. `node-pty` never leaves `src/main`; xterm.js never leaves renderer terminal components.
- Name ticket worktree branches `volli/<TICKET-ID>-<slug>`, for example `volli/VC-12-mcp-server`.
- Use a branch, commit, and PR workflow. Never commit directly to `main`.
- Surface every failed mutation to the user with an alert or toast. Never silently swallow errors; this was the Swift app's main systemic defect.
- Keep canonical design tokens in `apps/desktop/src/renderer/src/globals.css` as shadcn-style CSS variables. The app is dark-only for now, with `class="dark"` pinned in `index.html`.
- Keep TypeScript-consumable domain colors, including the project-tile palette, in `@volli/shared`.
- Use ember orange `#E8652A` as the accent and preserve the frosted/dark two-tier sidebar direction.
- Give every context-menu action a neighboring Phosphor icon. Pass the icon through the shared context-menu primitive so it renders with `weight="fill"`; use this same filled Phosphor treatment for new context-menu actions.
- Never incidentally unmount live terminals, including when selecting a card. Keep session state model-resident and views lazy.
- Use strict TypeScript and no `any` at module boundaries.

## Commands

- `pnpm dev` — run the full development loop: renderer HMR, main/preload watch, and Electron auto-relaunch.
- `pnpm run build` then `pnpm start` — build and run the packaged application locally.
- `vp run -r typecheck` — type-check the workspace.
- `vp run -r test` — run workspace tests.
- `vp check` — run `vp fmt` and `vp lint`.
- `act pull_request --container-architecture linux/amd64` — run CI locally before submitting a PR.
- `vp install` or `pnpm install` — install dependencies.
- `pnpm run ensure:electron` from `apps/desktop` — prefetch Electron when needed; its binary is otherwise fetched lazily on first `require("electron")`.

The global `vp` toolchain CLI is used by this repository. Node and pnpm versions are pinned in the root `package.json`.

## Settled stack

The rationale for these decisions lives in `docs/CONCEPT.md`; do not reach for alternatives without reviewing it.

- **Data:** local SQLite via better-sqlite3, WAL mode, owned by the main process. Store transcripts as indexed files on disk. The product is local-first and single-player.
- **Agents:** one worktree per ticket by default, with agent-agnostic command templates and first-class Claude Code, Codex, and Opencode adapters. Agents communicate with the planner through the bundled `volli` CLI, not MCP.
- **Board:** fixed columns Backlog, Todo, Doing, Needs Review, and Done. One primary session per ticket drives automation. Manual moves override stale hook events. Automation never destroys data; archive worktrees instead of deleting them.

## Reference implementations

Check these before inventing a new solution:

- `../volli-swift` — parity reference and currently further along.
- [T3 Code](https://github.com/pingdotgg/t3code) — closest TypeScript/Electron sibling and validation of the stack.
- [cmux](https://github.com/manaflow-ai/cmux) — resume commands, notifications, and socket scriptability.
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban).
- Linear — tracker UX reference.

## Source compatibility

This file is the agent-facing counterpart to `CLAUDE.md`. When project guidance changes, update both files in the same change so they do not drift. `.claude/settings.local.json` contains Claude-specific local permission declarations and should not be copied into this file.
