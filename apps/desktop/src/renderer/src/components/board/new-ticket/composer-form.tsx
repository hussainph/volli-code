import * as React from "react";
import { errorMessage, type Project, type TicketPriority, type TicketStatus } from "@volli/shared";
import { toast } from "sonner";

import { ComposerBreadcrumb } from "@renderer/components/board/new-ticket/composer-breadcrumb";
import { ComposerChips } from "@renderer/components/board/new-ticket/composer-chips";
import { ComposerFooter } from "@renderer/components/board/new-ticket/composer-footer";
import {
  type ComposerFields,
  runKickoff,
  runPlainCreate,
  type SubmitDeps,
} from "@renderer/components/board/new-ticket/submit";
import {
  MarkdownLiveEditor,
  type MarkdownFileRefs,
  type MarkdownLiveEditorHandle,
} from "@renderer/components/editor/markdown-live-editor";
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
 * Mounted only while the dialog is open (Radix unmounts the content on close),
 * so every open starts blank — except `target`, which seeds from the currently
 * selected project and can be retargeted via the breadcrumb chip.
 */
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

  const [target, setTarget] = React.useState<Project>(initialProject);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [status, setStatus] = React.useState<TicketStatus>("backlog");
  const [priority, setPriority] = React.useState<TicketPriority>("medium");
  const [labels, setLabels] = React.useState<string[]>([]);
  const [usesWorktree, setUsesWorktree] = React.useState(true);
  const [createMore, setCreateMore] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const titleRef = React.useRef<HTMLInputElement>(null);
  const editorRef = React.useRef<MarkdownLiveEditorHandle>(null);

  // The `@file` index + create/open wiring for the description editor, keyed to
  // the (retargetable) target project — mirrors ticket-detail's fileRefs, minus
  // an open-file surface (no ticket exists yet, so opening is deferred).
  const fileIndex = useFileIndex(target.id);
  const fileRefs = React.useMemo<MarkdownFileRefs>(
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
    }),
    [target, status, priority, title, body, labels, usesWorktree],
  );

  const deps = React.useMemo<SubmitDeps>(
    () => ({
      addTicket: (projectId, ticketStatus, ticketTitle, options) =>
        useBoardStore.getState().addTicket(projectId, ticketStatus, ticketTitle, options),
      startSession: (projectId, ticketId, kickoff) =>
        createTerminalSession(ticketScope(projectId, ticketId), kickoff),
      openTicket: (projectId, ticketId) =>
        useWorkspaceStore.getState().openTicket(projectId, ticketId),
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
    // Foreground kickoff already navigated into the detail view; either way the
    // composer is done — close it (Create-more resets in place instead).
    if (createMore) resetForm();
    else onClose();
  }, [title, submitting, currentFields, deps, createMore, lastHarnessId, resetForm, onClose]);

  // ⌘+Enter → Create, ⌘+Shift+Enter → Create & start. Captured on the composer
  // root so the shortcut fires before CodeMirror or the title input can act on
  // the Enter — plain Enter is left alone (title moves focus to the body).
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
      <div className="border-b border-border px-4 py-2.5">
        <ComposerBreadcrumb
          projects={projects}
          target={target}
          onRetarget={setTarget}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onClose={onClose}
        />
      </div>

      <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
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
        <MarkdownLiveEditor
          ref={editorRef}
          value={body}
          onChange={setBody}
          placeholder="Add description…"
          ariaLabel="Ticket description"
          fileRefs={fileRefs}
          className={cn(
            "overflow-y-auto text-sm [&_.cm-content]:px-0 [&_.cm-editor]:bg-transparent [&_.cm-editor]:outline-none [&_.cm-focused]:outline-none",
            expanded ? "max-h-[50vh] min-h-[280px]" : "min-h-[120px]",
          )}
        />
      </div>

      <div className="px-4 pb-3">
        <ComposerChips
          projectId={target.id}
          status={status}
          onStatusChange={setStatus}
          priority={priority}
          onPriorityChange={setPriority}
          labels={labels}
          onLabelsChange={setLabels}
          usesWorktree={usesWorktree}
          onUsesWorktreeChange={setUsesWorktree}
        />
      </div>

      <div className="border-t border-border px-4 py-3">
        <ComposerFooter
          fileIndex={fileIndex}
          onInsertRef={(relPath) => editorRef.current?.insertAtCursor(`@${relPath}`)}
          createMore={createMore}
          onCreateMoreChange={setCreateMore}
          harnessId={lastHarnessId}
          onHarnessChange={(harnessId) => useUiStore.getState().setLastHarnessId(harnessId)}
          onCreate={() => void handleCreate()}
          onKickoff={() => void handleKickoff()}
          disabled={!canSubmit}
        />
      </div>
    </div>
  );
}
