import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { useEffect, useState } from "react";
import type { Project } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useProjectsStore } from "@renderer/stores/projects";

/** Global settings with the selected project's automation defaults. */
export function SettingsPage() {
  const project = useSelectedProject();
  const updateBaseBranch = useProjectsStore((state) => state.updateBaseBranch);
  return (
    <ProjectAutomationSettings
      project={project}
      onSave={(projectId, baseBranch) => updateBaseBranch(projectId, baseBranch)}
    />
  );
}

export function ProjectAutomationSettings({
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
      await onSave(project.id, baseBranch.trim() || null);
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
      </div>
    </div>
  );
}
