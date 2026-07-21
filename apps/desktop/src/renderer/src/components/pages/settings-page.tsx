import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, type DirtyWorktreeOrphan, type Project } from "@volli/shared";

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
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { toastError } from "@renderer/lib/toast";
import { useProjectsStore } from "@renderer/stores/projects";

/** Global settings with the selected project's automation defaults. */
export function SettingsPage() {
  const project = useSelectedProject();
  const updateBaseBranch = useProjectsStore((state) => state.updateBaseBranch);
  const updateSetupCommand = useProjectsStore((state) => state.updateSetupCommand);
  return (
    <ProjectAutomationSettings
      project={project}
      onSave={(projectId, baseBranch) => updateBaseBranch(projectId, baseBranch)}
      onSaveSetupCommand={(projectId, setupCommand) => updateSetupCommand(projectId, setupCommand)}
    />
  );
}

export function ProjectAutomationSettings({
  project,
  onSave,
  onSaveSetupCommand,
}: {
  project: Project | null;
  onSave: (projectId: string, baseBranch: string | null) => Promise<boolean>;
  /** Omitted only by tests that don't exercise the setup-command field. */
  onSaveSetupCommand?: (projectId: string, setupCommand: string | null) => Promise<boolean>;
}) {
  const [baseBranch, setBaseBranch] = useState(project?.baseBranch ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBaseBranch(project?.baseBranch ?? "");
  }, [project?.id, project?.baseBranch]);

  async function save(): Promise<void> {
    if (!project || saving) return;
    setSaving(true);
    try {
      const ok = await onSave(project.id, baseBranch.trim() || null);
      if (!ok) toastError("Could not save base branch");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto px-8 py-7">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center gap-3">
          <GearSixIcon weight="fill" className="size-6 text-muted-foreground" />
          <div>
            <h1 className="text-heading font-semibold">Settings</h1>
            <p className="text-sm text-muted-foreground">Project automation defaults</p>
          </div>
        </div>

        <section className="mt-8 rounded-lg border border-border bg-card/50 p-5">
          <h2 className="text-sm font-semibold">{project?.name ?? "No project selected"}</h2>
          <label className="mt-5 block text-sm font-medium" htmlFor="project-base-branch">
            Default base branch
          </label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            New ticket worktrees branch from this ref unless the CLI supplies --base.
          </p>
          <div className="mt-3 flex max-w-md gap-2">
            <Input
              id="project-base-branch"
              value={baseBranch}
              placeholder="main"
              disabled={!project || saving}
              onChange={(event) => setBaseBranch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
            />
            <Button disabled={!project || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </section>

        <section className="mt-6 rounded-lg border border-border bg-card/50 p-5">
          <div className="flex items-center gap-2">
            <TreeStructureIcon weight="fill" className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Worktrees</h2>
          </div>

          <SetupCommandField project={project} onSave={onSaveSetupCommand} />
          <DoneTtlField />
          <CopySetInfo />
          <DirtyWorktreesList />
        </section>
      </div>
    </div>
  );
}

/** Per-project setup command, run once in the session terminal right after a ticket's worktree is created. */
function SetupCommandField({
  project,
  onSave,
}: {
  project: Project | null;
  onSave?: (projectId: string, setupCommand: string | null) => Promise<boolean>;
}) {
  const [setupCommand, setSetupCommand] = useState(project?.setupCommand ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSetupCommand(project?.setupCommand ?? "");
  }, [project?.id, project?.setupCommand]);

  async function save(): Promise<void> {
    if (!project || saving || !onSave) return;
    setSaving(true);
    try {
      const ok = await onSave(project.id, setupCommand.trim() || null);
      if (!ok) toastError("Could not save setup command");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-5">
      <label className="block text-sm font-medium" htmlFor="project-setup-command">
        Setup command
      </label>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Runs once in the session terminal right after a ticket's worktree is created.
      </p>
      <div className="mt-3 flex max-w-md gap-2">
        <Input
          id="project-setup-command"
          value={setupCommand}
          placeholder="pnpm install"
          disabled={!project || saving}
          onChange={(event) => setSetupCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
          }}
        />
        <Button disabled={!project || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
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
 * `app_state`, not per project), so it's always enabled regardless of the
 * selected project. Loads once via `getTtlDays`; saves via `setTtlDays` and
 * reflects the clamped stored value main returns.
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
    <div className="mt-5">
      <label className="block text-sm font-medium" htmlFor="done-ttl-days">
        Archive Done tickets after
      </label>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        A ticket left in Done this many days with no open PR is offered for archive &amp; clean.
        Defaults to 14 days.
      </p>
      <div className="mt-3 flex max-w-md items-center gap-2">
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
      </div>
    </div>
  );
}

/** Read-only documentation of the default worktree copy set and how a repo-root `.worktreeinclude` extends it. */
function CopySetInfo() {
  return (
    <div className="mt-5 rounded-md border border-border/60 bg-background/40 p-3">
      <p className="text-xs font-medium text-foreground">What gets copied into new worktrees</p>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        By default, <code className="rounded bg-muted px-1 py-0.5 font-mono">.env*</code> and{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">.claude/settings.local.json</code>{" "}
        are copied from the project root into every new ticket worktree.
      </p>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        A repo-root <code className="rounded bg-muted px-1 py-0.5 font-mono">.worktreeinclude</code>{" "}
        file (gitignore syntax — <code className="rounded bg-muted px-1 py-0.5 font-mono">!</code>{" "}
        negates) extends or overrides this set.
      </p>
    </div>
  );
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
 * On-demand orphan sweep (§7 — dirty orphans are never auto-removed) with
 * per-row Reveal/Delete actions. Fetches on mount — the section only mounts
 * when Settings is shown, so this is already "lazy" without extra gating.
 */
function DirtyWorktreesList() {
  const [state, setState] = useState<OrphansState>({ status: "loading" });
  const [pendingDelete, setPendingDelete] = useState<DirtyWorktreeOrphan | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const result = await window.api.worktree.orphans({ rescan: true });
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
    void refresh();
  }, [refresh]);

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
      await refresh();
    } catch (error) {
      toastError(`Could not delete worktree: ${errorMessage(error)}`);
    } finally {
      setDeleting(false);
    }
  }

  const dirty = state.status === "loaded" ? state.dirty : [];

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Orphaned worktrees</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Worktree folders with uncommitted work left over from a removed ticket — never deleted
            automatically.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh orphaned worktrees"
          disabled={state.status === "loading"}
          onClick={() => void refresh()}
        >
          <ArrowsClockwiseIcon
            className={state.status === "loading" ? "animate-spin" : undefined}
          />
        </Button>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
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
    </div>
  );
}
