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
  HARNESS_IDS,
  HARNESS_LABELS,
  type DirtyWorktreeOrphan,
  type GhosttyTerminalPrefs,
} from "@volli/shared";

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
      description: "Preferences that apply across every project.",
      content: <GeneralSettings />,
    },
    {
      key: "appearance",
      label: "Appearance",
      icon: PaletteIcon,
      description: "Terminal appearance, driven by your external Ghostty configuration.",
      content: <AppearanceSettings />,
    },
    {
      key: "harness",
      label: "Harness Runtimes",
      icon: CpuIcon,
      description: "CLI agent runtimes that boot a ticket's coding agent.",
      content: <HarnessRuntimesSettings />,
    },
    {
      key: "worktrees",
      label: "Worktrees",
      icon: TreeStructureIcon,
      description: "Leftover worktree folders, across every project.",
      content: <WorktreesSettings />,
    },
  ];

  return <SettingsShell title="Settings" categories={categories} />;
}

/** General category: app-wide retention (Done-ticket archiving). */
function GeneralSettings() {
  return (
    <SettingsSection title="Retention" description="Applies to tickets in every project.">
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
        else toastError(`Could not load the Done TTL: ${result.error}`);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastError(`Could not load the Done TTL: ${errorMessage(error)}`);
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
      toastError("The Done TTL must be a whole number of days, at least 1.");
      return;
    }
    setSaving(true);
    try {
      const result = await window.api.retention.setTtlDays(parsed);
      if (!result.ok) {
        toastError(`Could not save the Done TTL: ${result.error}`);
        return;
      }
      // Reflect the clamped, stored value main returns.
      setDays(String(result.days));
    } catch (error) {
      toastError(`Could not save the Done TTL: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      label="Archive Done tickets after"
      htmlFor="done-ttl-days"
      description="A ticket left in Done this many days with no open PR is offered for archive & clean, in every project. Defaults to 14 days."
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

type AppearanceState =
  | { status: "loading" }
  | { status: "ready"; prefs: GhosttyTerminalPrefs; hasConfig: boolean }
  | { status: "error"; error: string };

const APPEARANCE_EXPLAINER =
  "Terminal appearance is read from your external Ghostty config file (CONCEPT decision #27) — edit it there and Volli picks up the change live. These values are read-only here.";

/**
 * Appearance category: a read-only view of the terminal appearance Volli
 * resolves from the user's Ghostty config (decision #27 — the external config
 * is the single source of truth, there is no in-app editor). Best-effort: a
 * missing or unreadable config is normal (Ghostty need not be installed), so it
 * falls back to an explanatory panel rather than surfacing a failed-mutation
 * toast — nothing here writes.
 */
function AppearanceSettings() {
  const [state, setState] = useState<AppearanceState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void window.api.terminal
      .ghosttyConfig()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setState({
            status: "ready",
            prefs: result.value.prefs,
            hasConfig: result.value.configText !== null,
          });
        } else {
          setState({ status: "error", error: result.error });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: "error", error: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "error") {
    return (
      <SettingsSection
        title="Terminal appearance"
        icon={PaletteIcon}
        description={APPEARANCE_EXPLAINER}
      >
        <p className="text-xs leading-5 text-muted-foreground">
          Could not read your Ghostty config ({state.error}). Volli falls back to its built-in
          terminal appearance.
        </p>
      </SettingsSection>
    );
  }

  if (state.status === "loading") {
    return (
      <SettingsSection
        title="Terminal appearance"
        icon={PaletteIcon}
        description={APPEARANCE_EXPLAINER}
      >
        <p className="text-xs text-muted-foreground">Reading Ghostty config…</p>
      </SettingsSection>
    );
  }

  const { prefs, hasConfig } = state;
  return (
    <SettingsSection
      title="Terminal appearance"
      icon={PaletteIcon}
      description={APPEARANCE_EXPLAINER}
    >
      {!hasConfig ? (
        <p className="mb-1 text-xs leading-5 text-muted-foreground">
          No Ghostty config file found — Volli uses its built-in terminal defaults.
        </p>
      ) : null}
      <AppearanceValueRow label="Theme" value={prefs.themeName} />
      <AppearanceValueRow label="Font family" value={prefs.fontFamilies[0] ?? null} />
      <AppearanceValueRow
        label="Font size"
        value={prefs.fontSize !== null ? `${prefs.fontSize} pt` : null}
      />
    </SettingsSection>
  );
}

/** One read-only Ghostty appearance value; falls back to the built-in default when unset. */
function AppearanceValueRow({ label, value }: { label: string; value: string | null }) {
  return (
    <SettingsRow label={label}>
      {value !== null ? (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
          {value}
        </code>
      ) : (
        <span className="text-xs text-muted-foreground">Built-in default</span>
      )}
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
    <SettingsSection
      title="CLI agent runtimes"
      icon={CpuIcon}
      description="Manage CLI agent runtimes (Claude Code · Codex · Opencode · custom) — coming soon."
    >
      {HARNESS_IDS.map((id) => (
        <SettingsRow key={id} label={HARNESS_LABELS[id]}>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            Built-in
          </span>
        </SettingsRow>
      ))}
    </SettingsSection>
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
    if (!result.ok) toastError(`Could not reveal in Finder: ${result.error}`);
  } catch (error) {
    toastError(`Could not reveal in Finder: ${errorMessage(error)}`);
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
        toastError(`Could not check orphaned worktrees: ${result.error}`);
        setState({ status: "error" });
        return;
      }
      setState({ status: "loaded", dirty: result.dirty });
    } catch (error) {
      toastError(`Could not check orphaned worktrees: ${errorMessage(error)}`);
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
        toastError(`Could not delete worktree: ${result.error}`);
        return;
      }
      setPendingDelete(null);
      // A delete invalidates the cached report, so this one re-sweeps.
      await load(true);
    } catch (error) {
      toastError(`Could not delete worktree: ${errorMessage(error)}`);
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
      description="Worktree folders with uncommitted work left over from a removed ticket, in any project — never deleted automatically."
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
              This permanently deletes{" "}
              <span className="font-mono text-foreground">{pendingDelete?.path}</span> and any
              uncommitted work inside it. This can't be undone.
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
