/**
 * The Now page's repository card — the Calm Stack's one worktree surface
 * (lab/scratches/ticket-right-sidebar.tsx `EnvironmentSummary`).
 *
 * Three stacked rows inside one framed card, in the order a person asks about
 * them: what changed (and a way into the Diffs page), which branch it is on
 * (and, behind it, the worktree identity), and what to do about it — the
 * done-flow split button (decision #45) balanced against the outward-facing
 * pull-request link.
 *
 * It replaces the pinned Environment/Sources inspector the icon-mode rail used
 * to stack above every navigator: the Sources half was always a subset of the
 * Files page's own "Referenced" section, and the Environment half's rows all
 * routed into pages this card either shows inline or links to directly.
 *
 * It owns the rail's ONE live read of `worktree.status` + the composed Change
 * Set: the changes row and the publish row are projections of the same
 * snapshot, so the two halves of the card cannot disagree (#108). The rail is
 * exclusive (one page at a time), so this never doubles up with the Diffs
 * page's own watch.
 *
 * ONE FAULT, ONE SENTENCE, ONE RECOVERY. The status read and the change watch
 * fail for the same reasons and usually with the same string — a worktree
 * directory that is gone answers both with "missing on disk". Drawn separately
 * they stacked that sentence twice, under a changes row stating the same fault a
 * third time in a different register, over a retention prompt that had nothing
 * to do with it. So a fault REPLACES the action block rather than being bolted
 * above it, its diagnostic text goes to `title` (rail-panel-parts.tsx: at this
 * width the raw text pushes Retry off the row), and the changes row falls back
 * to its noun. Retention returns the moment a read lands; a ticket can still be
 * archived from the board while it does not.
 *
 * Two deliberate departures from the scratch, both recorded because every other
 * one in this file is:
 *
 *  - The publish row shows whenever a worktree EXISTS; the scratch draws it only
 *    on a dirty tree (`!clean && !noWorktree`). Decision #44 is button-never-
 *    gate and #45 is one adaptive split button, so the control stays put and
 *    re-labels itself — a row that vanishes the moment the tree goes clean takes
 *    "Push", "View PR" and the whole archive-ready wrap-up down with it.
 *  - The commit verbs are GATED by a confirmation dialog (`CommitGateDialog`),
 *    which partially reverses #45's "no gate" for this one action. The scratch
 *    drew that dialog, the owner ruled for it, and the reason is that a press
 *    here writes a commit that cannot be taken back — every other verb the
 *    button offers is repeatable or reversible.
 */
import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BellSlashIcon } from "@phosphor-icons/react/dist/csr/BellSlash";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitCommitIcon } from "@phosphor-icons/react/dist/csr/GitCommit";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { GitPullRequestIcon } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { toast } from "sonner";
import { changeSetToDiffStat, errorMessage, type DiffStat, type Ticket } from "@volli/shared";

import { createTerminalSession } from "@renderer/components/sessions/session-create";
import {
  formatChangeSetSummary,
  resolveDoneFlow,
  type DoneFlowStage,
  type MenuAction,
  type PrimaryActionKind,
  type WorktreeStatusSnapshot,
} from "@renderer/components/ticket/worktree-done-flow-model";
import { subscribeWorktreeChanges } from "@renderer/components/ticket/worktree-change-watch";
import {
  ARCHIVE_CLEAN_LABEL,
  DISMISS_LABEL,
  KEEP_WORKTREE_LABEL,
  resolveRetention,
  UNKEEP_LABEL,
  type RetentionNotice,
} from "@renderer/components/ticket/worktree-retention-model";
import { DiffTotals, RailFaultBanner } from "@renderer/components/ticket/rail-panel-parts";
import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useTicketRetention } from "@renderer/hooks/use-ticket-retention";
import { toastError } from "@renderer/lib/toast";
import { useDebouncedCallback } from "@renderer/lib/use-debounced-callback";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { ticketScope } from "@renderer/stores/sessions";
import { phaseFor, useWorktreeStore } from "@renderer/stores/worktree";

/** One card row's shared frame: full-width, quiet hover, seam above every row but the first. */
const ROW = "flex w-full items-center gap-2 px-3.5 text-left";

function CardLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-label font-medium text-muted-foreground uppercase">{children}</p>;
}

/**
 * The gate in front of the card's one irreversible verb
 * (lab/scratches/ticket-right-sidebar.tsx `CommitDialog`). A press of "Commit &
 * create draft PR" writes a commit; there is no undo in this app for that, and
 * every other verb the split button offers is either repeatable (push) or a
 * link (View PR). So the commit verbs — and only they — confirm first.
 *
 * It states what is about to land: the branch it lands on, and the Change Set
 * the card is already showing. The scratch also drew an editable commit message
 * and an "Include unstaged changes" checkbox; neither is here, because
 * `volli:worktree-commit` accepts neither — the message is the fixed
 * `chore(<DISPLAY-ID>)` line (main/worktree/commit.ts) and the stage is always
 * `-A`. A field that discards what you type is worse than one sentence naming
 * what the command actually does; restoring them is a main-process change, not
 * a renderer one.
 */
function CommitGateDialog({
  open,
  onOpenChange,
  branch,
  changesLabel,
  diff,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  branch: string;
  changesLabel: string;
  diff: DiffStat | null;
  /** The primary's own verb, so the press that opened this reads as the press that finishes it. */
  confirmLabel: string;
  onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-5" data-testid="ticket-commit-gate">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="shrink-0" />
            <span className="truncate font-mono text-sm">{branch}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <GitDiffIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-ui font-medium">{changesLabel}</span>
            {diff === null ? null : <DiffTotals diff={diff} />}
          </div>
          <p className="text-xs text-muted-foreground">
            Everything in the worktree is staged and committed with a generated message.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
 * The base-branch picker: while `ticket.baseBranch` is unset, a chip trigger +
 * `DropdownMenuRadioGroup` replaces the free-text field, offering the project's
 * local branches (fetched lazily — only on the picker's first open, then cached
 * for the field's lifetime). The persisted current value stays selectable even
 * if a later fetch no longer lists it, though for an unset field that only
 * matters if the branch list changes between two opens. Selecting a branch
 * commits it exactly like the old free-text field did (same `updateTicket`
 * write-through) — once committed, the popover swaps this out for a read-only
 * ref (branch/baseBranch are settable ONCE).
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
        toastError(`Couldn't load branches: ${result.error}`);
        return;
      }
      setBranches(result.branches);
    } catch (error) {
      toastError(`Couldn't load branches: ${errorMessage(error)}`);
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
          size="sm"
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
 * The card's inline notice for a failed worktree ensure (transient phase,
 * stores/worktree.ts), with a Retry that boots a fresh bare-shell ticket
 * session — the same path `TicketDetail`'s "New session" uses — to re-run
 * `ensure`. No kickoff: retry only needs the setup pipeline to run again, not a
 * fresh agent prompt.
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

/**
 * The branch row's popover: the full base → branch pair (editable while unset —
 * both are settable ONCE, user decision), then the worktree path with its
 * reveal-in-Finder affordance. This is where the identity fields the Details
 * drawer used to list now live; the row itself shows only the pair.
 */
function RepositoryPopoverContent({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  const worktreePhase = useWorktreeStore((state) => phaseFor(state.phases, ticket.id));

  async function reveal() {
    if (ticket.worktreePath === null) return;
    try {
      const result = await window.api.fs.revealInFinder(ticket.worktreePath);
      if (!result.ok) toastError(`Couldn't reveal in Finder: ${result.error}`);
    } catch (error) {
      toastError(`Couldn't reveal in Finder: ${errorMessage(error)}`);
    }
  }

  return (
    <PopoverContent align="start" className="flex w-72 flex-col gap-3 p-3">
      <div className="flex flex-col gap-1.5">
        <CardLabel>Base branch</CardLabel>
        {ticket.baseBranch ? (
          <span className="block truncate px-2 font-mono text-xs text-foreground">
            {ticket.baseBranch}
          </span>
        ) : (
          <BaseBranchField projectId={projectId} ticket={ticket} />
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <CardLabel>Branch</CardLabel>
        {ticket.branch ? (
          <span className="block truncate px-2 font-mono text-xs text-foreground">
            {ticket.branch}
          </span>
        ) : (
          <InlineTextField
            value={ticket.branch}
            onCommit={(next) =>
              void useBoardStore.getState().updateTicket({ ticketId: ticket.id, branch: next })
            }
          />
        )}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <CardLabel>Worktree</CardLabel>
        <div className="flex items-center gap-1">
          <span
            title={ticket.worktreePath ?? undefined}
            className="min-w-0 flex-1 truncate px-2 font-mono text-xs text-foreground"
          >
            {ticket.worktreePath ?? <span className="text-muted-foreground">—</span>}
          </span>
          {ticket.worktreePath ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Reveal in Finder"
              title="Reveal in Finder"
              onClick={() => void reveal()}
            >
              <FolderOpenIcon />
            </Button>
          ) : null}
        </div>
        {worktreePhase === "failed" ? (
          <WorktreeFailedNotice projectId={projectId} ticketId={ticket.id} />
        ) : null}
      </div>
    </PopoverContent>
  );
}

/**
 * The Phosphor icon for a primary action, mirroring the verb's menu icon.
 * `filled` renders the fill weight for the chevron-menu treatment (the demoted
 * done-flow primary when Archive & clean takes over the button).
 */
function PrimaryActionIcon({
  kind,
  filled = false,
}: {
  kind: PrimaryActionKind;
  filled?: boolean;
}) {
  const weight = filled ? "fill" : undefined;
  if (kind === "commit-pr" || kind === "commit-push-updates")
    return <GitCommitIcon weight={weight} />;
  if (kind === "view-pr") return <ArrowSquareOutIcon weight={weight} />;
  return <GitPullRequestIcon weight={weight} />;
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
 * One non-gating retention notice (issue #76, decision #44 "button-never-gate"):
 * a muted line surfacing a merge conflict or failing checks. It explains why a
 * PR can't merge yet; it disables nothing. When the notice carries `detail`
 * (the failing checks' names) the line becomes a tooltip trigger listing them.
 */
function RetentionNoticeLine({ notice }: { notice: RetentionNotice }) {
  const line = (
    <span className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
      <WarningIcon />
      {notice.text}
    </span>
  );
  if (!notice.detail) return line;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{line}</TooltipTrigger>
      <TooltipContent>{notice.detail}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The Now page's repository card. Lazy-loads `status` + the composed Change Set
 * on mount (fetch on first appearance rather than riding along in the boot
 * payload) and refetches after every action so the card never goes stale. All
 * fetch/busy state is component-local (dialog-state-local convention: no global
 * store) since it's read fresh whenever this page is visible.
 */
export function TicketRepositorySummary({
  projectId,
  ticket,
  onShowChanges,
}: {
  projectId: string;
  ticket: Ticket;
  /** Deliberate selection: the changes row is a route into the Diffs page. */
  onShowChanges(): void;
}) {
  const [status, setStatus] = React.useState<WorktreeStatusSnapshot | null>(null);
  const [diff, setDiff] = React.useState<DiffStat | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [watchError, setWatchError] = React.useState<string | null>(null);
  // Bumped by Retry to re-run the watch effect after a fault tore it down.
  const [watchAttempt, setWatchAttempt] = React.useState(0);
  const [stage, setStage] = React.useState<DoneFlowStage>("idle");
  // The global Done-TTL, only needed to name the "In Done for N+ days" line.
  const [ttlDays, setTtlDays] = React.useState<number | null>(null);
  // A retention mutation (archive/keep/dismiss) in flight — disables its controls.
  const [retentionBusy, setRetentionBusy] = React.useState(false);
  // The commit verb awaiting confirmation; `isUpdate` picks the tail toast.
  const [pendingCommit, setPendingCommit] = React.useState<{ isUpdate: boolean } | null>(null);
  const hasWorktree = ticket.worktreePath !== null;
  const { state: retention, reload: reloadRetention } = useTicketRetention(ticket.id, hasWorktree);
  const planningChange = useBoardStore((store) => store.lastPlanningChange);

  /** The git-spawning half: `worktree.status` + composed Change Set. */
  const refreshStatusAndDiff = React.useCallback(async () => {
    if (!hasWorktree) return;
    try {
      const [statusResult, changeSetResult] = await Promise.all([
        window.api.worktree.status(ticket.id),
        window.api.worktree.changeSet(ticket.id),
      ]);
      if (!statusResult.ok) {
        setLoadError(statusResult.error);
        return;
      }
      if (!changeSetResult.ok) {
        setLoadError(changeSetResult.error);
        return;
      }
      setLoadError(null);
      setStatus(statusResult.status);
      setDiff(changeSetToDiffStat(changeSetResult.changeSet));
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [ticket.id, hasWorktree]);

  /** The TTL-only half: a single non-critical DB read (only labels a line, never blocks the
   * status/diff summary on failure) — no git subprocess, so unlike `refreshStatusAndDiff` it's
   * cheap enough to re-run on every broadcast without debouncing (see the effect below). */
  const refreshTtl = React.useCallback(async () => {
    const ttlResult = await window.api.retention.getTtlDays();
    if (ttlResult.ok) setTtlDays(ttlResult.days);
  }, []);

  /** Full refresh: mount, and every direct action below (commit/push/archive/etc.) — those want
   * immediate, un-debounced feedback since the user just triggered them locally. */
  const refresh = React.useCallback(async () => {
    await Promise.all([refreshStatusAndDiff(), refreshTtl()]);
  }, [refreshStatusAndDiff, refreshTtl]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // The card is projected from the same Change Set the Diffs page reads, so it
  // must move when the worktree does — the planning broadcast below only fires
  // on planning mutations, and an agent editing files makes none. Without this
  // the card sat stale until something unrelated happened. The rail is
  // exclusive (one page at a time), so this never doubles up with the Diffs
  // page's own watch.
  React.useEffect(() => {
    if (!hasWorktree) return;
    setWatchError(null);
    return subscribeWorktreeChanges(window.api.worktree, ticket.id, {
      onChanged: () => void refreshStatusAndDiff(),
      onWatchError: setWatchError,
    });
  }, [ticket.id, hasWorktree, refreshStatusAndDiff, watchAttempt]);

  /**
   * The card's one recovery. It re-runs the status/Change Set read AND re-arms
   * the watch the fault tore down — they are the same fault to a reader, so
   * they are the same button. `refreshStatusAndDiff` clears `loadError` itself
   * on success, so nothing here has to guess which half was broken.
   */
  function retryWorktreeRead() {
    setWatchError(null);
    setWatchAttempt((attempt) => attempt + 1);
    void refreshStatusAndDiff();
  }

  // K4 (review): a data-changed broadcast used to be scopeless, so this rail had
  // to debounce a git refresh on EVERY bump (another ticket moving, a retention
  // toggle elsewhere) — wasteful, but undroppable since the broadcast is the only
  // path a CLI/rail-side commit/push has to reach this rail (issue #80). The
  // broadcast now carries the change's SCOPE, so three cases split cleanly:
  //   • provably ANOTHER ticket → this ticket's git + TTL can't have moved, skip;
  //   • THIS ticket (a commit/push/worktree change carrying our id) → the git
  //     state genuinely changed, refetch promptly, NO debounce — the CLI-commit-
  //     reaches-the-rail guarantee, now faster;
  //   • untargeted ("anything may have changed") → we can't rule this ticket out,
  //     so refresh conservatively but DEBOUNCED, collapsing a burst of unrelated
  //     broadcasts into one status+diff subprocess pair.
  // TTL is a cheap global DB read, so it re-runs directly on any non-skipped bump.
  const debouncedGitRefresh = useDebouncedCallback(() => void refreshStatusAndDiff(), 1500);
  // Tracks the version already covered by the mount-time `refresh()` above, so this
  // effect's own first run (which always fires on mount, whatever the initial version is) is a
  // no-op rather than a redundant duplicate fetch.
  const seenPlanningVersion = React.useRef(planningChange.version);
  React.useEffect(() => {
    if (seenPlanningVersion.current === planningChange.version) return;
    seenPlanningVersion.current = planningChange.version;
    if (planningChange.ticketId !== null && planningChange.ticketId !== ticket.id) return;
    void refreshTtl();
    if (planningChange.ticketId === ticket.id) {
      void refreshStatusAndDiff();
    } else {
      debouncedGitRefresh.schedule();
    }
  }, [planningChange, ticket.id, refreshTtl, refreshStatusAndDiff, debouncedGitRefresh]);

  /** Standalone Commit (chevron menu): keeps its own "Committed: <message>" toast. */
  async function runCommitOnly() {
    setStage("committing");
    try {
      const result = await window.api.worktree.commit(ticket.id);
      if (!result.ok) {
        toastError(`Couldn't commit: ${result.error}`);
        return;
      }
      if (result.committed) {
        toast.success(`Committed: ${result.message}`);
      } else {
        // Clean-tree no-op: the snapshot was stale — informational, not an error.
        toast.info("Nothing to commit.");
      }
    } catch (error) {
      toastError(`Couldn't commit: ${errorMessage(error)}`);
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
      toastError(`Couldn't push: ${errorMessage(error)}`);
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
        toastError(`Couldn't commit: ${commitResult.error}`);
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

  // Reuses the app's one sanctioned external-open seam (the same one the
  // markdown link handler uses, `editor/link-open.ts`): a `window.open` of an
  // http(s) target never actually opens a new BrowserWindow — main's
  // `setWindowOpenHandler` denies it and routes the url to `shell.openExternal`
  // instead. No new IPC needed.
  function openPr() {
    if (ticket.prUrl) window.open(ticket.prUrl, "_blank", "noopener");
  }

  /**
   * Archive & clean (the archive-ready primary): archives the ticket and removes
   * its worktree. A DIRTY worktree refusal comes typed from main — rendered
   * faithfully (decision #16: automation never destroys uncommitted work). On
   * success the ticket leaves the board via the broadcast; no local refresh
   * (this card may already be unmounting with it).
   */
  async function runArchiveAndClean() {
    setRetentionBusy(true);
    try {
      const result = await window.api.retention.archiveAndClean(ticket.id);
      if (!result.ok) {
        toastError(result.error);
        return;
      }
      toast.success("Worktree archived & cleaned");
    } catch (error) {
      toastError(`Couldn't archive: ${errorMessage(error)}`);
    } finally {
      setRetentionBusy(false);
    }
  }

  /**
   * Keep / un-keep the worktree: the durable pin exempting BOTH retention paths.
   *
   * The handler already broadcasts `data-changed` on success (K3, review), but that broadcast
   * drives `refreshPlanningData` (lib/boot.ts), which awaits a full `bootstrap()` re-fetch of
   * every project/ticket/label BEFORE it publishes `lastPlanningChange` — a materially slower round
   * trip than this direct, single-ticket `retention.state()` read. The explicit `reloadRetention()`
   * here is therefore not redundant with the broadcast-driven refetch; it's what makes the Keep
   * pin's own toggle land without a visible lag, and the broadcast-driven refetch remains as the
   * catch-all for every OTHER surface (e.g. another open ticket's card) that also needs to learn
   * about this change. Kept deliberately — do not remove for being "already covered".
   */
  async function runSetKeep(keep: boolean) {
    setRetentionBusy(true);
    try {
      const result = await window.api.retention.setKeep(ticket.id, keep);
      if (!result.ok) {
        toastError(`Couldn't update Keep: ${result.error}`);
        return;
      }
      toast.success(keep ? "Worktree kept" : "Keep removed");
    } catch (error) {
      toastError(`Couldn't update Keep: ${errorMessage(error)}`);
    } finally {
      setRetentionBusy(false);
      reloadRetention();
    }
  }

  /**
   * Dismiss the archive prompt for this launch (re-offered next launch — not the Keep pin).
   * Same reasoning as `runSetKeep` above for the explicit `reloadRetention()` — it beats the
   * broadcast-driven `refreshPlanningData` round trip for THIS ticket's own perceived latency.
   */
  async function runDismiss() {
    setRetentionBusy(true);
    try {
      const result = await window.api.retention.dismiss(ticket.id);
      if (!result.ok) {
        toastError(`Couldn't dismiss: ${result.error}`);
        return;
      }
    } catch (error) {
      toastError(`Couldn't dismiss: ${errorMessage(error)}`);
    } finally {
      setRetentionBusy(false);
      reloadRetention();
    }
  }

  const view = resolveDoneFlow(status, ticket.prUrl, stage);
  const retentionView = resolveRetention(retention, ttlDays);
  const changeSetSummary = diff ? formatChangeSetSummary(diff) : null;
  const fileCount = diff?.files.length ?? 0;

  // The status read is the cause and the watch dying is its consequence, so the
  // direct read's message wins when both are set — they are almost always the
  // same string anyway.
  const fault = loadError ?? watchError;
  // No worktree means no read to wait for: `refreshStatusAndDiff` returns early
  // and `diff` stays null for good, so "No changes" would be a permanent lie.
  const loadingChanges = hasWorktree && diff === null && fault === null;
  const changesLabel = !hasWorktree
    ? "No worktree yet"
    : diff === null
      ? // Never got a snapshot: the banner below carries the fault and its
        // Retry, so the row states the noun rather than the failure again.
        "Changes"
      : fileCount === 0
        ? "No changes"
        : `${fileCount} ${fileCount === 1 ? "change" : "changes"}`;

  function runPrimary() {
    switch (view.primary.kind) {
      // The two verbs that write a commit ask first; everything below this is
      // repeatable or a link, and goes straight through.
      case "commit-pr":
        setPendingCommit({ isUpdate: false });
        break;
      case "commit-push-updates":
        setPendingCommit({ isUpdate: true });
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

  // The done-flow primary (commit/push/View PR). When the ticket is
  // archive-ready it is DEMOTED into the chevron menu and Archive & clean takes
  // the button — still one adaptive action (decision #45), never a second row.
  //
  // `shrink` overrides the button's own `shrink-0`: the longest verb ("Commit &
  // create draft PR") is wider than the card at the rail's 240px floor, and a
  // button that refuses to shrink pushes its own chevron off the card's clipped
  // edge. It truncates and keeps its full label in `title` instead — a control
  // you can read to the end elsewhere beats one you cannot reach.
  const primaryClassName =
    "min-w-0 shrink border-sidebar-border bg-background/35 px-2.5 text-xs shadow-xs [&>span]:truncate";

  const doneFlowPrimaryButton = (
    <Button
      variant="outline"
      size="sm"
      className={primaryClassName}
      title={view.primary.label}
      disabled={view.primary.disabled}
      onClick={runPrimary}
    >
      <PrimaryActionIcon kind={view.primary.kind} />
      <span>{view.primary.label}</span>
    </Button>
  );

  const archivePrimaryButton = (
    <Button
      variant="outline"
      size="sm"
      className={primaryClassName}
      title={ARCHIVE_CLEAN_LABEL}
      disabled={retentionBusy}
      onClick={() => void runArchiveAndClean()}
    >
      <ArchiveIcon />
      <span>{ARCHIVE_CLEAN_LABEL}</span>
    </Button>
  );

  // The row's outward-facing half, balancing the split button: the PR on
  // GitHub. The scratch balances with "Compare", which this cannot honestly
  // draw before a PR exists — twice over. The renderer only ever learns
  // `prUrl`, never the repository's remote, so there is no compare URL to
  // build; and a branch that has never been pushed has nothing on GitHub to
  // compare against, so the control the scratch's mock always showed would 404
  // in exactly the state the mock was showing it in. Suppressed when the
  // primary is already "View PR" — one control per destination — and absent
  // until a PR exists, so the row is calm rather than carrying a dead slot.
  const prLink =
    ticket.prUrl !== null && view.primary.kind !== "view-pr" ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-sidebar-border bg-background/35 px-2.5 text-xs shadow-xs"
            aria-label="Open the pull request on GitHub"
            onClick={openPr}
          >
            <GithubLogoIcon weight="fill" />
            PR
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Open the pull request on GitHub</TooltipContent>
      </Tooltip>
    ) : null;

  return (
    // No elevation: the scratch asks for one in light mode, but writes it as
    // `hsl(var(--foreground)/…)` against a `--foreground` that is a hex — an
    // invalid value the browser drops, so the card that was reviewed and
    // approved is flat in BOTH appearances (verified in the lab, computed
    // `box-shadow: none` under `.light`). Border plus surface is the whole
    // frame. To add the lift the scratch intended, this wants
    // `shadow-[0_1px_2px_var(--shadow-ink)/6%,…]` and a real token, not a
    // revival of the broken string.
    <section
      data-testid="ticket-repository-summary"
      className="mx-4 overflow-hidden rounded-xl border border-sidebar-border/70 bg-background/55 group-data-[narrow=true]/rail:mx-3 dark:bg-sidebar-accent/45"
    >
      <button
        type="button"
        data-testid="ticket-repository-changes"
        onClick={onShowChanges}
        title={changeSetSummary ?? undefined}
        aria-busy={loadingChanges || undefined}
        aria-label={`${loadingChanges ? "Reading changes" : changesLabel}, show Diffs`}
        className={cn(ROW, "pt-3 pb-2.5 hover:bg-sidebar-accent/45")}
      >
        <GitDiffIcon className="size-4 shrink-0 text-muted-foreground" />
        {/* One flex child either way, so the label lands where the bar was
            rather than the row reflowing when the first read returns. The bar
            is the page skeletons' own drawing, at a text line's height. */}
        <span className="min-w-0 flex-1">
          {loadingChanges ? (
            <span
              aria-hidden
              data-testid="ticket-repository-changes-loading"
              className="my-[3px] block h-3.5 w-24 animate-pulse rounded bg-sidebar-accent/70 motion-reduce:animate-none"
            />
          ) : (
            <span className="block truncate text-ui font-medium">{changesLabel}</span>
          )}
        </span>
        {diff === null ? null : fileCount === 0 ? (
          <CheckCircleIcon className="shrink-0 text-emerald-500" />
        ) : (
          <DiffTotals diff={diff} />
        )}
      </button>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="ticket-repository-branch"
            aria-label={
              ticket.branch === null
                ? "Worktree identity"
                : `Branch ${ticket.baseBranch ?? "base"} to ${ticket.branch}`
            }
            className={cn(
              ROW,
              "min-h-8 border-t border-sidebar-border/70 py-2.5 hover:bg-sidebar-accent/45",
            )}
          >
            <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
            {ticket.baseBranch !== null && ticket.branch !== null ? (
              <>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {ticket.baseBranch}
                </span>
                <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
              </>
            ) : null}
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-sidebar-foreground">
              {ticket.branch ?? ticket.baseBranch ?? "No branch yet"}
            </span>
            <CaretDownIcon className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <RepositoryPopoverContent projectId={projectId} ticket={ticket} />
      </Popover>

      {hasWorktree ? (
        <div className="flex flex-col gap-2 border-t border-sidebar-border/70 px-3.5 py-2.5">
          {fault !== null ? (
            // The whole block, not a line above it: with no readable worktree
            // there is no honest publish state to offer, and the retention
            // prompt below is a different subject that was only ever stacked
            // here because both happened to be true at once.
            <RailFaultBanner
              inset={false}
              testId="ticket-repository-fault"
              // A noun, and short enough to stay on one line inside the card's
              // own padding at the rail's narrowest — a label that wraps puts
              // Retry on a second line and the banner becomes a paragraph.
              label="Worktree unreadable"
              error={fault}
              onRetry={retryWorktreeRead}
            />
          ) : (
            <>
              {/* The archive-reason context line — why the wrap-up is being offered. */}
              {retentionView.archiveReady && retentionView.reasonLine ? (
                <span className="flex items-center gap-1.5 text-xs text-foreground">
                  <ArchiveIcon className="text-primary" />
                  {retentionView.reasonLine}
                </span>
              ) : null}
              {/* Non-gating surfacing: conflicts / failing checks (decision #44). */}
              {retentionView.notices.map((notice) => (
                <RetentionNoticeLine key={notice.text} notice={notice} />
              ))}
              <div className="flex w-full items-center justify-between gap-2">
                <ButtonGroup aria-label="Publish repository changes" className="min-w-0">
                  {retentionView.archiveReady ? (
                    archivePrimaryButton
                  ) : view.primary.reason ? (
                    <Tooltip>
                      {/* A disabled button emits no pointer events; the span keeps the
                      tooltip trigger hoverable so the reason still shows. */}
                      <TooltipTrigger asChild>
                        <span className="inline-flex min-w-0">{doneFlowPrimaryButton}</span>
                      </TooltipTrigger>
                      <TooltipContent>{view.primary.reason}</TooltipContent>
                    </Tooltip>
                  ) : (
                    doneFlowPrimaryButton
                  )}
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon-sm"
                            aria-label="More repository actions"
                            className="border-sidebar-border bg-background/35 shadow-xs"
                          >
                            <DotsThreeIcon weight="bold" />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="top">More repository actions</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="start">
                      {/* Archive-ready: the demoted done-flow primary leads, then the
                      unbundled verbs, then the Keep/Dismiss retention escape hatches. */}
                      {retentionView.archiveReady ? (
                        <>
                          <DropdownMenuItem
                            disabled={view.primary.disabled}
                            onSelect={runPrimary}
                            className="justify-between gap-6"
                          >
                            <span className="flex items-center gap-2">
                              <PrimaryActionIcon kind={view.primary.kind} filled />
                              {view.primary.label}
                            </span>
                            {view.primary.disabled && view.primary.reason ? (
                              <span className="text-xs text-muted-foreground">
                                {view.primary.reason}
                              </span>
                            ) : null}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      ) : null}
                      <DoneFlowMenuItem
                        action={view.menu.commit}
                        icon={<GitCommitIcon />}
                        onRun={() => void runCommitOnly()}
                      />
                      <DoneFlowMenuItem
                        action={view.menu.push}
                        icon={<GitPullRequestIcon />}
                        onRun={() => void runPushOnly(view.menu.push.kind === "push-updates")}
                      />
                      <DoneFlowMenuItem
                        action={view.menu.openPr}
                        icon={<ArrowSquareOutIcon />}
                        onRun={openPr}
                      />
                      {retentionView.archiveReady ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={retentionBusy}
                            onSelect={() => void runSetKeep(true)}
                          >
                            <PushPinIcon />
                            {KEEP_WORKTREE_LABEL}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={retentionBusy}
                            onSelect={() => void runDismiss()}
                          >
                            <BellSlashIcon />
                            {DISMISS_LABEL}
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ButtonGroup>
                {prLink}
              </div>
              {/* The quiet "kept" state (Keep exempts the ticket from both paths) with its un-keep path. */}
              {retentionView.kept ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <PushPinIcon />
                  Worktree kept
                  <button
                    type="button"
                    disabled={retentionBusy}
                    onClick={() => void runSetKeep(false)}
                    className="text-primary-text hover:underline disabled:opacity-50"
                  >
                    {UNKEEP_LABEL}
                  </button>
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <CommitGateDialog
        open={pendingCommit !== null}
        onOpenChange={(next) => {
          if (!next) setPendingCommit(null);
        }}
        branch={ticket.branch ?? ticket.baseBranch ?? "this branch"}
        changesLabel={changesLabel}
        diff={diff}
        confirmLabel={view.primary.label}
        onConfirm={() => {
          const isUpdate = pendingCommit?.isUpdate ?? false;
          setPendingCommit(null);
          void runCommitThenPush(isUpdate);
        }}
      />
    </section>
  );
}
