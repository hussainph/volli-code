# Global artifacts + @file refs

Grilled and settled 2026-07-17. Supersedes the two-tier artifacts scheme from
`ticket-detail-mvp.md` decisions #13–17 (marked superseded there). This doc is
the decision record **and** the implementation contract for the rework.

## Decisions

1. **One tier, per-project.** `<project>/.volli/artifacts/` is the only
   artifacts location. `.volli/tickets/` dies — no dir helpers, no code path.
   No migration code: old ticket-tier files stay on disk, inert (gitignored,
   recoverable by hand).
2. **The ticket Doc is the scratch pad.** Ephemeral plans/notes belong in the
   ticket body (agents will write it via the volli CLI, MVP scope). Only
   things that outlive a ticket become artifacts — and those are
   project-scoped by nature.
3. **@file = @artifact, whole-repo scope.** In the doc editor, `@` opens a
   Claude-Code-style fuzzy picker over the project file index
   (gitignore-respecting, `.volli/artifacts/` force-included, artifacts ranked
   first).
4. **Stored form is plain text**: `@relative/path` in the markdown — zero
   translation when the doc becomes an agent prompt. The live editor decorates
   @tokens that resolve to a real file into clickable chips; dangling refs
   degrade to plain text. No new markdown dialect, no URI scheme.
5. **Clicking a chip opens a `file` tab** in the ticket tab strip (the
   `artifacts` tab kind is deleted). Open file tabs + the active tab persist
   in workspace UI state (per project, per ticket) across restarts.
6. **Worktree-aware resolution**: inside a ticket that has a live worktree,
   repo paths resolve to the worktree copy (badge on the tab); otherwise the
   main checkout. `.volli/**` always resolves to the main repo path.
7. **Markdown edits, everything else read-only**: markdown → the existing
   live editor with autosave + mtime conflict guard; code/text → read-only
   CodeMirror (plain monospace, line numbers; **grammar syntax highlighting
   deferred** — `@codemirror/language-data` would pull ~40 grammar packages
   for a peek surface, not worth it in v1); images → inline data-URI viewer;
   binary/oversize → stub tab with Reveal in Finder.
8. **Creation lives in the picker**: a "Create artifact '<name>'" row writes a
   templated `.md` into `.volli/artifacts/`, inserts the @ref at the cursor,
   and opens the tab.
9. **Agent env contract**: `VOLLI_TICKET` stays (display id);
   `VOLLI_TICKET_DIR` is deleted; `VOLLI_ARTIFACTS_DIR` (absolute,
   main-repo `.volli/artifacts`) is added — injected for ticket-scoped *and*
   project-scoped scratch sessions.
10. **No browse surface for now.** The Files nav page stays a placeholder;
    the right-sidebar/nav-model rethink (file tree, tickets-as-tabs, git
    diffs) is deferred to its own session.

Known v1 limitations (accepted): paths containing whitespace are excluded
from the picker (the plain-text token can't hold spaces); renames dangle refs
(they degrade to plain text); read-only chips in the *read-only* markdown
renderer (comments/feed) are deferred — only CodeMirror surfaces decorate.

## Contract

### Shared (`packages/shared`)

`volli-dir.ts`:
- Keep `VOLLI_DIR_NAME`, `volliDir`, `projectArtifactsDir`,
  `VOLLI_GITIGNORE_CONTENT`, `VOLLI_TICKET_ENV`.
- Delete `ticketDir`, `ticketArtifactsDir`, `VOLLI_TICKET_DIR_ENV`.
- Add `VOLLI_ARTIFACTS_DIR_ENV = "VOLLI_ARTIFACTS_DIR"`.
- `ticketSessionEnv(projectPath, displayId)` → `{ VOLLI_TICKET,
  VOLLI_ARTIFACTS_DIR }`; add `projectSessionEnv(projectPath)` →
  `{ VOLLI_ARTIFACTS_DIR }` for project-scoped scratch sessions.

`artifact.ts` → becomes the **file classification + ref domain** (rename to
`file-ref.ts`, keep exports flowing through `index.ts`):
- `FileKind = "markdown" | "image" | "other"` (was `ArtifactKind`);
  `classifyFileKind`, `imageMimeType` keep their logic.
- `ArtifactTier`, `tier`, promote-related helpers die.
- Name-safety helpers (`isValidNewArtifactName`, `withMarkdownExtension`,
  `artifactBaseName`) survive for the create flow.
- New pure, unit-tested: `parseFileRefs(markdown): { path, from, to }[]` —
  finds `@`-tokens at start-of-line/after-whitespace/after `(`; a path is a
  run of `[A-Za-z0-9._\-/]` containing at least one `/` or `.`; trailing
  `.,;:!?)` punctuation is stripped. Both editor decoration and any future
  renderer share this one parser.
- New `IndexedFile = { relPath: string; kind: FileKind; artifact: boolean }`
  and a pure fuzzy scorer `scoreFileMatch(query, relPath)` (subsequence
  match; artifacts and shallow paths rank first) so the picker logic is
  unit-tested in shared.

### IPC (`ipc.ts`) — replaces all `volli:artifact-*` channels

- `volli:file-index` `{projectId}` → `Result<{ files: IndexedFile[];
  truncated: boolean }>`. Main builds it from `git ls-files --cached
  --others --exclude-standard` in the main checkout (fallback: bounded
  recursive walk skipping `.git`/`node_modules`) + a walk of
  `.volli/artifacts/` with `artifact: true`. Cap ~20k entries → `truncated`.
  Invoked fresh on each picker open; no index subscription.
- `volli:file-read` `{projectId, ticketId?, relPath}` →
  `Result<{ source: "worktree" | "main"; kind: FileKind; size: number;
  mtime: number; content: { type: "text"; text: string; truncated: boolean }
  | { type: "image"; dataUrl: string } | { type: "binary" } }>`.
  Text cap ~1 MiB (`truncated`); NUL-sniff → `binary`.
- `volli:file-write` `{projectId, ticketId?, relPath, content,
  expectedMtime?}` → `Result<{ mtime: number }>`. Markdown-only (main
  enforces extension); same resolution rule as read; `expectedMtime`
  mismatch → error (existing conflict-guard pattern).
- `volli:artifact-create` `{projectId, name}` →
  `Result<{ relPath: string }>` — templated `.md` in `.volli/artifacts/`;
  `relPath` is project-relative (`.volli/artifacts/<name>.md`), insertable
  directly as an @ref.
- `volli:file-reveal` `{projectId, ticketId?, relPath}` → `Result` —
  reveal the resolved copy in Finder.
- `volli:file-watch` / `volli:file-unwatch` `{projectId, ticketId?,
  relPath}` per open tab; push event `volli:file-changed` `{projectId,
  relPath, source}` (debounced, re-arms across atomic replaces — reuse the
  ArtifactWatchManager pattern in `volli-fs.ts`). Renderer re-reads
  read-only tabs on event; the markdown editor keeps its existing
  unfocused-refresh behavior.

Resolution rule (main, one function): `.volli/**` → main repo path; other
relPaths → the ticket's live worktree path when `ticketId` is given and a
worktree exists (if worktree infra isn't queryable yet, resolve main and
leave the seam), else main. Path safety: normalized relPath, reject
`..`/absolute, realpath containment inside the resolved root.

### Preload

`api.artifacts` → `api.files` mirroring the channels above
(`index`, `read`, `write`, `createArtifact`, `reveal`, `watch`, `unwatch`,
`onChanged`). Type-only imports from shared, as today.

### Renderer

- `TicketTabKind = "doc" | "session" | "file"`; file tab id =
  `file:<relPath>`, label = basename, closable; worktree badge driven by the
  read result's `source`.
- New `file-tab.tsx` hosts by kind: markdown → generalized editor view
  (rework `artifact-viewer.tsx` → `file-view.tsx` on the `api.files`
  surface); code/text → read-only CodeMirror + `@codemirror/language-data`
  highlighting; image → inline; binary/truncated → stub + Reveal.
- @ picker: CodeMirror autocomplete in `markdown-live-editor.tsx` (enabled
  for both ticket body and markdown file tabs) triggered on `@`, backed by a
  ~10s-cached `api.files.index`, filtered/ranked by `scoreFileMatch`;
  create-row when no exact match → `createArtifact` + insert + open tab.
  (Adds one dep: `@codemirror/autocomplete`.)
- Chip decoration in `live-preview.ts` via `parseFileRefs` against the
  cached index (chip = icon + basename; unresolved = plain text); click →
  open/focus the file tab.
- Workspace store: `WorkspaceUiState` gains persisted
  `ticketTabs: Record<ticketId, { files: string[]; active: string }>`
  (sanitized on rehydrate: unknown session ids → fall back to `"doc"`;
  empty records pruned). `ticket-detail.tsx` swaps its local `useState`
  active-tab for the store.
- Delete `ticket-artifacts-tab.tsx`, `artifact-list.tsx`,
  `artifact-list-utils.ts`; remove the `ARTIFACTS_TAB` constant.

### Main teardown

- `volli-fs.ts`: rework listing/read/write/watch to the contract above;
  delete tier logic + promote; keep two-layer path safety and the
  `.volli` ensure + self-gitignore.
- PTY spawn: swap `ticketSessionEnv` (new shape) and inject
  `projectSessionEnv` for project-scoped scratch sessions.
