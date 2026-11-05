import * as React from "react";
import { UndoIcon, SettingsIcon } from "@renderer/components/ui/icon";

import type { Project } from "@volli/shared";
import { ModelName } from "@renderer/components/models/model-identity";
import { useModelCatalogue } from "@renderer/lib/use-model-catalogue";
import { boardApi } from "@renderer/lib/board-api";
import { useThemeStore } from "@renderer/stores/theme";
import { useProjectsStore } from "@renderer/stores/projects";
import { writeThrough } from "@renderer/stores/mutate";
import { Button } from "@renderer/components/ui/button";
import { Cell, DataTable, PrefSection } from "../kit";
import { SettingsNavigation } from "../settings-navigation";

type OverrideKey = "sessionModel" | "decisionModel" | "themeAppearance" | "themeCanvas";
export function projectOverrides(project: Project) {
  return (
    [
      { key: "sessionModel", label: "Chat model", page: "sessions" },
      { key: "decisionModel", label: "Decision model", page: "sessions" },
      { key: "themeAppearance", label: "Mode", page: "appearance" },
      { key: "themeCanvas", label: "Canvas", page: "appearance" },
    ] as const
  ).filter((row) => project[row.key] != null);
}
export function OverviewPane({ project }: { project: Project }) {
  const navigation = React.useContext(SettingsNavigation);
  const [busy, setBusy] = React.useState<OverrideKey | null>(null);
  const catalogue = useModelCatalogue();
  async function reset(key: OverrideKey) {
    if (busy) return;
    setBusy(key);
    try {
      if (key === "themeCanvas") await useThemeStore.getState().setProjectCanvas(project.id, null);
      else if (key === "themeAppearance")
        await useThemeStore.getState().setProjectAppearance(project.id, null);
      else if (key === "sessionModel") {
        const result = await writeThrough("reset the project's chat model", () =>
          boardApi().projects.setSessionDefaults({ id: project.id, model: null }),
        );
        if (result) useProjectsStore.getState().adoptProject(result.project);
      } else {
        const result = await writeThrough("reset the project's decision model", () =>
          window.api.decisionModel.set({ scope: "project", projectId: project.id }, null),
        );
        if (result?.ok && result.project) useProjectsStore.getState().adoptProject(result.project);
      }
    } finally {
      setBusy(null);
    }
  }
  const value = (key: OverrideKey) => {
    if (key === "themeAppearance")
      return project.themeAppearance === "auto"
        ? "System"
        : project.themeAppearance === "light"
          ? "Light"
          : "Dark";
    if (key === "themeCanvas")
      return (
        <span className="flex gap-1">
          {project.themeCanvas?.stops.map((stop, i) => (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- Persisted canvas stops have slot identities, not record ids.
              key={`${i}/${stop.hex}`}
              aria-label={stop.hex}
              style={{ background: stop.hex }}
              className="size-4 rounded-control border border-border-strong"
            />
          ))}
        </span>
      );
    if (key === "decisionModel")
      return project.decisionModel?.kind === "none"
        ? "Off"
        : project.decisionModel?.kind === "local"
          ? "Local model"
          : "Cloud model";
    const selection = project.sessionModel;
    if (!selection) return "Global default";
    const model = catalogue?.models.find(
      (m) => m.modelId === selection.modelId && m.providerId === selection.providerId,
    ) ?? { ...selection, label: selection.modelId };
    return (
      <ModelName model={model} models={catalogue?.models ?? []} providers={catalogue?.providers} />
    );
  };
  return (
    <PrefSection title="Global overrides" icon={SettingsIcon}>
      <DataTable
        label="Project overrides"
        items={projectOverrides(project)}
        keyOf={(row) => row.key}
        rows={5}
        empty="No project overrides"
        columns={[
          {
            key: "setting",
            header: "Setting",
            cell: (row) => (
              <Button
                variant="link"
                size="sm"
                onClick={() => navigation?.openProject(project.id, row.page)}
              >
                {row.label}
              </Button>
            ),
          },
          { key: "value", header: "Value", cell: (row) => <Cell>{value(row.key)}</Cell> },
          {
            key: "reset",
            header: "Reset",
            width: "5rem",
            cell: (row) => (
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy !== null}
                aria-label={`Reset ${row.label}`}
                title="Reset to global default"
                onClick={() => void reset(row.key)}
              >
                <UndoIcon />
              </Button>
            ),
          },
        ]}
      />
    </PrefSection>
  );
}
