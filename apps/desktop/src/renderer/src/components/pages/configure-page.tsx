import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { useEffect, useState } from "react";
import { type Project } from "@volli/shared";

import {
  SettingsRow,
  SettingsSection,
  SettingsShell,
  type SettingsCategory,
} from "@renderer/components/pages/settings-shell";
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
      description: "What gets copied from this project's root into every new ticket worktree.",
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
