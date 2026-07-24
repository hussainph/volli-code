import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, type DirtyWorktreeOrphan, type Project } from "@volli/shared";

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
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { toastError } from "@renderer/lib/toast";
import { useProjectsStore } from "@renderer/stores/projects";

/**
 * Per-project configuration ("Configure" nav tab): the selected project's
 * worktree automation defaults and worktree maintenance, grouped into
 * categories via the shared {@link SettingsShell}. App-wide preferences live in
 * the separate Settings overlay (components/pages/settings-page.tsx).
 */
export function ConfigurePage() {
  const project = useSelectedProject();
  const updateBaseBranch = useProjectsStore((state) => state.updateBaseBranch);
  const updateSetupCommand = useProjectsStore((state) => state.updateSetupCommand);

  if (project === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex max-w-sm flex-col items-center text-center">
          <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-border bg-card/70">
            <SlidersHorizontalIcon className="size-5 text-muted-foreground" weight="fill" />
          </div>
          <h1 className="text-heading font-semibold">Nothing to configure</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Select a project to edit its worktree defaults and maintenance.
          </p>
        </div>
      </div>
    );
  }

  const categories: readonly SettingsCategory[] = [
    {
      key: "general",
      label: "General",
      icon: GearSixIcon,
      description: "Automation defaults for new ticket worktrees in this project.",
      content: (
        <ConfigureGeneralSection
          project={project}
          onSaveBaseBranch={updateBaseBranch}
          onSaveSetupCommand={updateSetupCommand}
        />
      ),
    },
    {
      key: "worktrees",
      label: "Worktrees",
      icon: TreeStructureIcon,
      description: "What gets copied into worktrees, and leftover worktree cleanup.",
      content: <ConfigureWorktreesSection />,
    },
  ];

  return <SettingsShell title="Configure" categories={categories} />;
}

/** General category: the project's base-branch and setup-command automation defaults. */
export function ConfigureGeneralSection({
  project,
  onSaveBaseBranch,
  onSaveSetupCommand,
}: {
  project: Project | null;
  onSaveBaseBranch: (projectId: string, baseBranch: string | null) => Promise<boolean>;
  onSaveSetupCommand: (projectId: string, setupCommand: string | null) => Promise<boolean>;
}) {
  return (
    <SettingsSection title={project?.name ?? "No project selected"}>
      <BaseBranchField project={project} onSave={onSaveBaseBranch} />
      <SetupCommandField project={project} onSave={onSaveSetupCommand} />
    </SettingsSection>
  );
}

/** Per-project default base branch: new ticket worktrees branch from this ref unless the CLI supplies `--base`. */
function BaseBranchField({
  project,
  onSave,
}: {
  project: Project | null;
  onSave: (projectId: string, baseBranch: string | null) => Promise<boolean>;
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
    <SettingsRow
      label="Default base branch"
      htmlFor="project-base-branch"
      description="New ticket worktrees branch from this ref unless the CLI supplies --base."
    >
      <Input
        id="project-base-branch"
        className="w-48"
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
    </SettingsRow>
  );
}

/** Per-project setup command, run once in the session terminal right after a ticket's worktree is created. */
function SetupCommandField({
  project,
  onSave,
}: {
  project: Project | null;
  onSave: (projectId: string, setupCommand: string | null) => Promise<boolean>;
}) {
  const [setupCommand, setSetupCommand] = useState(project?.setupCommand ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSetupCommand(project?.setupCommand ?? "");
  }, [project?.id, project?.setupCommand]);

  async function save(): Promise<void> {
    if (!project || saving) return;
    setSaving(true);
    try {
      const ok = await onSave(project.id, setupCommand.trim() || null);
      if (!ok) toastError("Could not save setup command");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      label="Setup command"
      htmlFor="project-setup-command"
      description="Runs once in the session terminal right after a ticket's worktree is created."
    >
      <Input
        id="project-setup-command"
        className="w-56"
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
    </SettingsRow>
  );
}

/** Worktrees category: the copy-set explainer plus on-demand orphan cleanup. */
export function ConfigureWorktreesSection() {
  return (
    <>
      <CopySetInfo />
      <DirtyWorktreesList />
    </>
  );
}

/** Read-only documentation of the default worktree copy set and how a repo-root `.worktreeinclude` extends it. */
function CopySetInfo() {
  return (
    <SettingsSection
      title="Copied files"
      icon={TreeStructureIcon}
      description="What gets copied from the project root into every new ticket worktree."
    >
      <p className="text-xs leading-5 text-muted-foreground">
        By default, <code className="rounded bg-muted px-1 py-0.5 font-mono">.env*</code> and{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">.claude/settings.local.json</code>{" "}
        are copied from the project root into every new ticket worktree.
      </p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        A repo-root <code className="rounded bg-muted px-1 py-0.5 font-mono">.worktreeinclude</code>{" "}
        file (gitignore syntax — <code className="rounded bg-muted px-1 py-0.5 font-mono">!</code>{" "}
        negates) extends or overrides this set.
      </p>
    </SettingsSection>
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
 * per-row Reveal/Delete actions. Fetches on mount — the Worktrees category only
 * mounts when it's the active pane, so this is already "lazy" without extra
 * gating.
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

  const refreshAction = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Refresh orphaned worktrees"
      disabled={state.status === "loading"}
      onClick={() => void refresh()}
    >
      <ArrowsClockwiseIcon className={state.status === "loading" ? "animate-spin" : undefined} />
    </Button>
  );

  return (
    <SettingsSection
      title="Orphaned worktrees"
      description="Worktree folders with uncommitted work left over from a removed ticket — never deleted automatically."
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
