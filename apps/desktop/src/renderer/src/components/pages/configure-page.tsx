import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { useEffect, useState } from "react";
import { type Project } from "@volli/shared";

import { ProjectAppearanceSettings } from "@renderer/components/pages/project-appearance-settings";
import {
  SettingsRow,
  SettingsSection,
  SettingsShell,
  type SettingsCategory,
} from "@renderer/components/pages/settings-shell";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
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
      <div className={cn("flex-1", EMPTY_PAGE)}>
        <div className="flex max-w-sm flex-col items-center">
          <div className="mb-4 flex items-center justify-center rounded-xl border border-border bg-card/70 p-2">
            <SlidersHorizontalIcon className="size-5 text-muted-foreground" />
          </div>
          <h1 className="text-heading font-semibold">Nothing to configure</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Select a project first.</p>
        </div>
      </div>
    );
  }

  const categories: readonly SettingsCategory[] = [
    {
      key: "general",
      label: "General",
      icon: GearSixIcon,
      content: (
        <ConfigureGeneralSection
          project={project}
          onSaveBaseBranch={updateBaseBranch}
          onSaveSetupCommand={updateSetupCommand}
        />
      ),
    },
    {
      key: "appearance",
      label: "Appearance",
      icon: PaletteIcon,
      description:
        "Theming for this project only. Every surface inherits the app-wide choice until you say otherwise.",
      content: <ProjectAppearanceSettings project={project} />,
    },
    {
      key: "worktrees",
      label: "Worktrees",
      icon: TreeStructureIcon,
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
      if (!ok) toastError("Couldn't save base branch");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      label="Default base branch"
      htmlFor="project-base-branch"
      description="New worktrees branch from here."
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
      if (!ok) toastError("Couldn't save setup command");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      label="Setup command"
      htmlFor="project-setup-command"
      description="Runs once, right after the worktree is created."
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

/**
 * Worktrees category: the per-project copy-set explainer. Orphan cleanup is NOT
 * here — `sweepOrphans` walks every project in the db, so its list (and its
 * permanent deletes) is app-wide and lives in Settings → Worktrees. Showing it
 * on this per-project page would let project A delete project B's dirty work.
 */
export function ConfigureWorktreesSection() {
  return <CopySetInfo />;
}

/** Read-only documentation of the default worktree copy set and how a repo-root `.worktreeinclude` extends it. */
function CopySetInfo() {
  return (
    <SettingsSection title="Copied files" icon={TreeStructureIcon}>
      <p className="text-ui leading-5 text-muted-foreground">
        By default: <code className="rounded-sm bg-muted px-1 py-1 font-mono">.env*</code> and{" "}
        <code className="rounded-sm bg-muted px-1 py-1 font-mono">.claude/settings.local.json</code>
        .
      </p>
      <p className="mt-2 text-ui leading-5 text-muted-foreground">
        Add a <code className="rounded-sm bg-muted px-1 py-1 font-mono">.worktreeinclude</code> at
        the repo root to change the set. Gitignore syntax;{" "}
        <code className="rounded-sm bg-muted px-1 py-1 font-mono">!</code> negates.
      </p>
    </SettingsSection>
  );
}
