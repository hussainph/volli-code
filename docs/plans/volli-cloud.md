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

**Amended 2026-10-06 (post-M1 review), D-A2:** Electron main remains the Mac's host, in menu-bar mode after quit; headless `hostd` is for boxes. Two composition roots share one host-core and one protocol. The renderer uses the same routers over IPC locally and WebSocket remotely. This is pending VC-691's 1–2 day launchd spike (keychain, TCC and signing); an app crash still kills local turns. The original window-only/headless-everywhere description above is superseded for the Mac.

### Deployments (same code)

| Mode | Host | Workers | License |
|---|---|---|---|
| **Local** (default) | Your Mac, started by the app | Your Mac | Open source |
| **Self-hosted** | Your box, reached over Tailscale or any HTTPS | The box and your laptop | Open source |
| **Volli Cloud** | Volli runs one host per workspace | Zero-config sandboxes and your laptop | Paid; control plane is closed |

## Rulings

1. **One authority per workspace, never sync.** Multi-writer board state (queued comments, offline ticket moves, reconciled snapshots) is rejected. Agents coordinate through the board in real time, so the board must have one always-reachable writer. The cost is availability: if a remote host is down, its workspace is read-only until it returns or you move the workspace. **Amended 2026-10-06 (post-M1 review), D-C1 = (b):** Clients keep only an in-memory last-known view, marked stale and read-only from the host link's state. A cold boot offline shows an unreachable host and Retry, not durable Workspace data. Revisit for M5.
2. **The desktop always talks to a host, even on the same Mac.** One composition root, one protocol. Revisit only on a measured streaming-latency regression over loopback. **Amended 2026-10-06 (post-M1 review), D-A2 = (b), pending VC-691:** one host-core, one protocol, two composition roots (Electron main on the Mac, hostd on boxes), for the platform costs above rather than latency alone. **D-C2:** if the spike reverses D-A2 and a local hostd owns the profile, turning the flag off waits for turns to finish, then hands back the profile lock. Under (b), this is moot: flag-off swaps the router link for IPC in the same process and turns continue.
3. **The agent loop runs on the worker.** A loop on the client dies when the lid closes. Never route remote tool calls back to the Mac.
4. **A ticket's checkout belongs to one worker at a time.** The host grants a lease with an epoch. Moving a ticket = stop writes → commit working state to a checkpoint ref → bump the epoch → restore on the destination. Old-epoch writes are refused. Version 1 promises transcript and uncommitted files; dependencies are rebuilt; live processes and browser sockets do not migrate. "Fork to another machine" is a later feature.
5. **One SQLite file per workspace, plus a host-level database.** A workspace is one portable unit: its database file, its artifacts, its git refs. The host streams a WAL-level replica (Litestream-style) to targets you choose (your Mac, S3). **Amended 2026-10-06 (post-M1 review), D-A3 = (b):** the per-Workspace split and WAL replicas are deferred to M6 planning, when the split is re-decided; they are not M4 or 0.3.0 requirements. VC-587's table classification still runs.
6. **Moving a workspace is a fenced promotion.** "Move workspace to This Mac / hetzner-2 / Volli Cloud" restores the replica and raises the ownership epoch; the old host is refused by every client and worker. Failover can lose the last unreplicated seconds; that tail is quarantined for inspection, never merged. This is the answer to outages and to "I stopped paying for the box". **Amended 2026-10-06 (post-M1 review), D-A3:** M4 is **move the host**: drain → bundle → restore (new host identity) → epoch+1 → re-pair. Every Workspace on the host moves together; there is no hot failover. Fencing remains; replica promotion is deferred with Ruling 5.
7. **Convex runs the control plane only, never the board.** Accounts, billing, provisioning, the workspace and device registry, push delivery. Putting the board in Convex would mean two implementations of the authority or giving up local-first.
8. **The agent browser survives.** Agent tools already speak CDP through the injected `CdpTransport` (`packages/host-core/src/browser/cdp-controller.ts`, behind the `BrowserBackend` seam since VC-561). On a worker it points at standalone Chromium; the person watches through `Page.startScreencast` in the existing browser pane and co-drives through the existing browser hold. A virtual desktop stream (labwc + Waymote, as Amp does) is the later upgrade for native dialogs and logins. "Watch agent browser" and "Preview app" (forwarded dev-server ports, like Amp Portals) are separate features. **Amended 2026-10-06 (post-M1 review), D-A2:** the Mac retains the native `WebContentsView` backend pending VC-691; Chromium's parity bar applies to remote hosts ([HP Decided 2](host-protocol.md#decided-owner-2026-10-04)).
9. **Open-source boundary.** Host, worker, clients, protocol, pairing, checkpoint refs and workspace moves are open source. The control plane lives in a private `volli-cloud` repo and depends only on the public host protocol. If it needs a hook, the hook goes into the public protocol.
10. **Multiplayer falls out of one authority.** Membership, per-actor capabilities (VC-92's model) and presence over the host protocol. The relay in `docs/BOUNDARIES.md` "The chosen path" is no longer needed for single-host workspaces.

**Amended 2026-10-06 (post-M1 review), D-A1 = (c): hybrid catalog.** This partly amends F3 in [host protocol](host-protocol.md#command-catalog-f3). Every command reaches one host-core handler map (VC-668) and the policy middleware. Public catalog ceremony—output schemas, frozen feature sets and N−1 fixtures—applies only to entries a second Client calls (phone, CLI, agent). Desktop-only channels use VC-608's generic bridge, with policy derived from VC-574's placement class, additive-only. Promote an entry before a second Client uses it; both tiers reach the same handler.

### Hosted-readiness guardrails

**Owner decision, 2026-10-06:** keep the milestone order. Hosted Volli Cloud is expected to become the primary commercial product; **M2–M5 keep the hosted door open**. Every brief carries these rules:

1. **Enrollment is pluggable.** Device and host credentials go through the verifier port (VC-564 D5). Pairing codes are one path; account-issued credentials must slot in later without protocol changes.
2. **Hooks live in the public protocol** (Ruling 9). Registry, provisioning, push and billing hooks never become private desktop shortcuts.
3. **hostd stays tenant-agnostic.** One hostd per Workspace or host, configured only by data dir, environment and ports; no Mac, home-directory or human-at-console assumptions. Secrets use key-provider ports; cloud KMS is another adapter.
4. **Fleet-shaped operations.** Telemetry (VC-672), idle-drain upgrades (VC-676), health and backup/restore are built for a fleet.
5. **No client-side source of truth** (D-C1). Desktop and phone hold no durable Workspace data.

Post-milestone architecture reviews check every PR against these guardrails: **does this block hosted?**

## How we build it

- **Trunk-based, behind one flag.** Every ticket is one PR that lands green on `main`. With the `cloud` flag off, behavior is unchanged; the core e2e suite proves it on every PR.
- **New code beside old code.** `packages/host-core` (services, no Electron), `packages/host-protocol` (versioned, capability-negotiated), `apps/hostd` (the headless binary). Each IPC area moves in its own ticket; the old path is deleted when its area moves (BOUNDARIES rule 5, applied deliberately).
- **Database changes are expand → switch → contract.** Additive migrations first, dual-write, read switch behind the flag, removal of the old layout in 0.3.0. Every migration is checked against a copy of a real profile database.
- **Short integration branches only for real cutovers** (the per-workspace database cutover, the always-through-host default, the 0.3.0 default flip). Days to two weeks, based on `main`.
- **Releases.** Stable 0.2.x ships from `main` with the flag off. Canary or `0.3.0-alpha.N` tags carry the flag on for dogfooding. 0.3.0 flips the defaults.
- **Linux CI** gates `host-core`, `host-protocol` and `apps/hostd` from M1 onward.

**Amended 2026-10-06 (post-M1 review), D-A3:** the per-workspace database cutover above is deferred to M6 planning, not a 0.3.0 default flip. Expand → switch → contract remains the rule for database changes when needed.

## Milestones

Each milestone ends in a demo the owner runs. From M1 onwards, Done also requires the [post-milestone architecture review](volli-cloud-orchestration.md#milestone-architecture-review): six cross-family lenses, HTML report, tickets filed, and decisions that re-open rulings brought to the owner (standing rule, 2026-10-06). Parent ticket: VC-539; it lists the milestone tickets, and each milestone lists its work tickets.

**Amended 2026-10-06 (post-M1 review), D-A2/A3:** M2's Mac host is Electron main pending VC-691; M4 moves the whole host, not individual Workspace replicas. The milestone order stays unchanged.

| | Milestone | Demo |
|---|---|---|
| M0 | Foundations | Flag exists; Linux CI green; protocol and identity specs merged; transaction gate covers every write. |
| M1 | Headless host | `hostd` runs headless on Linux. Over SSH and the CLI you create a ticket, start a session, disconnect, and it finishes and pushes its branch. The desktop app still runs host-core in-process, unchanged. |
| M2 | One host protocol | The desktop uses the Mac host (Electron main in menu-bar mode) or the Hetzner `hostd` over Tailscale and feels identical. Quit the window or close the lid and turns continue. **First lid-closed dogfood.** |
| M3 | Workers and venues | One board on the box; tickets run on the box and the laptop at once; a ticket moves mid-flight. |
| M4 | Move the host | Stop paying for the box: drain, bundle, restore on This Mac, fence the old host and re-pair. All its Workspaces move together. |
| M5 | Mobile (0.4.0) | Answer an agent's question from a phone while the laptop is closed. |
| M6 | Volli Cloud | Sign in on a new laptop, see your boards, "Run in cloud", no configuration. (Private repo.) |

Order: M0 → M1 → M2 → M3. M4's table classification starts after M1 and runs beside M2. M5 ships in 0.4.0, after 0.3.0 (owner ruling, 2026-10-04). During M2, a throwaway phone page served by `hostd` (VC-637) keeps the host protocol client-agnostic.

## Glossary (to be added to CONTEXT.md)

- **Host** — the process that is the single authority for one or more workspaces and serves the host protocol.
- **Worker** — a process that executes Sessions for a host and owns the checkouts it holds leases on.
- **Client** — anything that reads projections and sends commands over the host protocol.
- **Workspace** — the portable unit a host is authoritative for: one database file, its artifacts and git refs. (Today: one project's board.) **Amended 2026-10-06 (post-M1 review), D-A3:** independent database files/portability are deferred to M6 planning; M4 moves all Workspaces on a host together.
- **Host protocol** — the versioned, capability-negotiated API every client and worker speaks.
- **Execution venue** — the worker a ticket's checkout currently lives on. Distinct from `VenueKind` in `session-venue.ts`, which describes the checkout type.
- **Checkout lease / epoch** — the host's grant naming the one worker allowed to write a ticket's checkout; the epoch increments on every transfer and fences older holders.
- **Workspace epoch** — the same fence, one level up: which host is the authority for a workspace.
- **Checkpoint ref** — `refs/volli/checkpoints/<ticket>`, a commit holding a checkout's uncommitted work, pushed to the host's git store (never the user's origin).
- **Control plane** — closed hosted services only Volli Cloud needs.

## Evidence this rests on

- `.scratch/arch-review-m1/architecture-review-post-M1.html`, § Decisions for you — D-A1/A2/A3/C1/C2; owner approvals recorded on VC-542, 2026-10-06. Hosted-readiness guardrails recorded on VC-692 the same day.
- `docs/BOUNDARIES.md` — Electron main is a host; clients never talk to databases; standing rules 1–5; the transaction-gate limit.
- VC-486 (research files retained in its worktree; see `volli ticket show VC-486`) and `docs/architecture/explorer.html` (main checkout, untracked) — the code map and the earlier proposal.
- VC-486 research session `6f1cbc6b`: T3 Code ships the host/environment split with an authoritative event log and threads pinned to one environment; Amp ships orbs plus runners; Claude and Cursor self-hosted runners keep authority in the vendor cloud; nobody reconciles local and cloud both ways well. Amp's Linux runners use labwc + Waymote for a shared browser.
- Sizes on `origin/main` at `f6ec540ca`: `main/index.ts` 4,465 lines with a ~3,600-line `app.whenReady` composition closure; 22 main-process files import `electron`; 212 IPC invoke channels (data 83, files 21, automations 20, browser 18, system 15, …); 61 SQLite tables.
