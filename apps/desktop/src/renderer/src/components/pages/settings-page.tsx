import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { useCallback, useEffect, useState } from "react";
import {
  errorMessage,
  FIRST_CLASS_HARNESS_IDS,
  HARNESS_LABELS,
  type DirtyWorktreeOrphan,
} from "@volli/shared";

import { AppearanceSettings } from "@renderer/components/pages/appearance-settings";
import { RuntimeCatalogSettings } from "@renderer/components/pages/runtime-catalog-settings";
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
import { Input } from "@renderer/components/ui/input";
import { toastError } from "@renderer/lib/toast";

/**
 * App-wide preferences (the sidebar-footer gear overlay). Project-scoped
 * automation lives in the separate per-project Configure nav tab
 * (components/pages/configure-page.tsx); everything here applies across every
 * project. Grouped into categories via the shared {@link SettingsShell}.
 */
export function SettingsPage() {
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
      key: "harness",
      label: "Harness Runtimes",
      icon: CpuIcon,
      content: <HarnessRuntimesSettings />,
    },
    {
      key: "worktrees",
      label: "Worktrees",
      icon: TreeStructureIcon,
      content: <WorktreesSettings />,
    },
  ];

  return <SettingsShell title="Settings" categories={categories} />;
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
 * Global Done-TTL setting (issue #76, CONCEPT #16): a PR-less ticket sitting in
 * Done this many days is offered for archive & clean. App-wide (stored in
 * `app_state`, not per project), so it applies to every project regardless of
 * the current selection. Loads once via `getTtlDays`; saves via `setTtlDays`
 * and reflects the clamped stored value main returns.
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
      label="Archive Done tickets after"
      htmlFor="done-ttl-days"
      description="Only tickets with no open PR."
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
 * Harness Runtimes category — scaffold (CONCEPT: agent-agnostic command
 * templates). Lists the first-class harness ids read-only from the same
 * `@volli/shared` catalog the new-ticket composer sources; per-runtime
 * management (custom command templates, resume flags) lands later.
 */
function HarnessRuntimesSettings() {
  return (
    <>
      <RuntimeCatalogSettings />
      <SettingsSection title="Runtimes" icon={CpuIcon}>
        {FIRST_CLASS_HARNESS_IDS.map((id) => (
          <SettingsRow key={id} label={HARNESS_LABELS[id]}>
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              Built-in
            </span>
          </SettingsRow>
        ))}
      </SettingsSection>
    </>
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
  | { status: "loaded"; dirty: DirtyWorktreeOrphan[] }
  | { status: "error" };

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

  const load = useCallback(async (rescan: boolean) => {
    setState({ status: "loading" });
    try {
      const result = await window.api.worktree.orphans(rescan ? { rescan: true } : {});
      if (!result.ok) {
        toastError(`Couldn't check orphaned worktrees: ${result.error}`);
        setState({ status: "error" });
        return;
      }
      setState({ status: "loaded", dirty: result.dirty });
    } catch (error) {
      toastError(`Couldn't check orphaned worktrees: ${errorMessage(error)}`);
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

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
      <div className="flex flex-col gap-1.5">
        {state.status === "loading" ? (
          <p className="text-xs text-muted-foreground">Checking…</p>
        ) : dirty.length === 0 ? (
          <p className="text-xs text-muted-foreground">No orphaned worktrees.</p>
        ) : (
          dirty.map((orphan) => (
            <div
              key={orphan.path}
              className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-foreground" title={orphan.path}>
                  {truncateMiddle(orphan.path)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{orphan.reason}</p>
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
