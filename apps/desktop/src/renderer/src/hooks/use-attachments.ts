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
  /**
   * Detaches everything still in the strip — for a surface going away (VC-50).
   *
   * A chat's strip state is the ONLY pointer to a link no message has carried
   * yet: nothing persists it, so navigating away without this would leave a
   * durable link the person can never see or remove again — spending the
   * Session's image budget and materializing on every boot, forever. Reads a
   * ref the mutators keep in step synchronously, so a message sent in the same
   * tick (which `clear`s the strip) can never have its links torn out from
   * under it by an unmount racing the re-render.
   */
  discardPending: () => Promise<void>;
}

export function useAttachments(options: UseAttachmentsOptions): AttachmentsHandle {
  const { owner, refRoot, onRefInsert, onError } = options;
  const [attachments, setAttachments] = React.useState<readonly BlobLinkView[]>([]);
  // The strip as of the LAST MUTATION, not the last render — every mutator
  // below writes it before (or instead of) setState, which is what lets
  // `discardPending` run from an unmount cleanup and still see the truth.
  const live = React.useRef<readonly BlobLinkView[]>([]);

  // Read through a ref so `attachFiles` keeps a stable identity across renders
  // — it is handed to drag/paste handlers that would otherwise re-bind on every
  // keystroke in the composer beside them.
  const latest = React.useRef({ owner, refRoot, onRefInsert, onError });
  latest.current = { owner, refRoot, onRefInsert, onError };

  const attachFiles = React.useCallback(async (files: Iterable<File>): Promise<void> => {
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
          live.current = [...live.current, blob];
        }
        setAttachments(live.current);
      }
    }
  }, []);

  const remove = React.useCallback(async (attachment: BlobLinkView): Promise<void> => {
    // Dropped from the strip first, whatever the database says. The link may
    // not exist yet (an unowned composer draft), and either way the person has
    // already decided this file is not part of the message.
    live.current = live.current.filter((entry) => entry !== attachment);
    setAttachments(live.current);
    if (attachment.linkId === null) return;
    const result = await window.api.attachments.remove({ linkId: attachment.linkId });
    if (!result.ok) latest.current.onError?.(result.error);
  }, []);

  const clear = React.useCallback(() => {
    live.current = [];
    setAttachments([]);
  }, []);
  const reset = React.useCallback((next: readonly BlobLinkView[]) => {
    live.current = next;
    setAttachments(next);
  }, []);

  const discardPending = React.useCallback(async (): Promise<void> => {
    const pending = live.current;
    live.current = [];
    setAttachments([]);
    for (const entry of pending) {
      if (entry.linkId === null) continue;
      const result = await window.api.attachments.remove({ linkId: entry.linkId });
      // Surfaced even though the surface is going away — the toast outlives
      // the pane, and a failed detach is a mutation someone should hear about.
      if (!result.ok) latest.current.onError?.(result.error);
    }
  }, []);

  return { attachments, attachFiles, remove, clear, reset, discardPending };
}
