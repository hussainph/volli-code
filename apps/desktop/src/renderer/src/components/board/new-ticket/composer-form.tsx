import * as React from "react";
import { errorMessage, type Project, type TicketPriority, type TicketStatus } from "@volli/shared";
import { toast } from "sonner";

import { resolveBaseBranch } from "@renderer/components/board/new-ticket/branch-picker";
import { useBranchListing } from "@renderer/components/board/new-ticket/composer-branch";
import { ComposerBreadcrumb } from "@renderer/components/board/new-ticket/composer-breadcrumb";
import { ComposerChips } from "@renderer/components/board/new-ticket/composer-chips";
import { ComposerFooter } from "@renderer/components/board/new-ticket/composer-footer";
import { useActiveHarnessLabel } from "@renderer/components/board/new-ticket/composer-harness";
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
import { createTerminalSession } from "@renderer/components/sessions/session-create";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { ticketScope } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
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
  const lastHarnessId = useUiStore((state) => state.lastHarnessId);

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
  // The harness lives in the chip row now; the kickoff button still names it,
  // which is what keeps the two legible as a pair across the footer boundary.
  const harnessLabel = useActiveHarnessLabel(lastHarnessId);

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

  const deps = React.useMemo<SubmitDeps>(
    () => ({
      addTicket: (projectId, ticketStatus, ticketTitle, options) =>
        useBoardStore.getState().addTicket(projectId, ticketStatus, ticketTitle, options),
      startSession: (projectId, ticketId, kickoff) =>
        createTerminalSession(ticketScope(projectId, ticketId), kickoff),
      openTicketWorkspace: (projectId, ticketId) =>
        useWorkspaceStore.getState().openTicketWorkspace(projectId, ticketId),
      // openTicketSession (not the narrower setTicketActiveTab) so the freshly
      // booted session also becomes this ticket's active session in the
      // sessions store, same as every other surface that focuses a session tab.
      focusSession: (projectId, ticketId, sessionId) =>
        useWorkspaceStore.getState().openTicketSession(projectId, ticketId, sessionId),
      persistHarness: (harnessId) => useUiStore.getState().setLastHarnessId(harnessId),
      toastSuccess: (message) => toast.success(message),
    }),
    [],
  );

  const resetForm = React.useCallback(() => {
    setTitle("");
    setBody("");
    setLabels([]);
    // Return focus to the title for the next rapid entry (Create-more).
    requestAnimationFrame(() => titleRef.current?.focus());
  }, []);

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
      harnessId: lastHarnessId,
    });
    setSubmitting(false);
    if (!result.created) return;
    clearDraft(); // the kickoff consumed the draft — next open starts blank
    // Foreground kickoff already navigated into the detail view; either way the
    // composer is done — close it (Create-more resets in place instead).
    if (createMore) resetForm();
    else onClose();
  }, [title, submitting, currentFields, deps, createMore, lastHarnessId, resetForm, onClose]);

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
    <div onKeyDownCapture={handleKeyDownCapture} className="flex flex-col">
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

      <div className="flex flex-col gap-2 px-4 pt-4 pb-4">
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
          harnessId={lastHarnessId}
          onHarnessChange={(harnessId) => useUiStore.getState().setLastHarnessId(harnessId)}
          branch={{
            state: branchState,
            baseBranch,
            onBaseBranchChange: setChosenBase,
            usesWorktree,
            onUsesWorktreeChange: setUsesWorktree,
          }}
        />
      </div>

      <div className="border-t border-border px-4 py-2">
        <ComposerFooter
          fileIndex={fileIndex}
          onInsertRef={(relPath) => editorRef.current?.insertAtCursor(`@${relPath}`)}
          createMore={createMore}
          onCreateMoreChange={setCreateMore}
          harnessLabel={harnessLabel}
          onCreate={() => void handleCreate()}
          onKickoff={() => void handleKickoff()}
          disabled={!canSubmit}
        />
      </div>
    </div>
  );
}
