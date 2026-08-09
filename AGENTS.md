# Volli Code — Agent Instructions

Volli Code is a local-first macOS workspace for planning and running coding sessions, built with Electron, React, and TypeScript. The current app combines a Linear-style board, isolated ticket worktrees, durable local history, Pi-backed structured chat, and embedded terminal harnesses. The product direction is one chat-first, Pi-backed Agent Runtime; external and bring-your-own TUI harnesses remain manual terminal companions, not structured execution surfaces.

## Required context

Use `CONTEXT.md` for canonical domain language and `docs/DESIGN.md` for the living visual language. The code and tests are authoritative for current behavior. Treat future architecture described here as direction, not as already-implemented behavior.

## Structure

- `apps/desktop/src/main/` — Electron main process: SQLite, Pi runtime hosting, node-pty, git/worktree execution, the `volli` CLI socket, and notifications. This is the only place Electron APIs run.
- `apps/desktop/src/preload/` — the typed `contextBridge` API and the only bridge between renderer and main. Keep it thin and explicit.
- `apps/desktop/src/renderer/` — React UI and Zustand stores. UI state is a projection of durable main-process state plus ephemeral view state. Do not import Node APIs.
- `apps/desktop/scripts/` — Node build and development orchestration.
- `packages/shared/` (`@volli/shared`) — pure, unit-tested domain code: models, ticket rules, event types, Session semantics, and branch/slug rules. Do not import Electron, Node, or DOM APIs.
- `packages/session-engine/` (`@volli/session-engine`) — plain TypeScript Session commands, durable projections, temporary native-executor migration contracts, committed stream coordination, and AI SDK transcript vocabulary. It owns no transport or Node APIs.
- `packages/session-rpc/` (`@volli/session-rpc`) — the thin tRPC edge for Session clients and sanitized diagnostics.
- `apps/desktop/src/renderer/lab/` — the UI lab (`pnpm lab`): browser-only scratches for trying interactions against real components and tokens with fixture data, before they become app features. Dev-server only, never built; it imports the app, never the reverse.

App data lives under Electron's `userData` directory. The agent-facing `volli` CLI communicates with main over a Unix socket.

## Architecture direction

- A Session is durable and owns identity and ordered local history before any live executor attaches. The temporary native-adapter contract, processes, terminal panes, and UI views never own Session lifetime.
- Commands are explicit user intent. Persist intent before delivery; make acceptance idempotent and observable through durable receipts.
- Events are immutable facts. Local durable history is canonical; renderer stores project it into UI state and structured attention.
- The structured product has one target executor: `@volli/agent-runtime`, initially backed by Pi. Do not introduce SDK/ACP adapters, structured executor selection, capability parity work, or new provider-shaped product semantics.
- Keep resume, terminal recreation, and history navigation as distinct semantics.
- Retry transient transport failures without duplicating accepted work. Authentication, permissions, configuration, and quota failures require explicit user recovery.
- Existing hooks and terminal markers are compatibility evidence for TUI adapters, not the canonical source of Session truth.
- A Session starts with one root Agent Thread. Each Thread has at most one live Thread Binding; Conversation Branches and Generation Attempts preserve edits and regeneration without rewriting history.
- `adapterId` and profile fields are executor-registry machinery, not product architecture: Pi is the one structured executor. Terminals are explicit manual companions and never silent structured fallbacks.

## Conventions

- Keep ticket rules and automatic movement logic pure, tested TypeScript in `@volli/shared`; the UI only observes it.
- Route terminal access through the `TerminalEngine` interface over the preload bridge. `node-pty` never leaves `src/main`; restty never leaves renderer terminal components.
- Name ticket worktree branches `volli/<DISPLAY-ID>-<slug>`, for example `volli/VC-12-mcp-server`.
- Use a branch, commit, and PR workflow. Never commit directly to `main`.
- Surface every failed mutation to the user with an alert or toast. Never silently swallow errors.
- Keep canonical design tokens in `apps/desktop/src/renderer/src/globals.css` as shadcn-style CSS variables. The color ones are **generated, never hand-authored**: a scope stores a canvas, the token set is derived from it at render time, and the two blocks between the BEGIN/END markers (`:root, :root.dark` and `:root.light`) are regenerated together with `node apps/desktop/scripts/generate-theme-css.mjs`. The app is not dark-only and `class="dark"` is not pinned — appearance resolves to light, dark or the system's choice, and preload stamps the resolved mode before the first frame.
- Keep TypeScript-consumable domain colors, including the project-tile palette, in `@volli/shared`.
- Use ember orange `#E8652A` as the accent and preserve the frosted/dark two-tier sidebar direction.
- Give every context-menu action a neighboring Phosphor icon. Pass the icon through the shared context-menu primitive so it renders with `weight="fill"`; use this same filled Phosphor treatment for new context-menu actions.
- Never incidentally unmount live terminals, including when selecting a card. Keep session state model-resident and views lazy.
- **UI copy: let controls talk.** Settings and editors are not onboarding wizards. Do not add `description` on `SettingsSection`/`SettingsRow`, tutorial tooltips, or paragraphs under controls unless the user asked. Labels are nouns; the control is the explanation (pad, slider, segmented pill, origin chip). Rare exceptions only: irreversible confirms, one-line trust boundaries (e.g. Ghostty), blocked states with one recovery action. Module comments carry architecture; UI strings do not repeat them. Reference: Linear, Arc, macOS System Settings.
- Use strict TypeScript and no `any` at module boundaries.

## Commands

- `pnpm dev` — run the full development loop: renderer HMR, main/preload watch, and Electron auto-relaunch.
- `pnpm lab` — serve the UI lab on port 5174, alongside `pnpm dev`. Add an idea by dropping one file into `apps/desktop/src/renderer/lab/scratches/`.
- `pnpm run build` then `pnpm start` — build and run the packaged application locally.
- `vp run -r typecheck` — type-check the workspace.
- `vp run -r test` — run workspace tests.
- `vp run -r test:coverage` — a separate gate that CI enforces, holding `packages/shared` and a protected renderer surface at 100%. Thresholds only evaluate under `--coverage`, so a green `vp run -r test` says nothing about coverage. Run it before pushing anything that adds a branch or a store action.
- `vp check` — run `vp fmt` and `vp lint`.
- `act pull_request --container-architecture linux/amd64` — run CI locally before submitting a PR.
- Ensure all PRs pass CI/CD checks before shipping.
- `vp install` or `pnpm install` — install dependencies.
- `pnpm run ensure:electron` from `apps/desktop` — prefetch Electron when needed; its binary is otherwise fetched lazily on first `require("electron")`.

The global `vp` toolchain CLI is used by this repository. Node and pnpm versions are pinned in the root `package.json`.

## Retained foundations

- **Data:** local SQLite via better-sqlite3, WAL mode, owned by the main process. Store transcripts as indexed files on disk. The product is local-first and single-player.
- **Terminal companions:** preserve the manifest registry, exact-hash trust, launch configuration, wrappers, hooks, CLI correlation, and honest terminal resume where they continue to improve manual terminal use. Preserve no generic structured-adapter machinery merely for future plurality.
- **Execution:** one worktree per ticket by default. Terminal wrappers and hooks remain compatibility mechanisms for TUI harnesses.
- **Board:** fixed columns Backlog, Todo, Doing, Needs Review, and Done. Explicit moves win over stale lifecycle evidence. Automation never destroys data; archive worktrees instead of deleting them.

## Reference implementations

Check these before inventing a new solution:

- [T3 Code](https://github.com/pingdotgg/t3code) — closest TypeScript/Electron sibling and validation of the stack.
- [cmux](https://github.com/manaflow-ai/cmux) — resume commands, notifications, and socket scriptability.
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban).
- Linear — tracker UX reference.

## Source compatibility

This file is the agent-facing counterpart to `CLAUDE.md`. When project guidance changes, update both files in the same change so they do not drift. `.claude/settings.local.json` contains Claude-specific local permission declarations and should not be copied into this file.
