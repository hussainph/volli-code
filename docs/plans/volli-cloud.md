# Volli Cloud: one host, many clients

**Status:** ruling, VC-486 (2026-10-03). Direction for 0.3.0. Nothing here is built yet.
**Owner decision:** build this behind the `cloud` experimental flag on `main`, shipping 0.2.x in parallel.
**Companion:** `docs/plans/volli-cloud-orchestration.md` (how the work is run).

## The goal

You start a session, close the lid, and come back four hours later to a finished session. That works the same for a ticket session and a board session, from the desktop app or a phone. Running on your Mac, on your own box, or in a Volli-managed sandbox looks and feels the same; the only difference you see is a clear label of where it runs. Plain local Volli keeps working offline and keeps feeling exactly like it does today.

## The architecture

Volli becomes a client–server product. The server is one program, and it runs everywhere.

| Role | What it owns | Notes |
|---|---|---|
| **Host** | The single authority for a workspace: board, tickets, comments, labels, session ledger, automations, attention, verb dispatch, approvals. SQLite. Serves the host protocol. | Headless Node, no Electron. Every board write is one write on one machine: no queues, no copies, no reconciliation. |
| **Worker** | Execution: the agent loop, worktrees, terminals, MCP servers, Chromium. | Same binary, different role. Connects **outbound** to its host, so a laptop, a box and a sandbox join the same way and none needs inbound networking. |
| **Client** | Nothing durable. Reads projections, sends commands. | Desktop app, web/phone client, CLI. All speak only the host protocol. |

Electron main shrinks to window-only features: the native browser view, menus, clipboard, reveal-in-Finder, auto-update. The desktop app connects to its local host the same way it connects to a remote one, so daily local use exercises the remote path.

### Deployments (same code)

| Mode | Host | Workers | License |
|---|---|---|---|
| **Local** (default) | Your Mac, started by the app | Your Mac | Open source |
| **Self-hosted** | Your box, reached over Tailscale or any HTTPS | The box and your laptop | Open source |
| **Volli Cloud** | Volli runs one host per workspace | Zero-config sandboxes and your laptop | Paid; control plane is closed |

## Rulings

1. **One authority per workspace, never sync.** Multi-writer board state (queued comments, offline ticket moves, reconciled snapshots) is rejected. Agents coordinate through the board in real time, so the board must have one always-reachable writer. The cost is availability: if a remote host is down, its workspace is read-only until it returns or you move the workspace.
2. **The desktop always talks to a host, even on the same Mac.** One composition root, one protocol. Revisit only on a measured streaming-latency regression over loopback.
3. **The agent loop runs on the worker.** A loop on the client dies when the lid closes. Never route remote tool calls back to the Mac.
4. **A ticket's checkout belongs to one worker at a time.** The host grants a lease with an epoch. Moving a ticket = stop writes → commit working state to a checkpoint ref → bump the epoch → restore on the destination. Old-epoch writes are refused. Version 1 promises transcript and uncommitted files; dependencies are rebuilt; live processes and browser sockets do not migrate. "Fork to another machine" is a later feature.
5. **One SQLite file per workspace, plus a host-level database.** A workspace is one portable unit: its database file, its artifacts, its git refs. The host streams a WAL-level replica (Litestream-style) to targets you choose (your Mac, S3).
6. **Moving a workspace is a fenced promotion.** "Move workspace to This Mac / hetzner-2 / Volli Cloud" restores the replica and raises the ownership epoch; the old host is refused by every client and worker. Failover can lose the last unreplicated seconds; that tail is quarantined for inspection, never merged. This is the answer to outages and to "I stopped paying for the box".
7. **Convex runs the control plane only, never the board.** Accounts, billing, provisioning, the workspace and device registry, push delivery. Putting the board in Convex would mean two implementations of the authority or giving up local-first.
8. **The agent browser survives.** Agent tools already speak CDP through the injected `CdpTransport` (`apps/desktop/src/main/browser/cdp-controller.ts`). On a worker it points at standalone Chromium; the person watches through `Page.startScreencast` in the existing browser pane and co-drives through the existing browser hold. A virtual desktop stream (labwc + Waymote, as Amp does) is the later upgrade for native dialogs and logins. "Watch agent browser" and "Preview app" (forwarded dev-server ports, like Amp Portals) are separate features.
9. **Open-source boundary.** Host, worker, clients, protocol, pairing, checkpoint refs and workspace moves are open source. The control plane lives in a private `volli-cloud` repo and depends only on the public host protocol. If it needs a hook, the hook goes into the public protocol.
10. **Multiplayer falls out of one authority.** Membership, per-actor capabilities (VC-92's model) and presence over the host protocol. The relay in `docs/BOUNDARIES.md` "The chosen path" is no longer needed for single-host workspaces.

## How we build it

- **Trunk-based, behind one flag.** Every ticket is one PR that lands green on `main`. With the `cloud` flag off, behavior is unchanged; the core e2e suite proves it on every PR.
- **New code beside old code.** `packages/host-core` (services, no Electron), `packages/host-protocol` (versioned, capability-negotiated), `apps/hostd` (the headless binary). Each IPC area moves in its own ticket; the old path is deleted when its area moves (BOUNDARIES rule 5, applied deliberately).
- **Database changes are expand → switch → contract.** Additive migrations first, dual-write, read switch behind the flag, removal of the old layout in 0.3.0. Every migration is checked against a copy of a real profile database.
- **Short integration branches only for real cutovers** (the per-workspace database cutover, the always-through-host default, the 0.3.0 default flip). Days to two weeks, based on `main`.
- **Releases.** Stable 0.2.x ships from `main` with the flag off. Canary or `0.3.0-alpha.N` tags carry the flag on for dogfooding. 0.3.0 flips the defaults.
- **Linux CI** gates `host-core`, `host-protocol` and `apps/hostd` from M1 onward.

## Milestones

Each milestone ends in a demo the owner runs. Parent ticket: VC-539; it lists the milestone tickets, and each milestone lists its work tickets.

| | Milestone | Demo |
|---|---|---|
| M0 | Foundations | Flag exists; Linux CI green; protocol and identity specs merged; transaction gate covers every write. |
| M1 | Headless host | `hostd` runs headless on Linux. Over SSH and the CLI you create a ticket, start a session, disconnect, and it finishes and pushes its branch. The desktop app still runs host-core in-process, unchanged. |
| M2 | One host protocol | The desktop attaches to a `hostd` (local on loopback, or the Hetzner box over Tailscale) and feels identical. Quit the app or close the lid and turns continue. **First lid-closed dogfood.** |
| M3 | Workers and venues | One board on the box; tickets run on the box and the laptop at once; a ticket moves mid-flight. |
| M4 | Workspace mobility | Stop paying for the box, click "Move to This Mac", done. |
| M5 | Mobile | Answer an agent's question from a phone while the laptop is closed. |
| M6 | Volli Cloud | Sign in on a new laptop, see your boards, "Run in cloud", no configuration. (Private repo.) |

Order: M0 → M1 → M2 → M3. M4's table classification starts after M1 and runs beside M2. M5 starts once M2's board and session areas land.

## Glossary (to be added to CONTEXT.md)

- **Host** — the process that is the single authority for one or more workspaces and serves the host protocol.
- **Worker** — a process that executes Sessions for a host and owns the checkouts it holds leases on.
- **Client** — anything that reads projections and sends commands over the host protocol.
- **Workspace** — the portable unit a host is authoritative for: one database file, its artifacts and git refs. (Today: one project's board.)
- **Host protocol** — the versioned, capability-negotiated API every client and worker speaks.
- **Execution venue** — the worker a ticket's checkout currently lives on. Distinct from `VenueKind` in `session-venue.ts`, which describes the checkout type.
- **Checkout lease / epoch** — the host's grant naming the one worker allowed to write a ticket's checkout; the epoch increments on every transfer and fences older holders.
- **Workspace epoch** — the same fence, one level up: which host is the authority for a workspace.
- **Checkpoint ref** — `refs/volli/checkpoints/<ticket>`, a commit holding a checkout's uncommitted work, pushed to the host's git store (never the user's origin).
- **Control plane** — closed hosted services only Volli Cloud needs.

## Evidence this rests on

- `docs/BOUNDARIES.md` — Electron main is a host; clients never talk to databases; standing rules 1–5; the transaction-gate limit.
- VC-486 (research files retained in its worktree; see `volli ticket show VC-486`) and `docs/architecture/explorer.html` (main checkout, untracked) — the code map and the earlier proposal.
- VC-486 research session `6f1cbc6b`: T3 Code ships the host/environment split with an authoritative event log and threads pinned to one environment; Amp ships orbs plus runners; Claude and Cursor self-hosted runners keep authority in the vendor cloud; nobody reconciles local and cloud both ways well. Amp's Linux runners use labwc + Waymote for a shared browser.
- Sizes on `origin/main` at `f6ec540ca`: `main/index.ts` 4,465 lines with a ~3,600-line `app.whenReady` composition closure; 22 main-process files import `electron`; 212 IPC invoke channels (data 83, files 21, automations 20, browser 18, system 15, …); 61 SQLite tables.
