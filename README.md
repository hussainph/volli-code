# Volli Code (Electron)

Kanban planning + terminal-agent execution in one desktop app: every ticket is both a unit of planning and a live terminal workspace. Electron + React + TypeScript rewrite of the native Swift original (`../volli-swift`).

- Product concept, decision log, roadmap: [`docs/CONCEPT.md`](docs/CONCEPT.md)
- What the Swift original had built (parity target): [`docs/SWIFT-REFERENCE.md`](docs/SWIFT-REFERENCE.md)
- Agent operating manual: [`CLAUDE.md`](CLAUDE.md)

## Prerequisites

- **Node** `^24.13` and **pnpm 11** — run `corepack enable` to pick up the pinned versions (`engines` / `packageManager` in `package.json`).
- Optionally the global **Vite+ (`vp`)** CLI, which wraps pnpm plus the build and quality toolchain: `curl -fsSL https://vite.plus | bash`.

## Develop

```
pnpm install   # or: vp install
pnpm dev       # renderer HMR + Electron, auto-relaunch on main/preload changes
```

First run downloads the ~100MB Electron binary (Electron ≥43 no longer fetches it on install); it is cached afterward.

## Build

```
pnpm run build   # renderer → apps/desktop/dist, main/preload → apps/desktop/dist-electron
pnpm start       # run the built app
```
