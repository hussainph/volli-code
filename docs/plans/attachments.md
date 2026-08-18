# Attachments (VC-50)

Status: implemented.

What shipped, against the work order at the foot of this document: the shared
Blob model and storage (1, 2), ingest and the `volli-blob:` protocol (3),
preload commands and both Ticket surfaces (4), chat (5), and materialization
from `blob_links` (6). Plus two things the original order did not name — a
cumulative per-Session image budget, and boot-time collection of unreferenced
Blobs.

One piece of the plan below is deliberately NOT built: the send-time skip for a
model that takes no images. `ModelAccessModel.acceptsImageInput` gates the
attach affordance, which is where the plan said the capability should be
visible, but nothing re-checks it at send. Switching to a text-only model after
attaching an image therefore reaches the provider rather than degrading to the
path reference. The attachment is still materialized and still named in the
prompt by path, so the agent can open it either way; what is missing is the
quiet drop of the inline block.

One system for every file a user hands the app — a screenshot pasted into a
chat, a PDF spec dropped on the ticket composer, a design mock referenced from
a ticket body. Today none of that works: the only way to point the agent at
anything is `@relative/path`, which reaches repo files and nothing else.

## What exists today

Three things wear the word "attachment"; only one is real.

1. **Ticket attachments — backend complete, unreachable.** Migration 011
   (`ticket_attachments`), `db/attachments-repo.ts`, `main/attachment-store.ts`
   (bytes at `<userData>/attachments/<attachmentId>/<fileName>`),
   `attachment-materialize.ts` → `.volli/attachments/` in the session root, and
   `attachmentsSectionInput` composing them into the brief. Called from
   `worktree/ensure.ts` and `pty/scope.ts`. All of it works, and **nothing can
   create a row**: `createAttachment` has no non-test caller and there is no
   preload surface. The table is provably empty in production, which is what
   makes the restructure below free of data migration.
2. **The composer paperclip is not an attachment.** `composer-file-attach.tsx`
   ranks the repo file index and inserts `@relative/path` text.
3. **Chat is text-only.** `onSubmit(text, intent, resources)`; `PromptResource`
   is the skills/templates channel, not files.

Two seams already exist and are load-bearing for this plan: the RPC edge
carries an AI SDK `UIMessage` for `message.submit` (whose `parts` already admit
`FileUIPart`), and the vendored `ai-elements/prompt-input.tsx` already
implements drag/drop, paste, the file dialog, `maxFiles`/`maxFileSize` and an
`AttachmentsContext` — none of it wired up.

## Constraints that decided the design

- **Pi takes images, not documents.** `UserMessage.content: string |
  (TextContent | ImageContent)[]`, where `ImageContent` is `{type, data:
  base64, mimeType}`. There is no document/PDF content block. `Model.input:
  ("text" | "image")[]` is a per-model capability gate the catalog already
  reports; our `ModelAccessModel` descriptor does not surface it yet.
- **Inlining base64 into durable history is a known trap.** Claude Code writes
  pasted images as base64 straight into its transcript JSONL — a single user
  turn in a real local transcript held 3.6 MB across six image blocks. Because
  the block replays on every subsequent turn, one oversized image does not fail
  once, it corrupts the session: later text-only prompts fail and `--continue`
  breaks (anthropics/claude-code #8202, #12167, #19631, and others). Our history
  is re-read on every relaunch and the transcript artifact digest is frozen, so
  we inherit this exactly if bytes go into `session_events` or the artifact.
- **Worktrees are disposable.** `ensure.ts` prunes them and retention removes
  them, so nothing inside `.volli/attachments/` can be authoritative.
- **Every session has a `workspacePath`** — a ticket's worktree, or the project
  root for a ticketless Session. So a materialization target always exists.
- **The renderer CSP is `img-src 'self' data:`** and main already registers a
  privileged scheme (`PACKAGED_RENDERER_SCHEME`) via
  `registerSchemesAsPrivileged` + `protocol.handle`. Serving blobs to the
  renderer follows that established path.

## The model

**Separate the bytes from the thing they are attached to.** Our current
`ticket_attachments` owns both — ticket-keyed, id-keyed, no dedup, and
structurally unable to be referenced from a chat message. That is precisely the
shape Vibe Kanban shipped and then had to migrate away from
(`20250818150000_refactor_images_to_junction_tables.sql`: content-addressed
`images` + a `task_images` junction, "so that images can be associated with
multiple tasks and execution processes"). Their cloud model and Linear's both
land in the same place: a blob, plus a link row naming what it hangs off.

- **`blobs`** — bytes, content-addressed. `hash` (sha256) primary key, `mime`,
  `size_bytes`, `original_name`, `width`/`height` (images), `created_at`. Bytes
  at `<userData>/blobs/<hash[0:2]>/<hash>`. One store for every surface: the
  same screenshot pasted into a ticket and a chat is one blob. Dedup is not a
  micro-optimization here — screenshots get re-pasted constantly.
- **`blob_links`** — a thin row naming where a blob is attached: `id`,
  `blob_hash`, exactly one of `ticket_id` / `session_id`, `label`, `created_at`.
  Explicit nullable owners with a CHECK, rather than a generic
  `owner_kind`/`owner_id` pair, so a reader can see the two surfaces we
  actually have. `ticket_attachments` is replaced by this table; the `url` kind
  keeps its own row shape (a link attachment has no blob).

`Blob` is the only new noun. The chat surface needs no second one: a chat
attachment's link *is* its transcript part.

### Naming

`attachment` is already taken by the runtime binding (`SessionAttachment`,
`attachment.opened`, the durable `attachmentId` field), and those durable
strings are frozen. Files get `blob` in code. "Attachment" stays the
user-facing word in UI copy, where there is no ambiguity.

## How a file reaches the agent

One pipeline, one rule, chosen by file type rather than by surface.

**Everything materializes.** On session ensure, every blob linked to the
session (via its ticket and via the session itself) is copied into
`.volli/attachments/` under a deterministic, collision-free name and listed in
the brief with its label — the pipeline `attachment-materialize.ts` and
`materializedAttachmentNames` already implement, including the self-gitignore
(`VOLLI_GITIGNORE_CONTENT`). This is the ACP `resource_link` half: the agent
can open it with a tool, whatever the type.

**Images additionally inline.** At send time, in main, an image blob is read
from the store and passed to Pi as `ImageContent`. Never persisted as base64 —
the durable record holds only the reference. If the selected model's
`Model.input` lacks `"image"`, we skip the inline and the path reference still
stands, so an attachment degrades instead of failing.

`.volli/attachments/` is therefore a **rebuildable projection**, never the
source of truth. A pruned worktree loses nothing; the next ensure re-materializes
from the blob store. Materialization is already skip-if-exists with deterministic
names, so re-running is free.

PDFs and other documents are file references only for now (decided). Converting
PDF pages to images so they can be inlined is a later call, not a v1 gap.

## How a file gets back to the user

Blobs are served to the renderer over a registered `volli-blob:` privileged
scheme resolving `volli-blob:<hash>` against the store, with the scheme added
to the CSP's `img-src`. This works identically in dev and packaged, and it is
what makes an image in a reopened chat retrievable regardless of worktree state
— the transcript holds `volli-blob:<hash>`, the store holds the bytes, and
neither depends on a checkout that may have been pruned.

Rendering follows the type: **images render inline; every other file is an
inline chip** (name, type, size) — in the transcript, in the ticket body, and
in the composer.

## Guardrails

- **Cap on the way in, not at the API.** Oversized images are downscaled (or
  refused) at attach time, before anything enters durable history. Every one of
  the Claude Code corruption bugs is downstream of not doing this.
- Surface `Model.input` through `ModelAccessModel` so the attach affordance can
  say a model takes no images rather than failing at send.
- Unreferenced blobs are collected when their last link goes away.
- The `@path` picker is not superseded. It is the right answer for repo files
  and stays exactly as it is.

## Decisions settled in review

Four questions the plan above left open, answered. Recorded because each one
has a plausible alternative that would otherwise get re-argued.

### The Pi sidecar is a third durable store, and it gets a budget

The guardrail above says bytes never enter `session_events` or the transcript
artifact. That is not the whole durable surface. `submitUserMessage` reaches
Pi, and `pi/runtime.ts` writes every user message to its JSONL recovery sidecar
(`sidecar.appendMessage(durableMessage(...))`), which is replayed on attach
(`findEntries({ order: "oldestFirst" })`). Inlined base64 lands there — the same
artifact shape, and the same replay-every-turn mechanic, as the Claude Code
transcript corruption this plan is written against.

We accept it, because the alternative breaks the feature: a follow-up turn
("now make it blue") needs the image still in context, so reference-only
history would have to rehydrate on every replay. What the cited bugs actually
lacked was a *bound*, not reference semantics. So the 5 MB per-image ceiling is
joined by a **cumulative per-session budget** on inlined image bytes, enforced
at attach, refused with a message naming the session total.

### An attach before the Ticket exists imports eagerly

The new-Ticket composer has no `ticketId` to link against, so `owner` becomes
optional on import: bytes land as an unlinked Blob at attach time, and the link
is written once `ticket.create` returns an id. This puts the size refusal and
the dedup at the moment of attaching, which is when a person can act on them,
rather than after they have written the whole Ticket. The cost is that an
abandoned draft leaves unlinked Blobs, which makes collection load-bearing
rather than housekeeping.

### A repo file attaches as an `@` ref, not a snapshot

Attach and `@` overlap on repo files, and they differ in liveness: `@` points
at the live file, a snapshot is frozen under `.volli/attachments/`, which is
gitignored and rebuildable. An agent that edits the snapshot loses the edit
silently. So the attach gesture resolves by source:

| source | non-image | image |
| --- | --- | --- |
| in repo, `isExpressibleRefPath` | `@relative/path`, no Blob | `@relative/path` **and** a snapshot, so vision works |
| outside the repo, unexpressible path, or pasted | snapshot, chip | snapshot, inlined |

A repo image gets both halves deliberately: the ref so edits reach the real
file, the snapshot so the model can see the pixels. Two mechanics that the
grammar and the platform force into the fallback column:
`isExpressibleRefPath` rejects paths containing spaces (`docs/design notes.pdf`
is unreferenceable), and Electron 43 removed `File.path`, so a drop only knows
its origin if `webUtils.getPathForFile` is exposed through preload — a *pasted*
screenshot has no path at all and therefore always snapshots.

### Image-only messages send

`#submit` rejects an empty prompt with `PI_EMPTY_MESSAGE`. Dragging in a
screenshot and pressing return without typing is an ordinary gesture, so that
guard relaxes when the message carries image parts.

### Inlinable is narrower than image (ship review)

`isImageMime` (`image/*`) is presentation's predicate — what previews as a
picture. What may be handed to a model is `isInlinableImageMime`
(png/jpeg/gif/webp, Anthropic's documented set and the floor across
providers), because Pi passes `mimeType` verbatim as the wire `media_type`.
The gap matters: an inlined `image/svg+xml` would be refused by the provider,
and since it already persisted into Pi's sidecar it would replay and fail
every later turn — the exact wedge the budgets exist to prevent. So SVG/HEIC
preview as images, materialize as files, reach the model as path refs, skip
the 5 MB ceiling (they never enter history) and cost the session budget
nothing.

### A sent message renders its own attachments (ship review)

The transcript draws a user turn's file parts as read-only thumbs from the
message parts alone — `volli-blob:` URL, media type, file name; no fetch — so
the record survives the attachment rows being removed later. `speaks` counts a
`file` part as drawable, so an attachment-only message is a turn rather than
an empty bubble.

### The chat strip dies with the pane (ship review)

A chat attachment links to the Session at attach time (that is what makes the
budget refusable while the file is in hand), but until ⏎ carries it into a
message, the strip's React state is the only pointer to that link. So
unmounting or switching Sessions detaches whatever is still pending
(`discardPending`, racing-safe via a synchronously-kept ref). Residue: a strip
abandoned by quitting the app leaks its links until the Session is deleted —
accepted as bounded, revisit if drafts ever persist attachments.

### `volli:blob-attach` is a read-by-path primitive (ship review)

The attach IPC takes an absolute `sourcePath` and reads it in main, and the
protocol serves the bytes back — so a hostile renderer could exfiltrate any
readable file. This matches the app's existing trust model (the renderer is
our own code behind context isolation, and already holds broader read
surfaces), but it is a wider door than it looks; noted so nobody mistakes it
for an oversight.

## Work order

1. **Shared model** — `Blob`, hash/path derivation, the materialization naming
   already in `ticket-attachment.ts` re-pointed at blobs. Pure, 100% covered.
2. **Storage** — `blobs` + `blob_links` migration (no data migration: the old
   table has never held a row), repo layer, content-addressed file store
   replacing `attachment-store.ts`'s id-keyed layout.
3. **Ingest + serve** — import from a path/bytes with hashing and the size cap;
   the `volli-blob:` protocol and CSP entry.
4. **Preload + ticket surfaces** — semantic commands, composer attach, ticket
   detail list/add/remove, inline rendering in the body. Closes #94.
5. **Chat** — carry `FileUIPart` through `message.submit`, inline images at
   send, render inline/chips. Note that `ai-elements/prompt-input.tsx` vendors
   only the attachment *state* layer (`AttachmentsContext`, add/remove/clear,
   drag/drop/paste, `accept`/`maxFiles`/`maxFileSize`); there are no chip or
   preview components, so those get written here. Its `FileUIPart.url` is a
   renderer-local `URL.createObjectURL` blob URL, meaningless in main — the
   part carried across the RPC edge holds `volli-blob:<hash>` instead, obtained
   by importing through main first. `submitUserMessage` is typed `text: string`
   in `shared/agent-runtime.ts` and has to widen to content blocks, including
   the first-turn `composeFirstUserMessage` path.
6. **Materialization + brief** — re-point `attachment-materialize.ts` at
   `blob_links` and include session-linked blobs, not just ticket ones.
