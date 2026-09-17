# Upstream: AI Elements

Three files in this directory are descended from Vercel's **AI Elements**, not
written here. They were copied in on 2026-07-30 by `17382b58` ("lab: vendor AI
Elements subset + shadcn token bridge for chat sessions") and have been edited
since. This file is the record the copies themselves point at.

- Repository: https://github.com/vercel/ai-elements
- Revision: `9310a1d3a8ddc881244e7c48ec0f5d215df92e70` (2026-03-06)
- License: Apache-2.0 — Copyright 2023 Vercel, Inc.
- Copied by hand through the shadcn-style registry, not by a tool that stays
  attached. There is no sync script and no submodule: an upstream change is
  read, judged, and applied deliberately, or it is not applied.

## How that revision was established

**It was not recorded at the time, so it was recovered from content.** This
matters, because the usual pins do not exist for this kind of dependency: the
`ai-elements` npm package is a CLI shim (~7KB, no component source), the
registry endpoint serves an unversioned "latest", and `pnpm-lock.yaml` therefore
has nothing to say about a component that was never a dependency. `17382b58`
added `ai@^6.0.238` and `@ai-sdk/react@^3.0.240` and named no elements version.

What was done instead, and what it proves:

1. `9310a1d3` is the newest revision of `packages/elements/src/prompt-input.tsx`
   at or before the vendoring commit's timestamp (2026-07-30T22:12:18Z). The
   next-newest change to that file is `58801e55` (2026-03-06, PR #382, "add
   screenshot action to the prompt input").
2. The copy as first committed carries PR #382's additions — `captureScreenshot`,
   `PromptInputActionAddScreenshot`, `ReferencedSourcesContext`, the
   `SourceDocumentUIPart` import — so it is post-#382, and `9310a1d3` is the only
   candidate left in the window.
3. Line-level agreement with the upstream file at `9310a1d3`, on lines no
   independent author would land on twice: the lucide import set and its order
   (`CornerDownLeftIcon, ImageIcon, Monitor, PlusIcon, SquareIcon, XIcon`), the
   `import type { ChatStatus, FileUIPart, SourceDocumentUIPart } from "ai";`
   line, the `new Error("Failed to load screen stream")` string, the
   `usePromptInputController()` and `usePromptInputReferencedSources` throw
   messages, and the comments `// Optional variants (do NOT throw). Useful for
dual-mode components.`, `// e.g., "image/*" or leave undefined for any`,
   `// Note: File input cannot be programmatically set for security reasons`,
   `// Don't clear on error - user may want to retry`, `// e.g: image/* -> image/`.

One known divergence was already present in the first commit: upstream's
`convertBlobUrlToDataUrl` assigns `reader.onloadend` / `reader.onerror` behind
`oxlint-disable` pragmas for `unicorn(prefer-add-event-listener)`, while the copy
here uses `addEventListener` — this repo's lint rules, applied on the way in.
So the copy was never byte-identical to `9310a1d3`, and the claim made here is a
content match, not a checksum.

`conversation.tsx` and `message.tsx` came from the same commit and the same
upstream tree (`packages/elements/src/conversation.tsx`,
`packages/elements/src/message.tsx`, both present at `9310a1d3`). Their
revision is inherited from the same argument rather than separately
reconstructed: far less of them survives, so there is far less to match on.

## Files taken, and how much of them is still upstream's

Measured as substantive lines (>40 characters) in the file today that appear
verbatim in the copy as first committed:

| File               | Substantive lines | Still verbatim | Attribution |
| ------------------ | ----------------- | -------------- | ----------- |
| `prompt-input.tsx` | 212               | 179            | required    |
| `conversation.tsx` | 138               | 15             | required    |
| `message.tsx`      | 95                | 11             | required    |
| `reasoning.tsx`    | 76                | 2              | no          |
| `shimmer.tsx`      | 46                | 2              | no          |

`prompt-input.tsx` is still mostly upstream's: the attachment state machine, the
accept/size/count validation and its error codes, the drop handlers, and the
blob→data-URL submit path are all theirs.

`conversation.tsx` and `message.tsx` are thinner but not clean-room. What
survives is the component skeleton and the literal class strings —
`ConversationContent` / `ConversationScrollButton` / `ConversationEmptyState`
and their `use-stick-to-bottom` wiring; `Message` / `MessageContent`, the
`"group flex w-full max-w-[95%] flex-col gap-2"` shell and the
`is-user` / `is-assistant` convention the chat CSS still keys off. That is
copied expression, so it is attributed.

`reasoning.tsx` and `shimmer.tsx` are **not** attributed, and the reason is that
nothing of upstream's is left in them. All that matches is `import { cn } from
"@renderer/lib/utils";`, `import { mermaid } from "@streamdown/mermaid";`, and
`export const Shimmer = memo(ShimmerComponent);`. Both files were rewritten
against their own designs — see their module comments. Attributing them would
be as wrong as failing to attribute the three above: it would claim Vercel wrote
something they did not.

## Divergences from upstream

Recorded because Apache-2.0 §4(b) requires the copies to say they changed, and
a bare "modified" tells a reader nothing.

- **Import paths and icons.** `@repo/shadcn-ui/*` → `@renderer/*`, and
  `lucide-react` → `@phosphor-icons/react` (`fbd3b1ee` retired lucide entirely).
- **The unused half was deleted** (`a7a79cdb`, 874 lines across the directory).
  `prompt-input.tsx` lost `PromptInputProvider` and its controller hooks,
  `PromptInputAttachment`/`PromptInputAttachments`, the add-attachments and
  add-screenshot menu actions, `PromptInputButton`, and the whole
  `ActionMenu` / `Select` / `HoverCard` / `TabsList` families. What is left is
  the form core, the textarea, the header/footer/tools slots, the submit
  button, and the `Command` wrappers.
- **Composer shell.** `ed70882a` and `a3562a7b` reshaped the surface around
  Volli's own composer (one rung, one `+`, a writing sheet and tinted control
  tray), which is where most of the non-deleted edits are.
- **`conversation.tsx` does not animate scroll.** Both `StickToBottom` props are
  `instant` rather than upstream's smooth default, on measured evidence; the
  file's own comment carries the reasoning.

## License

Apache-2.0. Two obligations apply to us and both are already discharged — this
section records where, so that a future change cannot quietly break them.

**§4(a), a copy of the License.** Volli Code is itself Apache-2.0 and ships the
full license text at the repository root: [`LICENSE`](../../../../../../../../LICENSE).
Anyone who receives this source receives that file with it, so the text is not
duplicated here. `vendor-provenance.test.ts` asserts the root `LICENSE` really
is Apache-2.0, because this discharge depends on it.

**§4(b), notice of modification.** Carried by each of the three files, in the
header block that points back here.

**§4(d), NOTICE.** Nothing to propagate: upstream has no `NOTICE` file at
`9310a1d3` (the repository root there holds `LICENSE`, `README.md` and no
notice file), so there is no attribution notice to reproduce.

The upstream `LICENSE` at that revision, in full — it is the short-form Apache
header rather than the whole 11KB text:

```text
Copyright 2023 Vercel, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
