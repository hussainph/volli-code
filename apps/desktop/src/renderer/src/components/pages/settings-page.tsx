import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@volli/shared";
import type {
  DirtyWorktreeOrphan,
  KeptWorktreeOrphan,
  RemovedWorktreeOrphan,
} from "../../../../ipc/contract";

import { AppearanceSettings } from "@renderer/components/pages/appearance-settings";
import { CliSettings } from "@renderer/components/pages/cli-settings";
import { HarnessSettings } from "@renderer/components/pages/harness-settings";
import { ModelAccessSettings } from "@renderer/components/pages/model-access-settings";
import {
  SettingsRow,
  SettingsSection,
  SettingsShell,
  type SettingsCategory,
} from "@renderer/components/pages/settings-shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { Notice } from "@renderer/components/ui/notice";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { toastError } from "@renderer/lib/toast";

/**
 * App-wide preferences (the sidebar-footer gear overlay). Project-scoped
 * automation lives in the separate per-project Configure nav tab
 * (components/pages/configure-page.tsx); everything here applies across every
 * project. Grouped into categories via the shared {@link SettingsShell}.
 */
export function SettingsPage({
  initialCategoryKey,
  initialSignInProviderId,
}: { initialCategoryKey?: string; initialSignInProviderId?: string } = {}) {
  const categories: readonly SettingsCategory[] = [
    {
      key: "general",
      label: "General",
      icon: GearSixIcon,
      content: <GeneralSettings />,
    },
    {
      key: "appearance",
      label: "Appearance",
      icon: PaletteIcon,
      content: <AppearanceSettings />,
    },
    {
      // "Model Access" is the canonical name (VC-42): the docs, the code and
      // this pane say the same words. The key doubles as the chat blocker's
      // deep-link target — see stores/ui.ts `settingsCategory`.
      key: "model-access",
      label: "Model Access",
      icon: CpuIcon,
      content: <ModelAccessSettings autoSignInProviderId={initialSignInProviderId} />,
    },
    {
      key: "harness",
      label: "Harness Runtimes",
      icon: CpuIcon,
      content: <HarnessSettings />,
    },
    {
      key: "cli",
      label: "CLI",
      icon: TerminalWindowIcon,
      content: <CliSettings />,
    },
    {
      key: "worktrees",
      label: "Worktrees",
      icon: TreeStructureIcon,
      content: <WorktreesSettings />,
    },
  ];

  return (
    <SettingsShell
      title="Settings"
      categories={categories}
      initialCategoryKey={initialCategoryKey}
    />
  );
}

/** General category: app-wide retention (Done-ticket archiving). */
function GeneralSettings() {
  return (
    <SettingsSection title="Retention">
      <DoneTtlField />
    </SettingsSection>
  );
}

/**
 * The global Done-TTL: whole days ≥ 1, or `null` when the input is blank/invalid
 * (the field toasts and skips the write). Main clamps to ≥ 1 too — this is the
 * front-line guard so an obviously-bad value never round-trips. Pure/exported
 * for unit testing (the round-trip's only branching logic).
 */
export function parseTtlDaysInput(raw: string): number | null {
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * The global retention window (issue #76, CONCEPT #16; VC-113). It is now ONE
 * number governing three things that were always the same question — how long a
 * finished ticket's checkout is worth keeping:
 *  - a PR-less ticket this long in Done is offered for archive & clean;
 *  - its worktree FOLDER is reclaimed automatically once it has sat that long
 *    (branch, commits, ticket and PR url all kept);
 *  - a leftover orphan folder is only swept once nothing has touched it for the
 *    same window.
 * App-wide (stored in `app_state`, not per project). Loads once via
 * `getTtlDays`; saves via `setTtlDays` and reflects the clamped stored value.
 */
function DoneTtlField() {
  const [days, setDays] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.api.retention
      .getTtlDays()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setDays(String(result.days));
        else toastError(`Couldn't load the retention setting: ${result.error}`);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastError(`Couldn't load the retention setting: ${errorMessage(error)}`);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(): Promise<void> {
    if (saving) return;
    const parsed = parseTtlDaysInput(days);
    if (parsed === null) {
      toastError("Enter a whole number of days, at least 1.");
      return;
    }
    setSaving(true);
    try {
      const result = await window.api.retention.setTtlDays(parsed);
      if (!result.ok) {
        toastError(`Couldn't save the retention setting: ${result.error}`);
        return;
      }
      // Reflect the clamped, stored value main returns.
      setDays(String(result.days));
    } catch (error) {
      toastError(`Couldn't save the retention setting: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      label="Remove Done worktrees after"
      htmlFor="done-ttl-days"
      // Names what is taken and what survives, because the question this setting
      // has to answer (VC-113) is "will I lose my work?". Same verb as the
      // "Remove worktree" menu item: one name per act.
      description="Volli removes the folder and keeps the branch, its commits, and the ticket. It never touches a ticket with an open PR."
    >
      <Input
        id="done-ttl-days"
        type="number"
        min={1}
        value={days}
        placeholder="14"
        disabled={!loaded || saving}
        onChange={(event) => setDays(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
        }}
        className="w-24"
      />
      <span className="text-sm text-muted-foreground">days</span>
      <Button disabled={!loaded || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </SettingsRow>
  );
}

/**
 * Worktrees category: leftover-worktree cleanup. App-wide by construction —
 * `sweepOrphans` walks every project in the db, and its disk-vs-git pass reports
 * dirs git no longer attributes to any project at all, so this cannot be shown
 * per-project (see configure-page.tsx).
 */
function WorktreesSettings() {
  return <DirtyWorktreesList />;
}

type OrphansState =
  | { status: "loading" }
  | {
      status: "loaded";
      dirty: DirtyWorktreeOrphan[];
      removed: RemovedWorktreeOrphan[];
      kept: KeptWorktreeOrphan[];
    }
  /**
   * Carries its own reason: the pane reports the failure now, so nothing else
   * has to. `rescan` is the read that failed, so Retry can be exactly "do that
   * again" — retrying a failed refresh with the cached report would answer a
   * question the user didn't ask, and retrying the mount read with a rescan
   * would run the destructive sweep they didn't ask for either.
   */
  | { status: "error"; message: string; rescan: boolean };

/** Truncates a long path to `start…end`, keeping enough of both ends to stay identifiable. */
function truncateMiddle(value: string, max = 56): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

/** Reveal one orphan dir in Finder; failures toast (never silent). */
async function revealOrphan(path: string): Promise<void> {
  try {
    const result = await window.api.fs.revealInFinder(path);
    if (!result.ok) toastError(`Couldn't reveal in Finder: ${result.error}`);
  } catch (error) {
    toastError(`Couldn't reveal in Finder: ${errorMessage(error)}`);
  }
}

/**
 * The orphan list (§7 — dirty orphans are never auto-removed) with per-row
 * Reveal/Delete actions.
 *
 * Mount reads the CACHED launch report (`orphans()`); only the explicit refresh
 * button passes `rescan: true`. The sweep is destructive — it prunes git
 * metadata and removes clean orphan dirs — which is exactly why orphan-sweep.ts
 * caches it to once per launch. Rescanning on mount would re-run it every time
 * this category is entered, since SettingsShell unmounts the inactive pane.
 */
function DirtyWorktreesList() {
  const [state, setState] = useState<OrphansState>({ status: "loading" });
  const [pendingDelete, setPendingDelete] = useState<DirtyWorktreeOrphan | null>(null);
  const [deleting, setDeleting] = useState(false);

  // The read is re-entrant — mount, the refresh button, and a delete's re-sweep
  // all call it, and a slow first sweep can still be in flight when the second
  // starts. Token-guarded so the answer that lands is the one asked for last
  // (hooks/use-latest-async.ts), rather than whichever `orphans()` resolved last.
  const orphansFetch = useLatestAsync();
  const load = useCallback(
    async (rescan: boolean) => {
      const token = orphansFetch.claim();
      setState({ status: "loading" });
      try {
        const result = await window.api.worktree.orphans(rescan ? { rescan: true } : {});
        if (!orphansFetch.isCurrent(token)) return;
        if (!result.ok) {
          setState({ status: "error", message: result.error, rescan });
          return;
        }
        setState({
          status: "loaded",
          dirty: result.dirty,
          removed: result.removedClean,
          kept: result.keptRecent,
        });
      } catch (error) {
        if (orphansFetch.isCurrent(token))
          setState({ status: "error", message: errorMessage(error), rescan });
      }
    },
    [orphansFetch],
  );

  useEffect(() => {
    void load(false);
    return () => orphansFetch.invalidate();
  }, [load, orphansFetch]);

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      const result = await window.api.worktree.deleteOrphan(pendingDelete.path);
      if (!result.ok) {
        toastError(`Couldn't delete worktree: ${result.error}`);
        return;
      }
      setPendingDelete(null);
      // A delete invalidates the cached report, so this one re-sweeps.
      await load(true);
    } catch (error) {
      toastError(`Couldn't delete worktree: ${errorMessage(error)}`);
    } finally {
      setDeleting(false);
    }
  }

  const dirty = state.status === "loaded" ? state.dirty : [];
  const removed = state.status === "loaded" ? state.removed : [];
  const kept = state.status === "loaded" ? state.kept : [];

  const refreshAction = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Refresh orphaned worktrees"
      disabled={state.status === "loading"}
      onClick={() => void load(true)}
    >
      <ArrowsClockwiseIcon className={state.status === "loading" ? "animate-spin" : undefined} />
    </Button>
  );

  return (
    <SettingsSection
      title="Orphaned worktrees"
      description="Uncommitted work left behind by removed tickets. Never deleted automatically."
      action={refreshAction}
    >
      <div className="flex flex-col gap-1">
        {state.status === "loading" ? (
          <p className={EMPTY_INLINE}>Checking…</p>
        ) : state.status === "error" ? (
          // A read that FAILED and a read that found nothing are not the same
          // answer, and until this branch existed they drew the same pixels:
          // the pane said "No orphaned worktrees." — the one sentence that
          // makes leftover work safe to forget about — while the only sign
          // anything had gone wrong was a toast already halfway gone. The
          // recovery has to be here for the same reason: a failure whose Retry
          // lives in a dismissed toast is a failure with no way back.
          <Notice
            announce
            tone="error"
            icon={WarningIcon}
            title="Couldn't check orphaned worktrees"
            detail={state.message}
            actions={
              <Button size="xs" variant="outline" onClick={() => void load(state.rescan)}>
                <ArrowsClockwiseIcon />
                Retry
              </Button>
            }
          />
        ) : dirty.length === 0 ? (
          <p className={EMPTY_INLINE}>No orphaned worktrees.</p>
        ) : (
          dirty.map((orphan) => (
            <div
              key={orphan.path}
              className="flex items-center justify-between gap-4 rounded-md border border-border/50 bg-background/30 px-4 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-ui text-foreground" title={orphan.path}>
                  {truncateMiddle(orphan.path)}
                </p>
                <p className="mt-1 text-ui text-muted-foreground">{orphan.reason}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Reveal in Finder"
                  onClick={() => void revealOrphan(orphan.path)}
                >
                  <FolderOpenIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Delete worktree"
                  onClick={() => setPendingDelete(orphan)}
                >
                  <TrashIcon />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      {/*
       * What the sweep DID, not just what it left behind (VC-113). A launch
       * that quietly deleted 44 checkouts is indistinguishable from work going
       * missing unless the app says so somewhere, so both halves are stated:
       * what was taken (and the branch that survived it), and what is being
       * kept for now, with the date it stops being kept.
       */}
      {removed.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1">
          <p className="text-ui text-muted-foreground">
            Removed when Volli started. The branches are still in git.
          </p>
          {removed.map((entry) => (
            <div
              key={entry.path}
              className="rounded-md border border-border/50 bg-background/30 px-4 py-2"
            >
              <p className="truncate font-mono text-ui text-foreground" title={entry.path}>
                {truncateMiddle(entry.path)}
              </p>
              <p className="mt-1 text-ui text-muted-foreground">
                {entry.branch === null
                  ? "No branch was checked out here."
                  : `Branch ${entry.branch}`}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {kept.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1">
          <p className="text-ui text-muted-foreground">
            Kept for now. These have no uncommitted work, but something changed in them recently.
          </p>
          {kept.map((entry) => (
            <div
              key={entry.path}
              className="rounded-md border border-border/50 bg-background/30 px-4 py-2"
            >
              <p className="truncate font-mono text-ui text-foreground" title={entry.path}>
                {truncateMiddle(entry.path)}
              </p>
              <p className="mt-1 text-ui text-muted-foreground">
                {entry.removableAt === null
                  ? "Kept because Volli can't tell when this was last used."
                  : `Volli can remove this after ${new Date(entry.removableAt).toLocaleDateString()}.`}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes <span className="font-mono text-foreground">{pendingDelete?.path}</span> and
              the uncommitted work inside it. Can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
