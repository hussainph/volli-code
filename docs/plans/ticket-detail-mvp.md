# Ticket Detail MVP — decision record & build plan

_Grilling session 2026-07-14 (Hussain × Fable). This document is the handoff: all decisions below are settled with the user — do not relitigate. Build continues from here._

## Vision anchor

A ticket in Volli is a lifecycle-aware workspace, not a static issue:

- **Backlog/Todo** — scratchpad phase: title + markdown body scope the work; sessions may be spun up to *produce plans/artifacts*, which must be viewable/auditable/editable in-app. (Merging Backlog+Todo into one column is a deferred, separate decision.)
- **Doing** — session phase: majority of time in ticket-scoped terminal sessions; updates/artifacts append to the work log.
- **Needs Review** — future: AI code-review results as comment threads + git diff focus. Not in scope now; the activity/comment model must accommodate it.
- **Done** — future: wrap worktree, merge PR. Out of scope; design shouldn't block it.

Worktrees are **pure code isolation** for parallelizing dozens of tickets. Creation stays manual (user/agent in-harness) for now, but worktree identity is **first-class in schema + UI immediately** — no deferred thinking.

## Settled decisions

### Surface & navigation
1. **Full-page detail view** replacing the board inside the project workspace (breadcrumb `Board › VC-12` to return; Escape also returns).
2. **Double-click** a card opens it; single click keeps today's select-only behavior.
3. Open ticket **persists across restart**: `openTicketId` per project in the workspace UI store (alongside `nav`/`boardView`).

### Layout
4. Main column: title → properties context → body → activity. Right rail: **properties block at top** (placement explicitly revisited later), **linked-sessions list** below.
5. Session row: harness identity (claude-code/codex/opencode) + status chip or border color. MVP status is honest PTY-derived: **working** (output within ~10s) / **idle** (running, quiet) / **exited**. Hook-driven states (waiting-for-input etc.) swap in later without changing the vocabulary.
6. Clicking a session opens a **tab plane in the main area**: `Doc | Artifacts | <session tabs>` all share one plane inside the ticket view. This is the docking point for future split view and an embedded preview browser. Default tab on open: Doc.
7. **No "primary session" concept** — all sessions equal weight, differentiated only by which lifecycle stage they were created in.
8. Live terminals must never unmount incidentally (existing invariant) — resident session state, lazy views.

### Scratchpad / editor
9. **Notion-like semantics.** Rendered markdown via **shadcn/typeset** (single CSS file we own, wired into globals.css tokens; `.typeset` container). Click-to-edit flips a block/document into a plain textarea; blur or ⌘-Enter flips back to rendered.
10. **Debounced autosave** ~1.5s idle + flush on blur/navigate, via existing `api.tickets.update`.
11. **Coalesce `body_edited` events**: if the ticket's latest event is `body_edited` less than ~5 min old, touch it instead of appending (one Activity line per editing burst).
12. Inline title editing (click-to-edit heading), `retitled` event (exists).

### Artifacts & `.volli`

> **Partially superseded 2026-07-17** by [`global-artifacts.md`](global-artifacts.md) (CONCEPT decision #33): the ticket tier, promote flow, Artifacts tab, and `VOLLI_TICKET_DIR` are gone — one project-level `.volli/artifacts/` dir, referenced from Ticket Bodies via plain-text `@relative/path` refs that open as file tabs. #13 (filesystem-as-truth) and #15 (self-gitignore) stand.
13. **Filesystem-as-truth, no artifacts DB table.** `.volli` is plain md/html-first — human- and agent-readable/renderable outside Volli (respects the `.claude`/`.agents` meta).
14. *(superseded — see note above)* **Two tiers**:
    - `<project>/.volli/artifacts/` — project-level artifacts
    - `<project>/.volli/tickets/<DISPLAY-ID>/artifacts/` — ticket-scoped
    Two-way relationship: **promote** ticket artifact → project level; **reference** project artifacts from a ticket (both directions surfaced in the Artifacts tab).
15. `.volli` is **self-gitignored** (`.volli/.gitignore` containing `*`) — never touch the user's root `.gitignore`.
16. *(superseded — see note above; `VOLLI_ARTIFACTS_DIR` replaces `VOLLI_TICKET_DIR`)* Ticket-linked sessions get env vars injected at PTY creation: `VOLLI_TICKET=<DISPLAY-ID>`, `VOLLI_TICKET_DIR=<project>/.volli/tickets/<DISPLAY-ID>`. **Always the main repo's `.volli`** — never derived from cwd (future worktrees are separate checkouts that won't contain gitignored `.volli`).
17. *(superseded — see note above; the viewer/editor treatment lives on in file tabs)* Artifacts tab: `.md` gets the same typeset-render/click-to-edit treatment as the body; images render inline; other files = name + reveal-in-Finder. `fs.watch` (or refresh-on-focus) keeps the list live while agents write.

### Sessions
18. **Real `sessions` table now** (not deferred): durable trace + resume seed. Scope bifurcated by nullable `ticket_id` (NULL = project-scoped scratch session). `harness_session_id` column reserved for claude/codex session UUIDs → future `--resume` support via hooks/volli CLI.
19. Renderer: ticket-sessions map keyed by `ticketId`, reusing the existing tab/split machinery from `stores/sessions.ts`. Live PTY state stays in-memory as today.
20. Ticket sessions run with **cwd = project root** for now (worktree automation later). `CreateTerminalSessionRequest` extended with optional ticket context.
21. `session_started` / `session_ended` ticket events recorded from main.

### Comments & activity
22. **`ticket_comments` table** (content) + `commented` event kind (audit) — comments are content, events are audit; append-only event log stays pure. Rationale: future review threads need edit/resolve semantics.
23. Comments = the ticket's **work log**: human orchestrator notes + agent session summaries (posted via the future `volli` CLI). At-a-glance view of all work without opening transcripts.
24. `ticket_comments.session_id` nullable FK → sessions: an agent-posted summary links back to its session.
25. `actor` convention widens: `'user'` | `'agent:<harness_id>'`.
26. New read IPC: `api.tickets.events(ticketId)` (+ comments read/create/update/delete). Feed renders Linear-style: property changes as one-liners, comments as full typeset blocks, merged chronologically. Composer at the bottom.

### Migration 003 (one migration)
- `sessions`: `id` TEXT PK, `project_id` FK CASCADE, `ticket_id` TEXT NULL FK, `harness_id` TEXT, `harness_session_id` TEXT NULL, `title` TEXT, `cwd` TEXT, `created_at` INT, `ended_at` INT NULL.
- `ticket_comments`: `id` TEXT PK, `ticket_id` FK CASCADE, `session_id` TEXT NULL FK, `actor` TEXT, `body` TEXT, `created_at` INT, `updated_at` INT.
- `tickets` += `worktree_path` TEXT NULL, `branch` TEXT NULL, `base_branch` TEXT NULL (first-class worktree identity; settable/displayable now, auto-populated by future automation).
- New event kinds (shared types only, no DDL): `commented`, `session_started`, `session_ended`.

### Quality bar
27. **Red-green-refactor** throughout. Strong **integration tests** (IPC/repo, main-process) and **e2e tests** (Playwright `_electron` — see memory `volli-live-smoke-test-recipe`) covering: open-detail flow, title/body edit + persistence, labels, comments CRUD, activity feed, artifact render/edit, ticket-session creation + env injection, tab plane switching, restart persistence of open ticket.
28. All existing conventions hold: no Node in renderer, preload is the only door, every failed mutation surfaces a toast, strict TS, branch+PR flow (never commit to main), 100% coverage gate on shared package.

## Round 2 — UX revision (grilling 2026-07-14, Hussain × Fable; supersedes conflicting round-1 items)

29. *(editor engine superseded by [`monaco-migration.md`](monaco-migration.md), CONCEPT #60)* **Editor is Obsidian-style live preview**, replacing click-to-edit (supersedes #9's textarea flip). Monaco Document Mode owns the projection: the Markdown buffer is the document; syntax renders in place and reveals near the cursor. No mode flip, no accent border on edit — clicking just places a cursor. Byte-faithful to agent-written files.
30. Editor v1 construct set: headings, bold/italic/strike, inline code, links (syntax hidden, click-to-open), bullet/ordered/task lists, blockquotes, code fences, images inline, horizontal rules. Tables stay raw syntax. No floating toolbar; ⌘B/⌘I wrap selection. Debounced autosave semantics from #10 unchanged.
31. **Artifacts `.md` editing uses the same editor** with autosave (explicit Save button removed) + an on-disk conflict guard: if the file changed on disk since load, don't clobber — surface it. Title stays an inline input; comment composing stays a plain textarea this round.
32. **Activity feed = hybrid signal/collapse**: comments and high-signal events (`created`, `status_changed`, `session_started`, `session_ended`) render inline; runs of low-signal events (`retitled`, `body_edited`, `priority_changed`, `labels_changed`, `worktree_changed`, `archived`, `unarchived`) collapse into a trailing "+N more" inline expander.
33. **Harness removed from tickets entirely** (migration 004 drops `tickets.harness_id`; type, filter model, properties row, filter chip, create-dialog picker all go). Harness identity lives on sessions only. `HARNESS_IDS`/labels stay in shared for session identity.
34. **Right rail is sessions-first**: sessions list gets the rail; a "Details" collapsible (default collapsed, persisted) pinned at the bottom holds status/priority/labels/worktree (resolves #4's flagged placement revisit).
35. **Right-rail toggle** at the chrome bar's right edge (mirrored sidebar icon, visible when a ticket is open), ⌥⌘B, collapsed state persisted.
36. *(Artifact tab superseded by #33; terminology updated by the Monaco migration)* **Chrome-style tab strip at the top of the detail view**, spanning main column + rail (browser-window metaphor): Ticket Body tab labeled with the ticket display ID, file and session tabs with close ×, and a `+` for new session. Breadcrumb header retires.
37. **Slack-style ←/→ workspace nav history** in the chrome bar traversing all navigation snapshots (project switches, sidebar nav, ticket open/close); ⌘[ / ⌘]; Escape-in-detail still returns to Board. History is in-memory (not persisted).
38. **Sessions unified onto one store + resident layer**: scratch and ticket sessions share `stores/sessions.ts` machinery with a scope field; the always-mounted layer owns all live terminal views (ticket detail becomes a view over it — terminals survive navigating back to Board). Splits, font controls, kill/close reach parity inside tickets.
39. **Sessions renameable**: double-click tab / rail row for inline rename + context-menu Rename (filled Phosphor icon); persists via `api.sessions.rename` → sessions repo title update; both surfaces.

## Deferred / flagged (do not build, do not forget)
- Merge Backlog+Todo columns (product decision, later).
- Properties-rail placement revisit.
- Live terminal mini-previews in the session rail.
- Worktree *creation* automation + git exec in main; `.volli/worktrees/` location decision.
- Hook-driven session status (waiting/blocked), auto-move on agent stop.
- Review-phase UI (diff view, AI review threads) and Done-phase automation (PR checks, merge).
- `volli` CLI (socket) — comments/artifact registration from agents.

## Build order (small, focused agents — mind usage budget; see memory: subagent-scope-sizing, fable-subagent-model-delegation)
1. **Shared domain + migration 003** — types (session, comment, new event kinds), migration, repos (sessions, comments, events-read), unit tests. [sonnet]
2. **Preload/IPC surface** — events read, comments CRUD, sessions record, terminal create w/ ticket context + env injection, integration tests. [sonnet]
3. **Detail view shell** — full-page route in workspace, double-click open, breadcrumb/Escape, persisted openTicketId, properties block, right rail skeleton. [sonnet/opus]
4. **Editor** — typeset CSS integration, markdown render, click-to-edit title/body, debounced autosave, event coalescing. [opus]
5. **Activity + comments UI** — merged feed, composer. [sonnet]
6. **Artifacts** — .volli fs plumbing in main (dirs, self-gitignore, list/watch, promote/reference), Artifacts tab UI. [sonnet/opus]
7. **Ticket sessions** — store extension, session rail, tab plane, status chips. [opus]
8. **e2e suite + final review** — Playwright flows above. [review stays on Fable]

Branch: `feat/ticket-detail-mvp` (or stacked branches per chunk if cleaner). PR against main.
