/**
 * The navigator's create / rename / duplicate / delete controller (VC-191).
 *
 * One hook for both scopes, because there is only one set of rules: Home's
 * Project Files navigator and the Ticket workspace's Files navigator differ by
 * the `{ projectId, ticketId }` pair they pass, which is precisely the seam
 * main resolves the checkout from. Anything else shared between them (which row
 * is being renamed, what a commit means, which failures get said out loud)
 * would otherwise be written twice and drift once.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. The hook owns the inline-edit state and
 * the IPC calls; the HOST owns the consequences, because they are facts about a
 * tab strip this module cannot see: re-listing the folder, opening a created
 * file as a pinned tab, and following a rename with the open tab. See
 * {@link FileNavigatorHost}.
 *
 * THE ONE REFUSAL THIS SURFACE MAKES ITSELF. A rename of a file whose document
 * holds unsaved changes never reaches main (plan §4.5): document identity keys
 * on relPath, so the buffer would be left pointing at a path that no longer
 * exists. Main cannot make that call — only the renderer knows what is dirty —
 * so it is made here, and it is said in words that name the way out.
 *
 * DUPLICATE DOES NOT OPEN what it makes, and that is not an omission: "open the
 * new file" belongs to New File…, where an empty file is useless until you type
 * in it. A duplicate is a copy of something you already have, usually made to
 * keep it safe before editing the original; taking the editor away from that
 * original would be the opposite of the gesture.
 *
 * ONE ACCEPTED LIMIT, recorded rather than built (plan §4.5): a rename can leave
 * a Ticket Body pointing at a path that no longer exists. That is a Dangling
 * Reference — a concept the product already has and already renders honestly
 * (CONTEXT.md) — so v1 lets it dangle instead of rewriting other people's prose
 * behind their back. Reference rewriting is a separate decision with its own
 * failure modes (a body an agent is mid-edit on, a ref inside a code fence),
 * and it is not this ticket's.
 */
import * as React from "react";
import { errorMessage } from "@volli/shared";

import { fileDocumentIdentity } from "@renderer/editor/document-identity";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { toastError } from "@renderer/lib/toast";
import {
  navigatorCreatePath,
  navigatorRenamePath,
  unsavedRenameRefusal,
  NO_NAVIGATOR_EDIT,
  type NavigatorEdit,
  type NavigatorEntryKind,
} from "@renderer/components/files/navigator-mutations";

/** The checkout a navigator acts in — the same pair `volli:file-read` resolves through. */
export interface FileNavigatorScope {
  projectId: string;
  /** Absent on Home, which is the project's main checkout by definition. */
  ticketId?: string;
}

/** What the surrounding workspace has to do once a mutation lands. */
export interface FileNavigatorHost {
  /** Re-list the folder on screen. The ticket navigator has no dir-watch, and Home's is debounced. */
  refresh(): void;
  /** Open a just-created file as a PINNED, focused tab (plan §4.5). */
  openCreated(relPath: string): void;
  /** Move any open tab from `from` to `to`, carrying what the host remembers about it. */
  renameTab(from: string, to: string): void;
}

/** Everything a navigator row and its rail header need to offer these actions. */
export interface FileNavigatorControls {
  /** The inline field currently open, if any. */
  edit: NavigatorEdit;
  startDraft(entry: NavigatorEntryKind): void;
  startRename(relPath: string): void;
  cancelEdit(): void;
  commitDraft(name: string): void;
  commitRename(relPath: string, name: string): void;
  duplicate(relPath: string): void;
  remove(relPath: string, entry: NavigatorEntryKind): void;
}

/**
 * Whether an open document for `relPath` holds unsaved changes.
 *
 * Both identities are peeked when the surface belongs to a ticket, because
 * which one a file tab actually took is main's answer, not the request's: a
 * ticket without a materialized worktree — and every `.volli/**` path — reads
 * from Main and therefore holds the MAIN document (`fileDocumentIdentity`).
 * Asking only the ticket one would let exactly those files be renamed out from
 * under a dirty buffer.
 *
 * A Monaco runtime that will not load answers `false`, which is the truthful
 * reading rather than a swallowed error: with no runtime there is no editor,
 * and with no editor there is nothing unsaved.
 */
async function hasUnsavedDocument(scope: FileNavigatorScope, relPath: string): Promise<boolean> {
  try {
    const runtime = await loadMonacoRuntime();
    const identities = [
      fileDocumentIdentity({ projectId: scope.projectId, relPath, source: "main" }),
      ...(scope.ticketId === undefined
        ? []
        : [
            fileDocumentIdentity({
              projectId: scope.projectId,
              ticketId: scope.ticketId,
              relPath,
              source: "worktree",
            }),
          ]),
    ];
    return identities.some(
      (identity) => runtime.registry.peek(identity)?.snapshot().dirty === true,
    );
  } catch {
    return false;
  }
}

export function useFileNavigatorMutations(input: {
  scope: FileNavigatorScope;
  /** The folder the navigator is standing in — `""` at the checkout root. */
  cwd: string;
  host: FileNavigatorHost;
}): FileNavigatorControls {
  const { cwd } = input;
  const { projectId, ticketId } = input.scope;
  const [edit, setEdit] = React.useState<NavigatorEdit>(NO_NAVIGATOR_EDIT);

  // The host is rebuilt by its owner on every render; holding it in a ref keeps
  // the callbacks below stable without asking every caller to memoize three
  // functions. Same reason the scope pair is read as two primitives.
  const hostRef = React.useRef(input.host);
  hostRef.current = input.host;

  // A folder change abandons an inline field: it named a row (or a folder) that
  // is no longer on screen, and committing it after the move would create the
  // file somewhere the person is not looking.
  React.useEffect(() => setEdit(NO_NAVIGATOR_EDIT), [cwd, projectId, ticketId]);

  const scope = React.useMemo(
    () => (ticketId === undefined ? { projectId } : { projectId, ticketId }),
    [projectId, ticketId],
  );

  const cancelEdit = React.useCallback(() => setEdit(NO_NAVIGATOR_EDIT), []);
  const startDraft = React.useCallback(
    (entry: NavigatorEntryKind) => setEdit({ kind: "draft", entry }),
    [],
  );
  const startRename = React.useCallback(
    (relPath: string) => setEdit({ kind: "rename", relPath }),
    [],
  );

  const commitDraft = React.useCallback(
    (name: string) => {
      const entry = edit.kind === "draft" ? edit.entry : "file";
      setEdit(NO_NAVIGATOR_EDIT);
      const target = navigatorCreatePath(cwd, name);
      if (!target.ok) {
        toastError(target.error);
        return;
      }
      void (async () => {
        try {
          const request = { ...scope, relPath: target.relPath };
          const result =
            entry === "directory"
              ? await window.api.files.createDirectory(request)
              : await window.api.files.create(request);
          if (!result.ok) {
            toastError(`Couldn't create ${name}: ${result.error}`);
            return;
          }
          hostRef.current.refresh();
          // A new folder is a place, not a document: there is nothing to open,
          // and the navigator's own listing is where it appears.
          if (entry === "file") hostRef.current.openCreated(result.relPath);
        } catch (error) {
          toastError(`Couldn't create ${name}: ${errorMessage(error)}`);
        }
      })();
    },
    [cwd, edit, scope],
  );

  const commitRename = React.useCallback(
    (relPath: string, name: string) => {
      setEdit(NO_NAVIGATOR_EDIT);
      const target = navigatorRenamePath(relPath, name);
      if (!target.ok) {
        toastError(target.error);
        return;
      }
      void (async () => {
        try {
          if (await hasUnsavedDocument(scope, relPath)) {
            toastError(unsavedRenameRefusal(relPath));
            return;
          }
          const result = await window.api.files.rename({
            ...scope,
            relPath,
            toRelPath: target.relPath,
          });
          if (!result.ok) {
            toastError(`Couldn't rename ${name}: ${result.error}`);
            return;
          }
          hostRef.current.renameTab(relPath, result.relPath);
          hostRef.current.refresh();
        } catch (error) {
          toastError(`Couldn't rename ${name}: ${errorMessage(error)}`);
        }
      })();
    },
    [scope],
  );

  const duplicate = React.useCallback(
    (relPath: string) => {
      void (async () => {
        try {
          const result = await window.api.files.duplicate({ ...scope, relPath });
          if (!result.ok) {
            toastError(`Couldn't duplicate ${relPath}: ${result.error}`);
            return;
          }
          hostRef.current.refresh();
        } catch (error) {
          toastError(`Couldn't duplicate ${relPath}: ${errorMessage(error)}`);
        }
      })();
    },
    [scope],
  );

  const remove = React.useCallback(
    (relPath: string, entry: NavigatorEntryKind) => {
      void (async () => {
        const noun = entry === "directory" ? "folder" : "file";
        try {
          // No confirmation, because the act is not destructive: main moves it
          // to the Trash, and a dialog in front of a reversible move is the
          // kind of ceremony that trains people to click through dialogs.
          const result = await window.api.files.delete({ ...scope, relPath });
          if (!result.ok) {
            toastError(`Couldn't move the ${noun} to the Trash: ${result.error}`);
            return;
          }
          hostRef.current.refresh();
        } catch (error) {
          toastError(`Couldn't move the ${noun} to the Trash: ${errorMessage(error)}`);
        }
      })();
    },
    [scope],
  );

  return React.useMemo(
    () => ({
      edit,
      startDraft,
      startRename,
      cancelEdit,
      commitDraft,
      commitRename,
      duplicate,
      remove,
    }),
    [cancelEdit, commitDraft, commitRename, duplicate, edit, remove, startDraft, startRename],
  );
}
