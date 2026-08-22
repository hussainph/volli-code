/**
 * Attaching files from a composer (VC-50).
 *
 * The renderer's whole job here is to say what arrived and where from; main
 * decides what it becomes. That split is deliberate — whether a file is a
 * repository path worth naming live or foreign bytes worth snapshotting
 * depends on the project roots and on reading the file, and the renderer is
 * entitled to neither.
 *
 * So a drop hands over its `sourcePath` when it has one and its bytes when it
 * does not. A file already on disk is never read here: for a repository
 * document the answer is an `@` reference and nobody needs the bytes at all,
 * and reading a 200 MB video into the renderer to find that out would be
 * absurd.
 */
import * as React from "react";
import type { BlobLinkView } from "@volli/shared";
import type { BlobAttachInput } from "../../../ipc/contract";

export interface UseAttachmentsOptions {
  /** Where the resulting links hang, or `{ unowned: true }` while a Ticket is still being composed. */
  owner: BlobAttachInput["owner"];
  /** Absolute workspace root an `@` ref would resolve against; without it every file snapshots. */
  refRoot?: string | undefined;
  /** A repository file was named live instead of copied — insert `@relPath` into the text. */
  onRefInsert?: (relPath: string) => void;
  /** A refusal a person can act on: too big, or a chat at its image budget. */
  onError?: (message: string) => void;
  /**
   * The strip changed, with the new list (VC-137). Called synchronously at the
   * mutation, from the same "last write wins" list the mutators keep — so a
   * caller persisting the strip beside its draft text writes the truth, not a
   * render that may not have happened yet.
   */
  onChange?: (attachments: readonly BlobLinkView[]) => void;
}

export interface AttachmentsHandle {
  attachments: readonly BlobLinkView[];
  /** Attaches everything dropped, pasted or picked, in order. */
  attachFiles: (files: Iterable<File>) => Promise<void>;
  remove: (attachment: BlobLinkView) => Promise<void>;
  /** Forgets the strip without detaching anything — for a composer that has just sent. */
  clear: () => void;
  /** Replaces the strip, for a surface that loads its attachments from the database. */
  reset: (attachments: readonly BlobLinkView[]) => void;
}

export function useAttachments(options: UseAttachmentsOptions): AttachmentsHandle {
  const { owner, refRoot, onRefInsert, onError, onChange } = options;
  const [attachments, setAttachments] = React.useState<readonly BlobLinkView[]>([]);
  // The strip as of the LAST MUTATION, not the last render — every mutator
  // below writes it through `commit` before (or instead of) awaiting anything,
  // which is what lets a caller's `onChange` and a seeding effect read the
  // truth without waiting for a render that may not have happened yet.
  const live = React.useRef<readonly BlobLinkView[]>([]);

  // Read through a ref so `attachFiles` keeps a stable identity across renders
  // — it is handed to drag/paste handlers that would otherwise re-bind on every
  // keystroke in the composer beside them. `onChange` rides along for the same
  // reason: `commit` must stay stable too, and it is the one that calls it.
  const latest = React.useRef({ owner, refRoot, onRefInsert, onError, onChange });
  latest.current = { owner, refRoot, onRefInsert, onError, onChange };

  // Write the strip everywhere it must be, in one place: the ref above, React
  // state, and the caller's `onChange` when one was given. Stable for the
  // hook's life, so every mutator below can depend on it without churning.
  const commit = React.useCallback((next: readonly BlobLinkView[]): void => {
    live.current = next;
    setAttachments(next);
    latest.current.onChange?.(next);
  }, []);

  const attachFiles = React.useCallback(
    async (files: Iterable<File>): Promise<void> => {
      const { owner: current, refRoot: root, onRefInsert: insert, onError: fail } = latest.current;
      for (const file of files) {
        // "" when the drag did not come from the filesystem — a pasted
        // screenshot, or a drag out of another app's canvas.
        const sourcePath = window.api.attachments.pathForFile(file);
        const request: BlobAttachInput = {
          fileName: file.name,
          owner: current,
          ...(file.type === "" ? {} : { mime: file.type }),
          ...(root === undefined ? {} : { refRoot: root }),
          ...(sourcePath === ""
            ? { bytes: new Uint8Array(await file.arrayBuffer()) }
            : { sourcePath }),
        };
        const result = await window.api.attachments.attach(request);
        if (!result.ok) {
          fail?.(result.error);
          continue;
        }
        if (result.relPath !== null) insert?.(result.relPath);
        // Both can be set: a repository image is named live so the agent edits
        // the real file, AND snapshotted so the model can see it.
        if (result.blob !== null) {
          const blob = result.blob;
          if (!live.current.some((entry) => entry.blobHash === blob.blobHash)) {
            commit([...live.current, blob]);
          }
        }
      }
    },
    [commit],
  );

  const remove = React.useCallback(
    async (attachment: BlobLinkView): Promise<void> => {
      // Dropped from the strip first, whatever the database says. The link may
      // not exist yet (an unowned composer draft), and either way the person has
      // already decided this file is not part of the message.
      commit(live.current.filter((entry) => entry !== attachment));
      if (attachment.linkId === null) return;
      const result = await window.api.attachments.remove({ linkId: attachment.linkId });
      if (!result.ok) latest.current.onError?.(result.error);
    },
    [commit],
  );

  const clear = React.useCallback(() => commit([]), [commit]);
  const reset = React.useCallback((next: readonly BlobLinkView[]) => commit(next), [commit]);

  return { attachments, attachFiles, remove, clear, reset };
}
