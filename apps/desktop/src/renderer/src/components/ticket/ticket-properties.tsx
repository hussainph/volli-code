import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GitCommitIcon } from "@phosphor-icons/react/dist/csr/GitCommit";
import { GitPullRequestIcon } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { toast } from "sonner";
import {
  errorMessage,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type DiffStat,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { createTerminalSession } from "@renderer/components/sessions/session-create";
import { TicketLabelEditor } from "@renderer/components/ticket/ticket-label-editor";
import {
  formatMergeBaseSummary,
  resolveDoneFlow,
  type DoneFlowStage,
  type MenuAction,
  type PrimaryActionKind,
  type WorktreeStatusSnapshot,
} from "@renderer/components/ticket/worktree-done-flow-model";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";
import { ticketScope } from "@renderer/stores/sessions";
import { phaseFor, useWorktreeStore } from "@renderer/stores/worktree";

/** "Jul 14, 2026, 3:04 PM" — a compact created/updated stamp. */
function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PropertyLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-label font-medium text-muted-foreground uppercase">{children}</span>;
}

/** Status picker: same chip/dropdown idiom as the new-ticket dialog's `StatusPicker`, wired to the
 * board store's `moveTicket` instead of local field state. Picking a status appends the ticket to
 * the end of that column — the same "Move to" semantics as the card's context menu. */
function StatusField({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-fit gap-1.5 border border-border px-2.5 text-xs text-muted-foreground"
        >
          {TICKET_STATUS_LABELS[ticket.status]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={ticket.status}
          onValueChange={(value) =>
            void useBoardStore
              .getState()
              .moveTicket(projectId, ticket.id, value as TicketStatus, Number.MAX_SAFE_INTEGER)
          }
        >
          {TICKET_STATUSES.map((status) => (
            <DropdownMenuRadioItem key={status} value={status}>
              {TICKET_STATUS_LABELS[status]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Priority picker: the new-ticket dialog's `PriorityPicker` idiom (same trigger classes, same
 * `PriorityIndicator` bars), wired to the board store's `setTicketPriority`. */
function PriorityField({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-fit gap-1.5 border border-border px-2.5 text-xs text-muted-foreground"
        >
          <PriorityIndicator priority={ticket.priority} />
          {TICKET_PRIORITY_LABELS[ticket.priority]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={ticket.priority}
          onValueChange={(value) =>
            void useBoardStore
              .getState()
              .setTicketPriority(projectId, ticket.id, value as TicketPriority)
          }
        >
          {TICKET_PRIORITIES.map((priority) => (
            <DropdownMenuRadioItem key={priority} value={priority}>
              <PriorityIndicator priority={priority} />
              {TICKET_PRIORITY_LABELS[priority]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A click-to-edit text field for a single worktree-identity string (branch/baseBranch): click to
 * focus an input seeded with the current value; Enter or blur commits via `onCommit` (a no-op if
 * unchanged); Escape reverts without writing. An empty commit passes `null` — clearing the field —
 * rather than `""`, matching the domain's null-until-a-worktree-exists convention. Displays an
 * em-dash when `value` is null and not being edited.
 *
 * Like InlineRename, a `done` guard makes commit/cancel one-shot so Enter (which commits and then
 * blurs) can't double-fire the commit; it resets when a fresh edit starts.
 */
function InlineTextField({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit(next: string | null): void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? "");
  // Guard against blur firing after an Enter/Escape already resolved the edit.
  const done = React.useRef(false);

  function commit() {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === value) return;
    onCommit(next);
  }

  function cancel() {
    if (done.current) return;
    done.current = true;
    setEditing(false);
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
        className="h-7 font-mono text-xs"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        done.current = false;
        setDraft(value ?? "");
        setEditing(true);
      }}
      className="w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs text-foreground hover:bg-accent"
    >
      {value ?? <span className="text-muted-foreground">—</span>}
    </button>
  );
}

/**
 * A committed worktree-identity string shown read-only (branch/baseBranch are settable ONCE — user
 * decision — so once non-empty they can't be re-edited here). Same mono/size treatment as the
 * InlineTextField's resting state, minus the click-to-edit affordance.
 */
function ReadonlyIdentity({ value }: { value: string }) {
  return (
    <span className="block w-full truncate px-2 py-1 font-mono text-xs text-foreground">
      {value}
    </span>
  );
}

/**
 * The base-branch picker: while `ticket.baseBranch` is unset, a `StatusField`/
 * `PriorityField`-style trigger + `DropdownMenuRadioGroup` replaces the free-text
 * field, offering the project's local branches (fetched lazily — only on the
 * picker's first open, then cached for the field's lifetime). The persisted
 * current value stays selectable even if a later fetch no longer lists it,
 * though for an unset field that only matters if the branch list changes
 * between two opens. Selecting a branch commits it exactly like the old
 * free-text field did (same `updateTicket` write-through) — once committed,
 * `TicketProperties` swaps this out for `ReadonlyIdentity` (branch/baseBranch
 * are settable ONCE).
 */
function BaseBranchField({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  const [branches, setBranches] = React.useState<string[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function loadBranches() {
    if (branches !== null || loading) return;
    setLoading(true);
    try {
      const result = await window.api.worktree.branches(projectId);
      if (!result.ok) {
        // Leave `branches` null (not `[]`) so a failed fetch isn't cached as
        // "no branches" forever — the next open retries instead.
        toastError(`Could not load branches: ${result.error}`);
        return;
      }
      setBranches(result.branches);
    } catch (error) {
      toastError(`Could not load branches: ${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }

  const options = branches ?? [];

  return (
    <DropdownMenu onOpenChange={(open) => open && void loadBranches()}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-fit gap-1.5 border border-border px-2.5 text-xs text-muted-foreground"
        >
          Select branch…
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {loading ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
        ) : options.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No branches found</div>
        ) : (
          <DropdownMenuRadioGroup
            value={ticket.baseBranch ?? ""}
            onValueChange={(next) =>
              void useBoardStore.getState().updateTicket({ ticketId: ticket.id, baseBranch: next })
            }
          >
            {options.map((branch) => (
              <DropdownMenuRadioItem key={branch} value={branch}>
                {branch}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Details rail's inline notice for a failed worktree ensure (transient
 * phase, stores/worktree.ts): muted/small, matching the rail's other inline
 * affordances, with a Retry that boots a fresh bare-shell ticket session — the
 * same path `TicketDetail`'s "New session" uses — to re-run `ensure`. No
 * kickoff: retry only needs the setup pipeline to run again, not a fresh agent
 * prompt.
 */
function WorktreeFailedNotice({ projectId, ticketId }: { projectId: string; ticketId: string }) {
  const [retrying, setRetrying] = React.useState(false);

  async function retry() {
    setRetrying(true);
    try {
      await createTerminalSession(ticketScope(projectId, ticketId));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2">
      <span className="text-xs text-destructive">Worktree setup failed.</span>
      <Button variant="outline" size="xs" disabled={retrying} onClick={() => void retry()}>
        Retry
      </Button>
    </div>
  );
}

/** Read-only `worktreePath` display + a reveal-in-Finder affordance (same `api.fs.revealInFinder`
 * call as the project rail's tile — rail/project-tile.tsx). */
function WorktreePathField({ path }: { path: string | null }) {
  async function reveal() {
    if (!path) return;
    try {
      const result = await window.api.fs.revealInFinder(path);
      if (!result.ok) toastError(`Could not reveal in Finder: ${result.error}`);
    } catch (error) {
      toastError(`Could not reveal in Finder: ${errorMessage(error)}`);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <span className="min-w-0 flex-1 truncate px-2 py-1 font-mono text-xs text-foreground">
        {path ?? <span className="text-muted-foreground">—</span>}
      </span>
      {path ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reveal in Finder"
          onClick={() => void reveal()}
        >
          <FolderOpenIcon />
        </Button>
      ) : null}
    </div>
  );
}

/** The Phosphor icon for a primary action, mirroring the verb's menu icon. */
function PrimaryActionIcon({ kind }: { kind: PrimaryActionKind }) {
  if (kind === "commit-pr" || kind === "commit-push-updates") return <GitCommitIcon />;
  if (kind === "view-pr") return <ArrowSquareOutIcon />;
  return <GitPullRequestIcon />;
}

/**
 * One chevron-menu row: the verb's icon (filled, per the project's menu-icon
 * convention) + label, with the disabled reason shown as trailing muted text
 * (disabled items can't emit hover, so a tooltip wouldn't fire — T3's inline
 * reason instead).
 */
function DoneFlowMenuItem({
  action,
  icon,
  onRun,
}: {
  action: MenuAction;
  icon: React.ReactNode;
  onRun(): void;
}) {
  return (
    <DropdownMenuItem disabled={action.disabled} onSelect={onRun} className="justify-between gap-6">
      <span className="flex items-center gap-2">
        {icon}
        {action.label}
      </span>
      {action.disabled && action.reason ? (
        <span className="text-xs text-muted-foreground">{action.reason}</span>
      ) : null}
    </DropdownMenuItem>
  );
}

/** The one success toast for a push-pr result — shared by the standalone push verb and a stacked flow's tail. */
function toastPushResult(isUpdate: boolean, existing: boolean) {
  toast.success(isUpdate ? "Updates pushed" : existing ? "PR already existed" : "Draft PR opened");
}

/**
 * The Details rail's Done-flow block (docs/plans/done-flow.md "UI", decision
 * #45): one merge-base context line plus one adaptive split button — a primary
 * action whose label is the whole next step, and a chevron menu unbundling the
 * individual verbs. Rendered only once the ticket has a worktree. Lazy-loads
 * `status` + the merge-base diff on mount (the `BaseBranchField` precedent —
 * fetch on first appearance rather than riding along in the boot payload) and
 * refetches after every action so the summary never goes stale. All fetch/busy
 * state is component-local (dialog-state-local convention: no global store)
 * since it's read fresh whenever this section is visible.
 */
function WorktreeDoneFlowSection({ ticket }: { ticket: Ticket }) {
  const [status, setStatus] = React.useState<WorktreeStatusSnapshot | null>(null);
  const [diff, setDiff] = React.useState<DiffStat | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [stage, setStage] = React.useState<DoneFlowStage>("idle");

  const refresh = React.useCallback(async () => {
    try {
      const [statusResult, diffResult] = await Promise.all([
        window.api.worktree.status(ticket.id),
        window.api.worktree.diff(ticket.id, "merge-base"),
      ]);
      if (!statusResult.ok) {
        setLoadError(statusResult.error);
        return;
      }
      if (!diffResult.ok) {
        setLoadError(diffResult.error);
        return;
      }
      setLoadError(null);
      setStatus(statusResult.status);
      setDiff(diffResult.diff);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [ticket.id]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Standalone Commit (chevron menu): keeps its own "Committed: <message>" toast. */
  async function runCommitOnly() {
    setStage("committing");
    try {
      const result = await window.api.worktree.commit(ticket.id);
      if (!result.ok) {
        toastError(`Could not commit: ${result.error}`);
        return;
      }
      if (result.committed) {
        toast.success(`Committed: ${result.message}`);
      } else {
        // Clean-tree no-op: the snapshot was stale — informational, not an error.
        toast.info("Nothing to commit — the worktree was already clean.");
      }
    } catch (error) {
      toastError(`Could not commit: ${errorMessage(error)}`);
    } finally {
      await refresh();
      setStage("idle");
    }
  }

  /** Standalone push flow (primary push verbs + chevron menu): the existing pushPr, no commit. */
  async function runPushOnly(isUpdate: boolean) {
    setStage("pushing");
    try {
      const result = await window.api.worktree.pushPr(ticket.id);
      if (!result.ok) {
        toastError(result.error);
        return;
      }
      toastPushResult(isUpdate, result.existing);
    } catch (error) {
      toastError(`Could not push: ${errorMessage(error)}`);
    } finally {
      await refresh();
      setStage("idle");
    }
  }

  /**
   * The stacked primary flow: commit, then (only on success) push. The
   * intermediate commit toast is suppressed — one final toast only. The
   * `worktree_committed` History event still records in main, so nothing is
   * lost. On commit failure the flow stops (its error toast already fired) —
   * but a clean-tree NO-OP (`committed: false`) continues: the snapshot that
   * offered "Commit & …" may be stale (the agent committed meanwhile), and the
   * push half is still exactly what the user asked for.
   */
  async function runCommitThenPush(isUpdate: boolean) {
    setStage("committing");
    try {
      const commitResult = await window.api.worktree.commit(ticket.id);
      if (!commitResult.ok) {
        toastError(`Could not commit: ${commitResult.error}`);
        return;
      }
      setStage("pushing");
      const pushResult = await window.api.worktree.pushPr(ticket.id);
      if (!pushResult.ok) {
        toastError(pushResult.error);
        return;
      }
      toastPushResult(isUpdate, pushResult.existing);
    } catch (error) {
      toastError(errorMessage(error));
    } finally {
      await refresh();
      setStage("idle");
    }
  }

  // Reuses the app's one sanctioned external-open seam (live-preview.ts's
  // markdown link handler): a `window.open` of an http(s) target never
  // actually opens a new BrowserWindow — main's `setWindowOpenHandler` denies
  // it and routes the url to `shell.openExternal` instead. No new IPC needed.
  function openPr() {
    if (ticket.prUrl) window.open(ticket.prUrl, "_blank", "noopener");
  }

  const view = resolveDoneFlow(status, ticket.prUrl, stage);
  const mergeBaseSummary = diff ? formatMergeBaseSummary(diff) : null;

  function runPrimary() {
    switch (view.primary.kind) {
      case "commit-pr":
        void runCommitThenPush(false);
        break;
      case "commit-push-updates":
        void runCommitThenPush(true);
        break;
      case "push-pr":
        void runPushOnly(false);
        break;
      case "push-updates":
        void runPushOnly(true);
        break;
      case "view-pr":
        openPr();
        break;
      case "create-pr":
        break;
    }
  }

  const primaryButton = (
    <Button
      variant="outline"
      size="xs"
      className="rounded-r-none"
      disabled={view.primary.disabled}
      onClick={runPrimary}
    >
      <PrimaryActionIcon kind={view.primary.kind} />
      {view.primary.label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2">
      {loadError ? (
        <span className="text-xs text-muted-foreground">
          Could not load worktree status: {loadError}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {mergeBaseSummary ?? "No changes vs base yet"}
        </span>
      )}
      {/* One control: primary + chevron, corners squared between them so they
          read as a single split button (composer-footer adjacency pattern). */}
      <div className="inline-flex w-fit">
        {view.primary.reason ? (
          <Tooltip>
            {/* A disabled button emits no pointer events; the span keeps the
                tooltip trigger hoverable so the reason still shows. */}
            <TooltipTrigger asChild>
              <span className="inline-flex">{primaryButton}</span>
            </TooltipTrigger>
            <TooltipContent>{view.primary.reason}</TooltipContent>
          </Tooltip>
        ) : (
          primaryButton
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon-xs"
              aria-label="More pull request actions"
              className="-ml-px rounded-l-none"
            >
              <CaretDownIcon weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DoneFlowMenuItem
              action={view.menu.commit}
              icon={<GitCommitIcon weight="fill" />}
              onRun={() => void runCommitOnly()}
            />
            <DoneFlowMenuItem
              action={view.menu.push}
              icon={<GitPullRequestIcon weight="fill" />}
              onRun={() => void runPushOnly(view.menu.push.kind === "push-updates")}
            />
            <DoneFlowMenuItem
              action={view.menu.openPr}
              icon={<ArrowSquareOutIcon weight="fill" />}
              onRun={openPr}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * The right rail's Properties block: status, priority, labels, and worktree identity
 * (branch/baseBranch inline-editable, worktreePath read-only), then created/updated timestamps.
 */
export function TicketProperties({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  const worktreePhase = useWorktreeStore((state) => phaseFor(state.phases, ticket.id));
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <PropertyLabel>Status</PropertyLabel>
        <StatusField projectId={projectId} ticket={ticket} />
      </div>
      <div className="flex flex-col gap-1.5">
        <PropertyLabel>Priority</PropertyLabel>
        <PriorityField projectId={projectId} ticket={ticket} />
      </div>
      <div className="flex flex-col gap-1.5">
        <PropertyLabel>Labels</PropertyLabel>
        <TicketLabelEditor projectId={projectId} ticket={ticket} />
      </div>
      {/* Branch and base branch are settable ONCE (user decision): while unset they take an
          inline edit (base branch: a picker over the project's local branches), and once a
          non-empty value is committed they render read-only. The empty→null commit mapping
          still applies to branch's initial set. Validation of the entered value happens in main
          (data-ipc) — added by another agent. */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex flex-col gap-1.5">
          <PropertyLabel>Branch</PropertyLabel>
          {ticket.branch ? (
            <ReadonlyIdentity value={ticket.branch} />
          ) : (
            <InlineTextField
              value={ticket.branch}
              onCommit={(next) =>
                void useBoardStore.getState().updateTicket({ ticketId: ticket.id, branch: next })
              }
            />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <PropertyLabel>Base branch</PropertyLabel>
          {ticket.baseBranch ? (
            <ReadonlyIdentity value={ticket.baseBranch} />
          ) : (
            <BaseBranchField projectId={projectId} ticket={ticket} />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <PropertyLabel>Worktree</PropertyLabel>
          <WorktreePathField path={ticket.worktreePath} />
          {worktreePhase === "failed" ? (
            <WorktreeFailedNotice projectId={projectId} ticketId={ticket.id} />
          ) : null}
        </div>
        {ticket.worktreePath ? (
          <div className="flex flex-col gap-1.5">
            <PropertyLabel>Pull request</PropertyLabel>
            <WorktreeDoneFlowSection ticket={ticket} />
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5 border-t border-border pt-3 text-label text-muted-foreground">
        <span>Created {formatTimestamp(ticket.createdAt)}</span>
        <span>Updated {formatTimestamp(ticket.updatedAt)}</span>
      </div>
    </section>
  );
}
