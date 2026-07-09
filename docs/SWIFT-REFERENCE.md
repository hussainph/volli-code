# The Swift original — reference for the rewrite

*Snapshot of `../volli-swift` (native SwiftUI/AppKit) at the time this Electron rewrite started (July 2026). It is the near-term parity target and the record of its data formats and design lessons. The Swift repo still exists — when in doubt, read its source directly.*

## What the Swift app had built when the rewrite started

- **Terminal spike: done.** Live login shell per project via libghostty's `.exec` backend.
- **Tracker: mostly done.** Project rail, SQLite persistence (GRDB), kanban CRUD with drag-drop, card detail, add-ticket sheet.
- **Never built.** Worktrees, agent launching, the `volli` CLI socket, hook-driven auto-moves, notifications, session/audit history, PR flow, and Archive exist only as spec (`docs/CONCEPT.md`) and stubs (CLI subcommands throw "Not implemented yet"; `WorktreePlanner` is pure planning with no git execution).

So the rewrite is re-implementing a tracker + terminal shell, then building the unbuilt product on top — not porting a finished app.

## Feature inventory (what was actually built — the parity checklist)

**Window shell** — three-region layout: 68pt project rail | collapsible 240pt session panel with a 9pt drag-grip gutter (hover → capsule handle + resize cursor; click toggles; drag resizes with snap at 120pt midpoint) | project content. `⌘\` toggles the session panel. Empty states for no-projects and DB-init failure.

**Project rail** — Slack-style vertical tiles (40×40 rounded monograms, 8-color palette, selection ring), drag-to-reorder with live shuffle persisted per hover, sticky "+" tile, per-tile context menu (Reveal in Finder / Remove from Volli with confirmation; folder on disk untouched). `⌘1–⌘9` switch projects by rail order.

**Session panel** — project name + ticket prefix header; "Active Sessions" list was a placeholder (real sessions were later work).

**Project content** — vertical split: kanban board above, live terminal below (min 240pt). The terminal is one login shell per project rooted at the project folder — the terminal spike, not per-ticket sessions.

**Kanban board** — fixed 5 columns (Backlog · Todo · Doing · Needs Review · Done). Cards show title, priority dot (low=blue, medium=orange, high=red), ticket ID. Drag-drop between columns updates status; drop-target column gets an accent border; failures surface as alerts. "Add Card" menu (choose column) + per-column add button. An animation-settings popover offers 3 drag-animation styles (Linear / Vibe Kanban spring / Minimal), each respecting Reduce Motion, persisted in UserDefaults.

**Ticket detail** — quick read-only inspector pane (title/description/ID/status/priority) plus an expanded editable panel (title + markdown description, Save/Cancel, Return/Esc shortcuts).

**Add ticket** — sheet with title/description; next number = max existing + 1 with project prefix.

**Project import** — folder picker → confirm sheet with name + ticket prefix (auto-derived, uppercased, validated: 1–5 chars, A–Z/0–9, starts with a letter). Duplicate path selects the existing project.

**Design direction** — frosted-glass window material, ember-orange accent `#E8652A`, Slack-style two-tier sidebar, centralized design tokens (`DesignSystem` in `Support/Layout.swift`).

## Data model (Swift schema — for a possible one-time import; we deliberately do NOT share this data)

Persistence: SQLite via GRDB 7 at `~/Library/Application Support/VolliCode/volli.sqlite`, WAL mode. Encoding quirks: dates are **Int64 epoch-milliseconds**; UUIDs are **uppercased TEXT**; ticket `tags` is a **JSON array string**; the ticket row has both `id` TEXT (`"VC-12"`) and a separate `ticketNumber` INTEGER column.

**project**: `id` UUID-TEXT · `name` · `path` (absolute folder path, unique) · `ticketPrefix` · `colorIndex` (0–7) · `sortOrder` (rail order) · `createdAt`

**ticket**: `id` `"<PREFIX>-<n>"` · `projectID` (FK, cascade delete) · `ticketNumber` INT (unique per project) · `title` · `body` (markdown; becomes the agent prompt) · `status` (`backlog|todo|doing|needs_review|done`) · `priority` (`low|medium|high`) · `tags` JSON · `usesWorktree` BOOL (default true) · `harnessID` (default `"claude-code"`) · `order` (position in column) · `createdAt` · `updatedAt`

Indexes: `(projectID,status)`, unique `(projectID,ticketNumber)`, `(projectID,order)`. Migrations were v1-projects, v2-project-sort-order, v3-tickets. **No sessions/events/comments tables were ever created.**

Also on disk: `session.json` (UI scratch state: selected project, panel visibility; version-gated, discarded on mismatch) and UserDefaults key `animationStyle`.

**Domain invariants encoded in the models** (keep these): branch name = `volli/<TICKET-ID>-<slug>`, slug = lowercased ASCII alphanumerics hyphen-joined, ≤48 chars, `"ticket"` fallback when empty. `TicketStatus` carries the automation semantics: `launchesAgentOnEntry` (doing only), `notifiesOnEntry` (needs_review only), `offersPullRequestOnEntry` (done only). Harness templates use `{{brief}}` (shell-quoted) and `{{ticket_id}}` placeholders; builtins: `claude-code` (`claude {{brief}}`, resume `claude --resume {{session_ref}}`), `codex`, `opencode`.

## Architecture lessons worth keeping

- **Model-resident / view-lazy**: one long-lived workspace object per project, cached for app lifetime, so live terminals survive project switches; views mount/unmount freely. (In this repo: Zustand stores + main-process session ownership play this role.)
- **Never unmount a live terminal incidentally** — selecting a card must not tear down the board or terminal (the Swift app hit exactly this bug).
- The ticket state machine and all auto-move logic stayed **pure and unit-tested, separate from UI** — the UI observes it. Carry this rule verbatim.
- **Surface every failed mutation to the user** — silent `catch {}` on drop/create/save was the audit's top systemic finding.
- **One shared design-token module** — duplicated per-view spacing constants were a repeated cleanup.
- **Manual move wins**: hook events arriving right after a manual board move are stale and must be ignored (see CONCEPT decision 20) — this was designed in from the start, not an implementation detail.
- Live process state (PTYs) is deliberately **excluded from persisted snapshots**; restarts rely on resume commands (decision 9).
- The terminal engine sat behind a protocol; launch commands were injected as keyboard input on surface attach so the shell survives agent exit — the "shell outlives the agent" behavior is worth keeping even though the mechanism will differ with node-pty.

## Known defects in the Swift app (don't re-import them)

- UI snapshot wrote a `workspaces` array it never read back (dead state).
- A detached async snapshot write raced app-terminate writes.
- Rail drag-reorder still used legacy NSItemProvider patterns; board drag-drop had been migrated to the modern API.
- Early versions swallowed mutation errors and seeded edit state from stale view identity — both fixed late; both are the origin of the conventions above.
