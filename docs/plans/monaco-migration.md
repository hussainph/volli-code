# Monaco Migration

**Status**: ready for implementation · **Branch**: `feat/monaco-migration` · **Decisions**: `docs/CONCEPT.md` #46–#65

This plan replaces every CodeMirror surface with Monaco and turns the existing Files navigation into a real repository workspace. It also adds the ticket-scoped Change Set needed for quick review and occasional human intervention.

The migration is intentionally not a conventional IDE build. Volli remains board-first and agent-led: people usually observe work at ticket altitude, then deliberately zoom into a Ticket Body, referenced context, a file, or a diff when judgment is useful.

## 1. Delivery boundary

### In this migration

- Make Monaco work in both Vite development and the packaged Electron app.
- Establish one shared Monaco model layer for Ticket Bodies, repository files, Artifacts, and modified diff sides.
- Replace the CodeMirror Markdown editor, live-preview decorations, `@file` completion/chips, and read-only code peek.
- Make Project Files a first-class main-checkout workspace with a file tree and persistent preview/pinned tabs.
- Make ticket Files and Changes navigators open worktree-scoped file and diff tabs in the existing ticket tab strip.
- Add real Change Set content, including committed, staged, unstaged, and untracked outcomes relative to the ticket base.
- Keep open tabs synchronized with agent filesystem changes without routine reload prompts.
- Preserve explicit save for repository code and document-style autosave for the Ticket Body and Markdown Artifacts.
- Remove every CodeMirror dependency and import once all four existing surfaces have moved.

### Designed here, delivered as follow-ups

- The generalized Split Tab/session-ownership redesign from decisions #57–#59. Monaco must not introduce a temporary editor-only split system; the existing terminal split behavior remains until the shared workspace-composition track replaces it.
- Runtime Brief reference manifests and real-harness acceptance certification. The contract is settled in #62–#63, but it does not block replacing the editor.
- Reference-aware rename/delete actions. Project Files can ship browse/open/edit first; operations then use #63–#64 rather than a naive filesystem mutation.
- Attachment import UI, orphaned attachment-byte cleanup, captured URL snapshots, and rich HTML Artifact authoring.
- Full language-server or VS Code extension-host support, remote GitHub review/comments, reviewed-file bookkeeping, and the future command-palette/navigation expansion.

This boundary keeps the branch centered on code understanding and review while preserving the larger product decisions as explicit next seams.

## 2. Current seams to deepen

| Existing seam | Current state | Migration |
|---|---|---|
| `components/pages/files-page.tsx` | Placeholder | Project Files workbench and tab host |
| `components/sidebar/file-tree.tsx` | Lazy directory tree; file rows inert | Open preview/pinned main-checkout tabs |
| `components/ticket/file-view.tsx` | Markdown autosave; other text read-only CodeMirror | Shared Monaco file surface with policy-driven save behavior |
| `components/editor/*` | CodeMirror live preview and `@file` extension | Monaco Document Mode and completion/decorations |
| `stores/workspace.ts` | Ticket file tabs persisted; no Project Files tabs | Generalized project/ticket tab descriptors and preview state |
| `main/volli-fs.ts` | Read any file; write Markdown only; per-file watches | Text writes, identity-complete events, and later file operations |
| `main/worktree/diff.ts` | Path and line-count summaries | Unified Change Set plus per-file base content |
| `components/ticket/ticket-detail.tsx` | Ticket Body/files/sessions tabs and collapsible Sessions/History/Details rail | Icon-mode Sessions/Files/Changes/Properties navigator |
| `stores/sessions.ts` | One tab may own a recursive tree of sessions | Preserved during this migration; replaced by the Split Tab track |

Renderer code continues to use preload APIs only. Filesystem, git, path containment, and Electron protocol handling remain main-process responsibilities.

## 3. Packaged-renderer prerequisite

The packaged app currently uses `BrowserWindow.loadFile`. Monaco’s language services use web workers, and Monaco explicitly documents that a `file://` page cannot create them. Production therefore moves to an app-only origin before any editor surface migrates.

### Contract

1. Register a standard, secure scheme such as `volli-app` before `app.ready`.
2. After readiness, install `protocol.handle` for one host, for example `volli-app://bundle/`.
3. Resolve requested asset paths beneath the built renderer directory, reject traversal and unknown hosts, and serve them with Electron’s network stack.
4. Load `volli-app://bundle/index.html` in production; keep the Vite HTTP URL in development.
5. Update the pure navigation policy and its tests to accept only the dev origin or exact packaged app origin.
6. Keep the existing CSP. Add `worker-src 'self'` if Chromium does not inherit it cleanly from `script-src`; do not enable `bypassCSP`.
7. Prove a real Monaco worker starts in a packaged smoke test before building editor features.

This also narrows the renderer’s file access compared with `file://`, matching Electron’s security guidance.

References:

- [Monaco integration and worker guidance](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md)
- [Monaco model and worker notes](https://github.com/microsoft/monaco-editor)
- [Electron custom protocol API](https://www.electronjs.org/docs/latest/api/protocol)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)

## 4. Monaco runtime

Use `monaco-editor` directly rather than a React wrapper. Volli needs explicit ownership of models, view state, diff models, and disposal across several tab systems; hiding that lifecycle behind a component wrapper adds little.

### Workers and loading

- Configure `MonacoEnvironment.getWorker` before importing the editor.
- Bundle the editor worker and the JSON, CSS, HTML, and TypeScript/JavaScript workers through Vite `?worker` imports.
- Load the runtime lazily when the first editor surface opens, but keep one initialization promise so concurrent opens cannot configure Monaco twice.
- Define one Volli dark theme from the canonical CSS variables rather than copying a VS Code theme.
- Use Monaco’s public ESM API only; its repository treats `monaco.d.ts` as the versioned API surface.

### Document identity

One logical document owns one `ITextModel`, regardless of how many views show it.

```ts
type DocumentIdentity =
  | {
      kind: "file";
      projectId: string;
      checkout: { kind: "main" } | { kind: "ticket"; ticketId: string };
      relPath: string;
    }
  | { kind: "ticket-body"; projectId: string; ticketId: string }
  | {
      kind: "diff-base";
      projectId: string;
      ticketId: string;
      baseRevision: string;
      relPath: string;
    };
```

Generate deterministic Monaco URIs from this union. Main-checkout and ticket-worktree copies of the same relative path must never share a model. A file tab and the modified side of that ticket file’s diff must share one.

The registry owns:

- The Monaco model and detected language.
- The last disk/record baseline and mtime or row version.
- Dirty state and save policy.
- The latest external revision observed.
- View reference counts and disposal.
- Serializable per-view cursor, selection, folding, and scroll state.

Tabs persist identity and layout, never file contents. Models load lazily when first shown. A clean model may be disposed when no surface references it; a dirty model must remain guarded until saved or discarded.

## 5. Editor policies

The editor engine is shared, but behavior follows the document’s role.

| Surface | Default presentation | Write policy |
|---|---|---|
| Ticket Body | Document Mode | Debounced autosave to ticket record |
| Markdown Artifact | Document Mode | Debounced autosave to Artifact file |
| Repository file, including Markdown | Source Mode | Explicit save with `⌘S` |
| Diff original/base | Source Mode | Immutable |
| Diff modified/live | Source Mode | Same explicit-save model as its file tab |
| Image | Image viewer | Read-only |
| HTML Artifact | Source initially; isolated preview later | Explicit until its richer Artifact flow exists |
| Binary/oversize | Metadata and Reveal in Finder | Read-only |

Every failed mutation remains visible through the existing toast/banner conventions.

### Source Mode

- Language comes from the relative path, with plaintext fallback.
- Line numbers, find/replace, folding, bracket matching, multi-cursor, minimap preference, and native Monaco accessibility are available.
- `⌘S` routes through the model registry, not an editor-local handler.
- Editing or explicitly pinning a preview tab makes it persistent.
- Dirty tabs cannot be replaced or closed without save/discard/cancel.

This migration does not promise repository-wide IntelliSense. Monaco’s built-in providers may use correct model URIs, but cross-file TypeScript resolution, LSPs, and extension-host behavior are later capabilities.

### Document Mode

Document Mode is a lossless projection over canonical Markdown, not a second document format.

- Keep `@lezer/markdown` as an editor-independent parser if it remains useful; remove only CodeMirror and its adapters.
- Port the current live-preview behaviors into a Monaco contribution using decorations, content widgets, and view zones.
- Reveal source punctuation around the active cursor/selection and keep unknown syntax byte-faithful.
- Implement headings, emphasis, links, lists, code, blockquotes, checkboxes, and the existing image/link safety behavior incrementally.
- Port `@file` suggestions through a Monaco completion provider.
- Decorate resolving `@relative/path` tokens as clickable references without replacing the underlying text.
- Keep a direct Source Mode toggle as an escape hatch.
- Use Document Mode by default only for Ticket Bodies and Markdown Artifacts. A repository Markdown file remains source-first because it participates in the code checkout and explicit-save contract.

The first Document Mode slice must preserve text exactly across open, edit, autosave, close, and reopen before visual parity work continues.

## 6. File backend and live models

### IPC evolution

Extend the typed file contract rather than creating renderer-side filesystem shortcuts:

- Allow guarded UTF-8 writes for supported text files, not just Markdown.
- Add create/rename/delete operations only with normalized project-relative paths and main-process containment checks.
- Include `ticketId: string | null` in `FileChangedEvent`; `projectId + ticketId + relPath` must identify the same document as the registry key.
- Return enough revision metadata from reads and writes to distinguish a local save echo from a new external edit.
- Add directory/index change subscription for visible file trees; do not recursively hydrate the whole repository into renderer state.
- Preserve text-size caps and binary sniffing. Oversize files remain read-only until a deliberate large-file design exists.

### External-change reconciliation

Let:

- `A` be the last synchronized baseline.
- `L` be the current local Monaco value.
- `D` be the new disk value.

On a watch event:

1. If `L === A`, replace the model with `D` while preserving view state.
2. If `D === A`, keep the local draft.
3. Otherwise, compute changes `A → L` and `A → D`.
4. If the changed ranges do not overlap, apply the disk changes onto the local model and advance the baseline.
5. If they overlap, keep both versions and show one small conflict affordance. Never overwrite either side.

The merge calculation is a pure, unit-tested module. It does not become a permanent merge UI or collaborative-editing protocol. This is enough for the expected pattern of agent-owned edits and occasional small human corrections.

An agent change to an already-inspected file sets the passive “updated” indicator. Reopening the file or diff clears it.

## 7. Project Files

Project Files remains the Files item in the primary left navigation and is always rooted in the Main checkout.

### Tree

- Keep the current lazy directory loading and per-project expansion memory.
- File single-click opens or replaces the workspace’s preview tab.
- Double-click, editing, dragging into a split in the later Split Tab track, or an explicit Pin makes the tab persistent.
- Add context-menu actions with filled Phosphor icons. Rename/delete land only with the reference-impact flow from #63–#64.
- Directory changes refresh only affected expanded listings.

### Workbench

- Replace `FilesPage` with a full-width tab strip and editor host.
- Persist tab identities, order, pin/preview state, active tab, and view state per project.
- Returning from Board or Sessions restores the prior Project Files workspace lazily.
- The application may still launch on Board; Project Files restoration begins when the user enters it.
- Main-checkout edits are ordinary human edits and never participate in ticket automation.

## 8. Ticket navigator and tabs

Replace the current stacked Sessions/History/Details treatment with one compact icon-mode rail:

- **Sessions** lists durable ticket sessions and focuses the exact session surface.
- **Files** exposes ticket-worktree files and referenced context; selecting an item opens or focuses a file tab.
- **Changes** shows the Change Set’s compact flat list; selecting an item opens or focuses its diff tab.
- **Properties** renders ticket metadata and lifecycle controls directly in the rail.

Changing rail mode never opens, closes, or replaces a main-view tab. Only selecting a list item changes the main tab. Agent changes may update list rows and indicators, but never auto-open a file or diff.

The Ticket Body remains an ordinary persistent tab in the main strip. Rename code-facing `doc` identifiers and `TicketDocTab` toward Ticket Body terminology as part of the migration, with persisted-state compatibility for the old `"doc"` key.

## 9. Change Set and Monaco diff

The Change Set is the ticket’s current worktree outcome relative to its recorded base, not merely the latest commit or dirty tree.

### Main-process git contract

Add a composed worktree read model:

```ts
interface ChangeSetFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

interface ChangeSetSnapshot {
  baseRevision: string;
  headRevision: string;
  files: ChangeSetFile[];
  insertions: number;
  deletions: number;
  revision: string;
}
```

- Resolve and stamp the same comparison base used by worktree status.
- Compare that base revision to the current working tree so committed, staged, unstaged, and untracked outcomes coexist.
- Use NUL-delimited git output for path safety and rename detection.
- Read an original file from the base tree without checking it out.
- Read the live modified side through the existing ticket-aware file path.
- Represent untracked files with an empty original; deleted files with an empty modified side; binary files with a non-editor stub.
- Return real git stderr on failure.

The existing summary endpoint can be implemented through this composed model so the Details/Properties surface and Changes rail cannot disagree.

### Renderer

- The Changes rail uses a flat list: filename, muted parent path, status, and line counts.
- Opening a row creates one diff tab with an immutable base model and the shared live file model.
- Default to inline diff; remember the side-by-side preference.
- Initial keyboard focus remains in the Changes list.
- Saving the modified side uses the same explicit-save path and dirty marker as the file tab.
- Refresh the snapshot on debounced worktree filesystem/git changes while the ticket workspace is live.

Monaco’s public diff editor API is the implementation boundary; do not parse or render hunks in React.

## 10. Reference-aware file operations

These operations are deliberately after the read/edit/diff loop works.

- Parse references with the shared `parseFileRefs`; do not create a second reference grammar.
- Main performs the impact query across non-archived Ticket Bodies in the same project.
- Artifact or Main-checkout rename may offer to rewrite affected active tickets. If a ticket has a worktree that does not yet contain the new repository path, the dialog states that the reference may remain unresolved until that worktree synchronizes.
- Ticket Files rename rewrites only the owning Ticket Body because the change is branch-local.
- Rename defaults to `Rename and update references`; `Rename only` and `Cancel` remain available.
- Delete defaults to `Cancel`; `Delete anyway` preserves the tokens as Dangling References.
- Apply a rename and chosen Ticket Body rewrites as one coordinated command. If the filesystem mutation succeeds but a DB update fails, surface the partial result explicitly and offer the affected tickets; never report blanket success.
- External renames/deletes cannot preflight, so the refreshed index and Runtime Brief surface them as Dangling References.

Archived Ticket Bodies are never rewritten.

## 11. Split Tab follow-on

Do not wire Monaco to `SessionLayout`. That structure currently makes a session tab own several separately persisted PTYs, which decisions #57–#59 supersede.

The follow-on track will:

1. Make each Session own exactly one PTY, durable record, history, and resume identity.
2. Introduce a surface descriptor for Session, Ticket Body, file, Artifact, and diff tabs.
3. Move recursive layout geometry into a Split Tab above those independent surfaces.
4. Support directional splitting, drag/drop composition, member focus/extraction, Separate All, equalization, rename, and aggregate dirty/attention state.
5. Keep live terminal engines model-resident while surfaces move between ordinary and Split Tabs.

The Monaco registry and document identities in this plan are prerequisites for that work. No editor-specific split implementation should be built and later discarded.

## 12. Implementation sequence

Each slice should be independently reviewable and land with its own focused tests.

1. **Packaged Monaco proof**
   - Secure custom protocol, navigation-policy migration, CSP worker support.
   - Install `monaco-editor`, configure workers/theme, render a disposable proof editor.
   - Packaged Electron smoke proves worker startup and removes the proof surface.
2. **Shared model foundation**
   - Document identities, model registry, view-state ownership, language mapping.
   - Replace the read-only CodeMirror code peek with Monaco.
3. **Project Files vertical slice**
   - Persistent preview/pinned tabs, file-tree activation, explicit text save, dirty close guard.
   - Main-checkout live refresh.
4. **Document Mode and CodeMirror removal**
   - Port Ticket Body, composer, Markdown Artifacts, live preview, and `@file` interactions.
   - Preserve autosave and byte fidelity.
   - Remove CodeMirror packages/imports and obsolete adapter files.
5. **Ticket rail and Change Set**
   - Icon-mode rail shell, Files/Changes navigators, composed git backend, Monaco diff tabs.
   - Shared modified models, inline/side-by-side preference, updated indicators.
6. **Reconciliation hardening**
   - Identity-complete watch events, non-overlapping automatic merge, rare conflict affordance.
   - Agent-write and local-save race tests.
7. **Reference operations**
   - Impact queries, rename/delete dialogs, coordinated rewrites, Dangling Reference states.
8. **Follow-up tracks**
   - Split Tabs/session ownership.
   - Runtime Brief manifest and cross-harness acceptance suite.
   - Attachment and richer Artifact lifecycle work.

## 13. Testing contract

### Pure/unit

- Document-identity and Monaco-URI uniqueness across projects, main checkouts, tickets, and diff bases.
- Language selection and editor policy selection.
- Preview/pin/dirty tab transitions and persisted-state sanitization.
- Three-way reconciliation: clean adoption, non-overlapping merge, overlapping collision, delete/recreate, local-save echo.
- Change Set parsing for spaces, Unicode, additions, deletions, binaries, untracked files, and renames.
- Reference impact and exact-token rewrite behavior.
- Navigation policy and custom-protocol path containment.

### Main/IPC

- Every file request is project-relative and containment-checked.
- Main and ticket paths resolve to the correct checkout.
- Text writes remain version-guarded and errors cross preload intact.
- Watch events carry full identity and re-arm across atomic replaces.
- Change Set base reads never mutate the checkout.
- Rename/delete never mutate archived Ticket Bodies.

### Packaged Electron

The packaged app is the required proof seam:

1. Launch from the custom app origin and verify Monaco’s editor and language worker initialize without fallback warnings.
2. Open a Main-checkout file from the left tree, edit, verify the dirty marker, save with `⌘S`, and assert disk bytes.
3. Open a Ticket Body and Markdown Artifact, verify Document Mode round-trips exact Markdown and autosaves.
4. Open a ticket-worktree file, modify it externally as an agent would, and verify the open clean model updates without reopening.
5. Make a small dirty human edit plus a disjoint external edit and verify automatic reconciliation.
6. Create committed, dirty, renamed, deleted, and untracked ticket changes; verify the flat Changes list and Monaco diff contents.
7. Verify opening a changed file requires a click and never steals focus from the Changes navigator.
8. Restart and verify Project Files and ticket tab restoration without eager file-content loading.

### Completion gates

- `rg -i "codemirror" apps packages pnpm-lock.yaml` finds no runtime dependency, import, or stale plan language that still describes current behavior.
- `vp run -r typecheck`
- `vp run -r test`
- `vp check`
- `pnpm run build` and the packaged Monaco smoke
- `act pull_request --container-architecture linux/amd64` before review

## 14. Definition of done

The migration is complete when:

- Monaco is the only code/document editor engine in the application.
- Project Files is a usable, resumable Main-checkout workspace.
- Ticket Files and Changes provide deliberate zoom-in without turning review into mandatory bookkeeping.
- File and diff views of one ticket path share a live model.
- Agent changes appear safely in open tabs, and ordinary external edits do not create modal noise.
- Ticket Bodies and Markdown Artifacts remain canonical Markdown with a first-class human editing experience.
- Git diffs show the ticket’s complete current outcome relative to its base.
- The packaged application runs Monaco workers under the hardened app origin.
- Existing terminal lifecycle and keep-alive guarantees have not regressed.
