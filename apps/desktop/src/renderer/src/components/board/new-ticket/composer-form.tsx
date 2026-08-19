import * as React from "react";
import { errorMessage, type Project, type TicketPriority, type TicketStatus } from "@volli/shared";
import { toast } from "sonner";

import { AttachmentStrip } from "@renderer/components/attachments/attachment-strip";
import { fileAttachHandlers } from "@renderer/components/attachments/file-drop";
import { useAttachments } from "@renderer/hooks/use-attachments";
import { resolveBaseBranch } from "@renderer/components/board/new-ticket/branch-picker";
import { useBranchListing } from "@renderer/components/board/new-ticket/composer-branch";
import { ComposerBreadcrumb } from "@renderer/components/board/new-ticket/composer-breadcrumb";
import { ComposerChips } from "@renderer/components/board/new-ticket/composer-chips";
import { ComposerFooter } from "@renderer/components/board/new-ticket/composer-footer";
import { useComposerRun } from "@renderer/components/board/new-ticket/composer-run";
import { clearDraft, loadDraft, saveDraft } from "@renderer/components/board/new-ticket/draft";
import {
  type ComposerFields,
  runKickoff,
  runPlainCreate,
  type SubmitDeps,
} from "@renderer/components/board/new-ticket/submit";
import {
  type DocumentFileRefs,
  MonacoDocumentEditor,
  type MonacoDocumentEditorHandle,
} from "@renderer/components/editor/monaco-document-editor";
import { startTicketChat } from "@renderer/components/sessions/session-create";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * The New-ticket composer's stateful body: field state, the description editor
 * (with `@file` refs + the paperclip insert), the metadata chips, and the
 * create/kickoff footer. All the branching lives in the tested `submit.ts`
 * orchestration; this component only holds state and wires effectful callbacks.
 *
 * Mounted only while the dialog is open (Radix unmounts the content on close).
 * Field state seeds from the DRAFT CACHE (draft.ts) when one exists — an
 * accidental Escape/overlay-click/quit mid-compose is non-destructive, Linear
 * style — and from blank defaults otherwise (`target` then seeds from the
 * currently selected project). Every field change re-saves the draft; a
 * successful create clears it.
 *
 * The one piece of state that is NOT a field and NOT in the draft is what a
 * kickoff will RUN on: it is seeded per open from Model Access's Ticket default
 * rather than remembered here — see `composer-run.tsx`.
 */
/**
 * The reserved ticket id the not-yet-created draft body's document identity
 * uses. Real ids are UUIDs, so nothing can collide with it.
 */
const COMPOSER_DRAFT_TICKET_ID = "__composer_draft__";

export function ComposerForm({
  initialProject,
  expanded,
  onToggleExpand,
  onClose,
}: {
  initialProject: Project;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
}) {
  const projects = useProjectsStore((state) => state.projects);

  // Restore the draft once per mount (lazy initializer — never re-read on
  // renders). The draft's target project is revalidated against the live
  // project list; a since-removed project falls back to the selected one.
  const [restored] = React.useState(() => loadDraft());
  const [target, setTarget] = React.useState<Project>(
    () => projects.find((candidate) => candidate.id === restored?.projectId) ?? initialProject,
  );
  const [title, setTitle] = React.useState(restored?.title ?? "");
  const [body, setBody] = React.useState(restored?.body ?? "");
  const [status, setStatus] = React.useState<TicketStatus>(restored?.status ?? "backlog");
  const [priority, setPriority] = React.useState<TicketPriority>(restored?.priority ?? "medium");
  const [labels, setLabels] = React.useState<string[]>(restored?.labels ?? []);
  const [usesWorktree, setUsesWorktree] = React.useState(restored?.usesWorktree ?? true);
  const [createMore, setCreateMore] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  // The chip's own choice, or null for "whatever the project's default is".
  // Never read directly — `baseBranch` below is the resolved answer.
  //
  // Scoped to the project it was chosen FOR, both here and on retarget below. A
  // ref name means nothing in another repo: a draft restored onto the fallback
  // project (its own was removed) would otherwise arrive holding the removed
  // project's base, and two repos that each have a `develop` would sail through
  // every check `resolveBaseBranch` can make while branching the work off an
  // unrelated commit.
  const [chosenBase, setChosenBase] = React.useState<string | null>(() =>
    restored?.projectId === target.id ? (restored.baseBranch ?? null) : null,
  );

  // The target project's refs, re-read per open and per retarget.
  // `resolveBaseBranch` holds the chip's choice while the read is in flight and
  // then drops one the project turns out not to have — the same revalidation
  // the restored `target` gets above, for the same reason (a draft can outlive
  // the branch it named).
  //
  // The target's own configured base goes in as the default, and it follows a
  // retarget: the base a ticket starts from is the target project's business, so
  // reading it off `target` rather than off the listing keeps the two chips from
  // ever describing different projects.
  const branchState = useBranchListing(target.id);
  const baseBranch = resolveBaseBranch(chosenBase, branchState, target.baseBranch ?? null);

  // Retarget: the new project's refs are a different repo's, so the base picked
  // in the old one is dropped rather than carried across and re-checked. It is
  // the project's configured base that stands in until the new listing lands.
  const handleRetarget = React.useCallback((project: Project) => {
    setTarget(project);
    setChosenBase(null);
  }, []);

  // Implicit save: every field change re-caches the draft (the storage layer
  // debounces the SQLite write), so closing the dialog ANY way keeps the work.
  // Content-empty state clears the slot instead (erasing = discarding).
  React.useEffect(() => {
    saveDraft({
      projectId: target.id,
      status,
      priority,
      title,
      body,
      labels,
      usesWorktree,
      baseBranch: chosenBase,
    });
  }, [target.id, status, priority, title, body, labels, usesWorktree, chosenBase]);

  const titleRef = React.useRef<HTMLInputElement>(null);
  const editorRef = React.useRef<MonacoDocumentEditorHandle>(null);

  // The `@file` index + create/open wiring for the description editor, keyed to
  // the (retargetable) target project — mirrors ticket-detail's fileRefs, minus
  // an open-file surface (no ticket exists yet, so opening is deferred).
  const fileIndex = useFileIndex(target.id);
  const fileRefs = React.useMemo<DocumentFileRefs>(
    () => ({
      getIndex: fileIndex.getIndex,
      refreshIndex: fileIndex.refresh,
      indexVersion: fileIndex.version,
      onOpenFile: () => toast.info("Files open after the ticket is created"),
      createArtifact: async (name) => {
        try {
          const result = await window.api.files.createArtifact({ projectId: target.id, name });
          if (result.ok) fileIndex.forceRefresh();
          return result;
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
    }),
    [fileIndex, target.id],
  );

  const canSubmit = title.trim() !== "" && !submitting;
  // What Create & start will run: the Ticket purpose's configured default,
  // read per open, overridable for this ticket alone (`composer-run.tsx`).
  // Deliberately NOT part of the draft above — see that module's header.
  const run = useComposerRun();

  const currentFields = React.useCallback(
    (): ComposerFields => ({
      projectId: target.id,
      ticketPrefix: target.ticketPrefix,
      status,
      priority,
      title,
      body,
      labels,
      usesWorktree,
      baseBranch,
    }),
    [target, status, priority, title, body, labels, usesWorktree, baseBranch],
  );

  /**
   * Files attached before the Ticket exists (VC-50).
   *
   * They are imported the moment they are chosen — so an oversized image is
   * refused while the person still has it in hand, rather than after they have
   * written the whole Ticket — and linked to the Ticket once it has an id. A
   * draft abandoned instead leaves unreferenced Blobs, which boot-time
   * collection reclaims.
   *
   * `refRoot` is the target project's checkout: a file already in the
   * repository becomes an `@` reference in the body, exactly as the footer's
   * file picker would have written it.
   */
  const {
    attachments,
    attachFiles,
    remove: removeAttachment,
    clear: clearAttachments,
  } = useAttachments({
    owner: { unowned: true },
    refRoot: target.path,
    onRefInsert: (relPath) => editorRef.current?.insertAtCursor(`@${relPath}`),
    onError: (message) => toast.error(message),
  });
  const attachmentsRef = React.useRef(attachments);
  attachmentsRef.current = attachments;

  const deps = React.useMemo<SubmitDeps>(
    () => ({
      addTicket: (projectId, ticketStatus, ticketTitle, options) =>
        useBoardStore.getState().addTicket(projectId, ticketStatus, ticketTitle, options),
      // The same ticket-chat door ⌘T and the tab strip's "+" go through, told
      // the three things only a kickoff knows: the model this composer picked,
      // the opening turn, and a title (the turn is a stock instruction, so
      // letting the first message name the Session would name it badly).
      startChat: (projectId, ticketId, chat) => startTicketChat(projectId, ticketId, chat),
      openTicketWorkspace: (projectId, ticketId) =>
        useWorkspaceStore.getState().openTicketWorkspace(projectId, ticketId),
      toastSuccess: (message) => toast.success(message),
      linkAttachments: async (ticketId) => {
        const pending = attachmentsRef.current;
        if (pending.length === 0) return;
        const result = await window.api.attachments.linkDrafts({
          ticketId,
          blobs: pending.map((entry) => ({ blobHash: entry.blobHash, label: entry.label })),
        });
        if (!result.ok) toast.error(result.error);
      },
    }),
    [],
  );

  const resetForm = React.useCallback(() => {
    setTitle("");
    setBody("");
    setLabels([]);
    // The links now belong to the Ticket that was just created; the strip is
    // forgotten rather than detached.
    clearAttachments();
    // Return focus to the title for the next rapid entry (Create-more).
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [clearAttachments]);

  const handleCreate = React.useCallback(async () => {
    if (title.trim() === "" || submitting) return;
    setSubmitting(true);
    const result = await runPlainCreate(currentFields(), deps);
    setSubmitting(false);
    if (!result.created) return;
    clearDraft(); // the create consumed the draft — next open starts blank
    if (createMore) resetForm();
    else onClose();
  }, [title, submitting, currentFields, deps, createMore, resetForm, onClose]);

  const handleKickoff = React.useCallback(async () => {
    if (title.trim() === "" || submitting) return;
    setSubmitting(true);
    const result = await runKickoff(currentFields(), deps, {
      createMore,
      ...(run.selection === null ? {} : { model: run.selection }),
    });
    setSubmitting(false);
    if (!result.created) return;
    clearDraft(); // the kickoff consumed the draft — next open starts blank
    // Foreground kickoff already navigated into the ticket workspace; either way
    // the composer is done — close it (Create-more resets in place instead).
    if (createMore) resetForm();
    else onClose();
  }, [title, submitting, currentFields, deps, createMore, run.selection, resetForm, onClose]);

  // ⌘+Enter → Create, ⌘+Shift+Enter → Create & start. Captured on the composer
  // root so the shortcut fires before Monaco or the title input can act on the
  // Enter — plain Enter is left alone (title moves focus to the body). React
  // dispatches capture-phase handlers from a native listener on the app root,
  // which is an ANCESTOR of Monaco's DOM, so `stopPropagation` here stops the
  // event before it ever reaches Monaco's own keydown listener. That ordering is
  // the whole reason this handler is `onKeyDownCapture` and not `onKeyDown`.
  const handleKeyDownCapture = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) void handleKickoff();
      else void handleCreate();
    },
    [handleCreate, handleKickoff],
  );

  return (
    // `min-w-0`, and it is load-bearing rather than defensive. This is a GRID
    // item (DialogContent), and a grid item's automatic minimum size is its
    // content's — so the column widens to whatever the widest child insists on
    // instead of to the dialog's own `max-w-*`. Monaco is a child that insists:
    // it lays itself out to explicit pixel widths and only re-measures when its
    // host element resizes. That made Collapse a deadlock, which is exactly how
    // it presented: expanding grew the host and Monaco followed, but collapsing
    // could not shrink the host, because Monaco's own 768px-wide DOM was the
    // thing holding it open — so the composer stayed wide, overflowed its
    // `overflow-hidden` panel to the right, and only recovered when the next
    // open remounted the editor. `min-w-0` lets the column shrink below its
    // content, which lets the host shrink, which is the resize Monaco's
    // `automaticLayout` observer was waiting for.
    <div
      onKeyDownCapture={handleKeyDownCapture}
      // The whole composer is the drop target, not just the description box: a
      // file meant for this ticket is aimed at the dialog, and the title input,
      // the chips and the footer are all places it plausibly lands. Capture,
      // because Monaco treats a dropped file as text to insert and would
      // otherwise write the path into the body instead of attaching it.
      {...fileAttachHandlers((picked) => void attachFiles(picked))}
      className="flex min-w-0 flex-col"
    >
      <div className="border-b border-border px-4 py-2">
        <ComposerBreadcrumb
          projects={projects}
          target={target}
          onRetarget={handleRetarget}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onClose={onClose}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2 px-4 pt-4 pb-4">
        <input
          ref={titleRef}
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            // Enter in the title never submits — it moves focus to the body
            // (⌘/Ctrl+Enter is handled by the capture handler above).
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              editorRef.current?.focus();
            }
          }}
          placeholder="Ticket title"
          className="w-full border-none bg-transparent text-heading font-medium text-foreground outline-none placeholder:text-muted-foreground"
        />
        <MonacoDocumentEditor
          ref={editorRef}
          // No ticket exists yet, so the draft body borrows a ticket-body
          // identity under a reserved id. Ticket ids are UUIDs, so this can
          // never collide with a real body's model.
          identity={{
            kind: "ticket-body",
            projectId: target.id,
            ticketId: COMPOSER_DRAFT_TICKET_ID,
          }}
          viewId="composer:body"
          value={body}
          onChange={setBody}
          placeholder="Add description…"
          ariaLabel="Ticket description"
          fileRefs={fileRefs}
          // Bounded growth: the body grows with what you type and then scrolls
          // inside itself rather than pushing the footer off the dialog.
          className={cn(expanded ? "max-h-[50vh] min-h-[280px]" : "max-h-[40vh] min-h-[140px]")}
        />
      </div>

      <div className="px-4 pb-4">
        <ComposerChips
          projectId={target.id}
          status={status}
          onStatusChange={setStatus}
          priority={priority}
          onPriorityChange={setPriority}
          labels={labels}
          onLabelsChange={setLabels}
          branch={{
            state: branchState,
            baseBranch,
            onBaseBranchChange: setChosenBase,
            usesWorktree,
            onUsesWorktreeChange: setUsesWorktree,
          }}
        />
      </div>

      <AttachmentStrip
        attachments={attachments}
        onRemove={(attachment) => void removeAttachment(attachment)}
        className="border-t border-border px-4 pt-2"
      />

      <div className="border-t border-border px-4 py-2">
        <ComposerFooter
          onAttachFiles={(picked) => void attachFiles(picked)}
          fileIndex={fileIndex}
          onInsertRef={(relPath) => editorRef.current?.insertAtCursor(`@${relPath}`)}
          run={run}
          createMore={createMore}
          onCreateMoreChange={setCreateMore}
          onCreate={() => void handleCreate()}
          onKickoff={() => void handleKickoff()}
          disabled={!canSubmit}
        />
      </div>
    </div>
  );
}
