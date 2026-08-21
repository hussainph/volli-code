# Files feature audit (VC-120)

An audit pass of everything the app calls "Files": the first-class nav surface,
the sidebar file tree, the Monaco editors behind file/diff tabs, the theming
that wraps them, and the paths by which chats and tickets open files. Every
claim below is verified against the code at the cited location; nothing here is
from memory of how it was supposed to work.

The ticket's proposal — demote Files from first-class nav, move file access
into the session rails, add a Codex-style "Open in <editor>" escape hatch — is
assessed at the end, with a recommended work breakdown.

## 1. What "Files" is today (inventory)

Five distinct entry points lead to a file view:

| Entry point | Scope | What opens |
|---|---|---|
| **Files nav item** (`sidebar/nav-list.tsx`) | Main checkout only | `FilesPage` workbench: tab strip + one `FileView` (`pages/files-page.tsx`, 349 lines) |
| **Sidebar file tree** (`sidebar/file-tree.tsx`, 433 lines) | Main checkout only; visible only while Files nav is active (`primary-sidebar.tsx:83`) | Previews/pins tabs in the Files workbench |
| **Ticket workspace** (`ticket/ticket-detail.tsx`) | Worktree-aware | File tabs (`FileView` with `ticketId`), diff tabs (`DiffView`), rail Files/Diffs navigators |
| **Chat file mentions + activity rows** (`ui/ai-elements/chat-markdown.tsx`, `chat/activity-ui.tsx`) | Ticket chats → ticket tabs; project chats → **Files page** | `onOpenFile(path)` with the raw tool path |
| **`@file` picker / artifacts** (composer, Document Mode) | Index over main checkout + `.volli/artifacts` | Autosaving Document Mode editor |

Supporting layers, bottom to top:

- **Main process:** `main/volli-fs.ts` (1,248 lines) — read/write/index/reveal,
  two-layer path safety, the worktree resolution seam
  (`resolveFileScope`/`worktreeRootFromRow`, :152, :1068–1076), per-tab file
  watches and per-directory tree watches with bounded re-arm.
- **Shared:** `file-workspace.ts` (preview/pin tab reducer, decisions #55/#56),
  `file-ref.ts` (`isSafeRelPath`), `fileSavePolicy` (CONCEPT #49).
- **Renderer editor infrastructure:** ~14.5k lines across
  `components/editor/*`, `components/files/*`, `editor/*` — the document
  registry (shared Monaco models + leases), live reconciliation with
  cursor-preserving external edits, view-state mapping through diffs, autosave
  planning, conflict guards, the shiki/Monaco bootstrap with five language
  workers, and Document Mode.
- **Theming:** an editor-theme catalog + picker (`editor/editor-theme-catalog.ts`,
  `theme/editor-settings-model.ts`, rows in `pages/appearance-settings.tsx`),
  separate from the generated app-canvas token system and the terminal/Ghostty
  overlay system (~5.8k lines under `packages/shared/src/theme/` +
  `stores/theme.ts` at 924 lines).
- **e2e:** `project-files-smoke`, `monaco-reconciliation-smoke`,
  `editor-theme-smoke`, `changeset-diff-tabs-smoke`,
  `changeset-navigators-smoke`, `live-preview-smoke`, `global-artifacts-smoke`.

Two facts that frame everything else:

1. **The Files page is main-checkout-only by design** (CONCEPT #54). Every
   `FileView` it mounts is rendered without a `ticketId`
   (`files-page.tsx` header comment and render), and the tree's directory
   watches are deliberately never worktree-scoped (`volli-fs.ts`,
   `volli:dir-watch`: "an expanded tree row can never drift onto a worktree
   copy").
2. **The ticket workspace already has everything the proposal asks for at
   ticket scope**: a right-rail Files navigator (`ticket-files-panel.tsx`), a
   Diffs navigator, and preview/pin file tabs in the session view
   (`openTicketFile`/`previewTicketFile`/`pinTicketFile`). The proposal's gap
   is Home/project-session scope only.

## 2. The reported bugs, verified

### 2.1 "Files outside the main repo folder fire an ENOENT error" — CONFIRMED, two mechanisms

A **project-session** chat routes every file click to the Files page:
`sessions-layer.tsx:222` (`openProjectFile`) calls
`previewProjectFile(...)` + `setNav(..., "files")`, and `:356` hands it to every
transcript row. The path handed over is the **raw tool-input path** — activity
descriptors carry it unrelativized (`agent-runtime/src/pi/activity.ts:180`,
`subjectFor`), and neither `chat-markdown.tsx` nor `activity-ui.tsx` maps it
before calling `onOpenFile`.

An orchestrating project session spends much of its life operating on ticket
worktrees under `~/.volli/worktrees/…`. So:

- A **relative path that exists only in a worktree** resolves against the main
  checkout, `fsp.stat` throws, and `readFile`'s catch returns
  `errorMessage(error)` — the renderer then prints the raw Node string:
  `ENOENT: no such file or directory, stat '…'` (`volli-fs.ts:456`,
  `file-view.tsx` error state). This is the reported bug, verbatim.
- An **absolute worktree path** fails `isSafeRelPath` and shows
  "Invalid file path" instead.

Ticket-session chats fare better — `ticket-detail.tsx:1098` opens through the
worktree seam — but two edges remain: absolute paths fail the same way, and a
ticket whose worktree row is stale silently degrades to the main checkout
(`worktreeRootFromRow`), where branch-only files are ENOENT again.

### 2.2 "Themed incorrectly / out of place" — CONFIRMED

- The editor-theme catalog ships **22 themes, all dark**; the default is
  `one-dark-pro` (`editor-theme-catalog.ts:181`). The app itself resolves
  light, dark, or system appearance. In light mode every Monaco surface is a
  dark rectangle inside a light app. This is a *recorded decision*, not drift —
  the catalog says "The editor is the one surface that will not match the
  canvas" — but on a light canvas it reads as breakage.
- Monaco's chrome (find widget, scrollbars, selection, gutter) is colored
  entirely by the shiki theme, never by app tokens, so even in dark mode the
  editor's palette sits beside — not inside — the generated canvas system.
- The knob that exists (Settings → Appearance → Editor theme picker with live
  preview) solves a problem nobody reported (choosing among 22 dark themes)
  and cannot solve the reported one (matching the app).

### 2.3 "Syntax highlighting isn't supported for most languages" — CONFIRMED with nuance

- 30 shiki grammars are shipped; ~50 extensions map onto them
  (`document-identity.ts` `EXTENSION_LANGUAGES`; `shiki-langs.ts`). Everything
  else falls to plaintext: no Vue/Svelte/Astro, no Objective-C (`.m`/`.mm`, on
  a macOS product), no Scala, Dart, Elixir, Lua, Haskell, OCaml, Zig, no
  HCL/Terraform, no proto, no diff/patch, no `.env`, no shebang sniff for
  extensionless scripts.
- **Editing** is supported for any utf8 file ≤ 1 MiB regardless of language
  (explicit ⌘S). The gap is highlighting and intelligence, not editability.
- Language *intelligence* exists only where Monaco workers run: TS/JS, JSON,
  CSS, HTML. Nothing configures `typescriptDefaults` (no
  `setDiagnosticsOptions` anywhere), so TS diagnostics run with Monaco defaults
  against **isolated single-file models** — cross-file imports cannot resolve,
  which manufactures false-positive semantic squiggles in ordinary repo files.

### 2.4 "Little to no configuration or utility controls" — CONFIRMED

The complete list of user-visible editor controls today:

- The diff tab's `Inline | Side by side` segmented strip — a full-width
  `border-b` bar mounted above the editor (`diff-view.tsx` render,
  `diff-presentation-toggle.tsx`). It is the only always-visible control on any
  editor surface, which is exactly why it reads as misplaced page chrome.
- Reveal in Finder — but only on the binary stub and the truncated-file notice.
- Conflict/live-error banners, the dirty dot, tab context menu (close others).

There is no word-wrap toggle, font-size control, go-to-line, in-project search,
copy-path, open-in-external-editor, breadcrumb, symbol outline, or status bar.
(Not all of those are worth building — see §4 — but the count today is
effectively zero.)

### 2.5 "No clear position for type or build errors" — CONFIRMED

Squiggles + hover are the only diagnostic surface. `overviewRulerLanes: 0`
(`monaco-file-editor.tsx` `SOURCE_MODE_OPTIONS`) removes even the overview
ruler's error marks. No problems list, no gutter summary, no build-tool
integration — and per §2.3, for most languages no diagnostics exist at all,
while for TS some visible errors are false positives.

## 3. Findings beyond the report

1. **Raw errno text is a pattern, not a one-off.** Any unclassified fs failure
   round-trips `error.message` into the pane (`volli-fs.ts:456,559,583,626,642`).
   The curated messages ("File was not found", "Not a file") exist but the
   catch-alls leak.
2. **No create/rename/delete.** Writes to nonexistent paths are refused outside
   `.volli/**` (documented NEW-FILE POLICY in `volli-fs.ts`). Defensible
   scoping — but it means the surface can *never* be a primary editor, which
   strengthens the ticket's demotion argument.
3. **Two parallel tab-workspace systems** live in the workspace store — project
   file tabs (per project) and ticket file/diff tabs (per ticket) — each with
   its own preview/pin, view-state, close-guard and restore wiring. Consistent,
   tested, but a lot of surface for a feature about to shrink.
4. **The load-bearing machinery is genuinely good and mostly not Files-page
   specific.** The document registry, live reconciliation (cursor-preserving
   external edits, undo-safe), watch re-arm, conflict-guarded writes, and
   Document Mode serve ticket tabs, artifacts, and the ticket body. Removing
   the Files *page* deletes little of it; see §6.
5. **Monaco is lazy-loaded** (`createLazyInitializer`, dynamic grammar/theme
   imports), so the demotion is not motivated by startup cost. The win is
   product focus, not performance.
6. **No external-editor affordance exists anywhere** — main exposes
   `shell.showItemInFolder` (reveal) and `shell.openExternal` (URLs only). The
   Codex-style menu is a brand-new, small, self-contained capability.

## 4. The proposal, assessed

> Remove Files as a first-class nav item; move the file picker to the right
> sidebar tab inside global/project sessions; open tabs in the session view;
> offer a visible "open in a first-class editor" menu.

**The shape is right, and cheaper than it looks.** Point by point:

1. **Remove Files from nav** — touches `nav-list.tsx` (3-item array),
   `main-content.tsx` (one branch), `primary-sidebar.tsx` (tree visibility).
   The Files-page-only components (`files-page.tsx`, `file-tab-strip.tsx`,
   Files-scoped store slices) retire with it *if* nothing else adopts them.
   `NavKey` `"files"` persists in durable workspace state — needs the same
   tolerant-read treatment `RETIRED_TICKET_RAIL_MODES` models.
2. **File picker in the session right rail** — the ticket rail already has a
   Files page; the Home rail (VC-55) has Now + Sessions and was built as
   "the ticket rail one scope up", so a Files page there is parity work, not
   invention. `TicketFilesPanel`'s navigator + `file-tree`'s listing IPC
   (`volli:list-directory`, dir watches) are reusable as-is for main-checkout
   browsing.
3. **Open tabs in the session view** — ticket scope: already true. Home scope:
   Home tabs are board + sessions today (`home-tabs.ts`); file tabs become a
   third kind, reusing the shared `FileWorkspaceState` reducer and `FileView`.
   This also **fixes bug §2.1 properly**: a project chat's file click lands in
   a Home file tab instead of bouncing the whole app to the Files nav.
4. **"Open in <editor>" menu** — new main IPC: detect installed editors
   (bundle-id probes: VS Code, Cursor, Zed, Xcode, plus Terminal apps),
   launch with the resolved absolute path (worktree-aware, same
   `resolveSafePath` guard), expose as a context-menu/dropdown on file tabs,
   tree/navigator rows, and the ticket repository card. Filled Phosphor icons
   per the context-menu convention. This is the honest answer to "most people
   would replace this with their own IDE anyway" — and it must resolve to the
   *worktree* copy for ticket scope, or it recreates §2.1 in an external app.
5. **Theme simplification** — collapse the editor catalog to exactly two
   shipped themes (one light, one dark) that follow resolved app appearance;
   retire the picker row, `editor-settings-model.ts`, and the per-theme
   dynamic-import catalog. **Scope note:** the ticket's phrasing ("simplify
   the theming system entirely") could also be read as the app-canvas token
   system; that system is load-bearing, recently invested-in (AGENTS.md
   documents it), and has its own ticket (VC-102 unified theming panel). This
   audit recommends reading it as *editor* theming; simplifying the canvas
   system is a separate product decision that should not ride along silently.

**Risks / order-of-operations:**

- Fix path routing (§2.1) *independently and first* — it bites today, in every
  scope, and none of the structural moves depend on it.
- Do not remove the nav item before Home file tabs exist, or project-session
  file clicks have nowhere to land.
- Worktree-aware "Open in" must ship with (or before) the nav removal, so the
  fallback exists the day the first-class surface disappears.

## 5. Recommended work breakdown

Ordered; each slice is independently shippable.

1. **Worktree-correct file opening from chats + friendly errors** (bug, high).
   Relativize tool paths against the session's venue root before `onOpenFile`;
   route a path that resolves into a ticket worktree to that ticket's file tab
   (or at minimum read through the worktree seam); map errno catch-alls to
   "File was not found"-class copy.
2. **Two-theme editor appearance** (high). Light + dark shiki themes keyed to
   resolved appearance; delete the catalog/picker; align Monaco chrome colors
   with app tokens where cheap (background, gutter, selection).
3. **Home-scope file access** (high). Files page in the Home rail; file tabs
   beside session tabs in the Home strip; project-chat file clicks land there.
4. **Remove Files from primary nav** (high; depends on 3). Retire
   `files-page.tsx` + `file-tab-strip.tsx` or rehome them; tolerant-read the
   persisted `"files"` nav key; keep the file tree component only if the Home
   rail adopts it.
5. **"Open in <editor> / Terminal" menu** (high; ships with or before 4).
   Editor detection + launch IPC; menu on file rows/tabs, worktree-aware.
6. **Language-coverage bump** (medium, cheap). Add the notable missing
   grammars (vue, svelte, objective-c, diff, dotenv, hcl, proto, lua, scala,
   dart, elixir…) and a shebang sniff; each grammar is one catalog line.
7. **Deliberately out of scope** (record as won't-do): problems panel, status
   bar, project-wide TS service, in-app search-across-files, file
   create/rename/delete. The demotion exists precisely so these stay unbuilt.

## 6. What must not be deleted with the Files page

The document registry + reconciliation stack (`editor/document-registry.ts`,
`live-document-reconciliation`, `text-reconciliation`, view-state mapping),
`volli-fs.ts`'s safety/watch machinery, `FileView`/`MonacoFileEditor`/
`MonacoDiffEditor`, Document Mode, and the shared `file-workspace.ts` reducer
all serve ticket tabs, artifacts, the ticket body, and chats. The Files *page*
is a thin consumer of that substrate; the demotion removes the consumer, not
the substrate.
