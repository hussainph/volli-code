/**
 * Configure → Sessions: the Chat defaults and instructions a project owns.
 *
 * The Model row is an `OverrideControl`: this page already establishes project
 * scope, and the reset affordance is the visible signal that the row differs
 * from the app-wide value. `null` means inherit; there is no second mode.
 *
 * Terminals are manual companions that start as bare shells. They therefore do
 * not offer a Project harness setting: a setting that names a harness but does
 * not launch one would be inert.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import type { ModelAccessModel, ModelAccessProvider, ModelSelection, Project } from "@volli/shared";

import {
  offerableModels,
  preferredReasoning,
  providerLabelFor,
} from "@renderer/components/pages/model-access-settings";
import {
  CONTROL_W,
  ItemRow,
  OverrideControl,
  PrefRow,
  PrefSection,
  SectionAction,
} from "@renderer/components/settings/kit";
import { MODELS_CATEGORY_KEY } from "@renderer/components/settings/settings-groups";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { writeThrough } from "@renderer/stores/mutate";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

const NO_MODELS: readonly ModelAccessModel[] = [];
const NO_PROVIDERS: readonly ModelAccessProvider[] = [];

type ModelCatalogStatus = "loading" | "ready" | "error" | "unavailable";

export function SessionsPane({ project }: { project: Project }) {
  const modelAccess = useModelAccessClient();
  const inspect = modelAccess?.inspect;
  const adoptProject = useProjectsStore((store) => store.adoptProject);
  const setSettingsOpen = useUiStore((store) => store.setSettingsOpen);
  const [saving, setSaving] = React.useState(false);
  const [availableModels, setAvailableModels] =
    React.useState<readonly ModelAccessModel[]>(NO_MODELS);
  const [providers, setProviders] = React.useState<readonly ModelAccessProvider[]>(NO_PROVIDERS);
  const [modelCatalogStatus, setModelCatalogStatus] = React.useState<ModelCatalogStatus>("loading");
  const [catalogAttempt, setCatalogAttempt] = React.useState(0);

  const model = project.sessionModel ?? null;

  React.useEffect(() => {
    let current = true;
    if (inspect === undefined) {
      setAvailableModels(NO_MODELS);
      setProviders(NO_PROVIDERS);
      setModelCatalogStatus("unavailable");
      return () => {
        current = false;
      };
    }
    setModelCatalogStatus("loading");
    void inspect({ refresh: catalogAttempt > 0 })
      .then((snapshot) => {
        if (!current) return;
        // Pi names every provider it knows. This picker names only models this
        // profile can run; a stored model outside this set therefore reads as
        // unset below, just as it does in Settings → Models.
        setAvailableModels(offerableModels(snapshot.models));
        setProviders(snapshot.providers);
        setModelCatalogStatus("ready");
      })
      .catch(() => {
        if (!current) return;
        setAvailableModels(NO_MODELS);
        setProviders(NO_PROVIDERS);
        setModelCatalogStatus("error");
      });
    return () => {
      current = false;
    };
  }, [catalogAttempt, inspect]);

  const selectedModel =
    model === null
      ? null
      : (availableModels.find(
          (candidate) =>
            candidate.providerId === model.providerId && candidate.modelId === model.modelId,
        ) ?? null);
  const modelValue = selectedModel === null ? "" : modelKey(selectedModel);
  const reasoningValue =
    model !== null && selectedModel?.reasoningLevels.includes(model.reasoningLevel)
      ? model.reasoningLevel
      : "";
  const hasOfferableModels = modelCatalogStatus === "ready" && availableModels.length > 0;
  const modelCatalogAction =
    modelCatalogStatus === "error" ? (
      <SectionAction label="Try again" onAct={() => setCatalogAttempt((attempt) => attempt + 1)} />
    ) : modelCatalogStatus === "ready" && availableModels.length === 0 ? (
      <SectionAction
        label="Manage models"
        onAct={() => setSettingsOpen(true, MODELS_CATEGORY_KEY)}
      />
    ) : undefined;

  async function save(selection: ModelSelection | null): Promise<void> {
    if (saving) return;
    setSaving(true);
    const saved = await writeThrough("save this project's Chat default", () =>
      window.api.projects.setSessionDefaults({ id: project.id, model: selection }),
    );
    setSaving(false);
    if (saved !== null) adoptProject(saved.project);
  }

  return (
    <>
      <PrefSection
        title="Chat"
        icon={CpuIcon}
        // The precedence table, as one hint rather than a paragraph under the
        // header — available to whoever wants it, invisible to everyone else.
        hint={
          <>New chats use the composer&rsquo;s choice first, then this project, then Settings.</>
        }
        action={modelCatalogAction}
      >
        {/*
         * An override no longer named by the offerable catalogue is shown as
         * inherited. The reset button remains the one, honest signal that the
         * stored project value still differs from Settings → Models.
         */}
        <PrefRow
          label="Model"
          htmlFor="project-session-model"
          align="start"
          testId="project-session-model"
        >
          <OverrideControl
            label="Model"
            inheritedValue="the app-wide default"
            overridden={model !== null}
            onRevert={() => void save(null)}
          >
            {/*
             * At the app's narrow window floor, the two rails leave no room
             * for both controls beside the label. Stack this one compound
             * value rather than clip its provider identity or the reset.
             */}
            <div className="flex flex-col items-end gap-2 xl:flex-row xl:items-center">
              <Select
                value={modelValue}
                disabled={saving || !hasOfferableModels}
                onValueChange={(key) => {
                  const nextModel = availableModels.find(
                    (candidate) => modelKey(candidate) === key,
                  );
                  if (nextModel === undefined) return;
                  void save({
                    providerId: nextModel.providerId,
                    modelId: nextModel.modelId,
                    reasoningLevel: preferredReasoning(nextModel, model?.reasoningLevel),
                  });
                }}
              >
                <SelectTrigger id="project-session-model" className={CONTROL_W.lg}>
                  <SelectValue
                    placeholder={modelPickerPlaceholder(modelCatalogStatus, availableModels.length)}
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((availableModel) => (
                    <SelectItem key={modelKey(availableModel)} value={modelKey(availableModel)}>
                      {availableModel.label} ·{" "}
                      {providerLabelFor(providers, availableModel.providerId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={reasoningValue}
                disabled={saving || !hasOfferableModels || selectedModel === null}
                onValueChange={(next) => {
                  if (model === null || selectedModel === null) return;
                  const reasoningLevel = selectedModel.reasoningLevels.find(
                    (level) => level === next,
                  );
                  if (reasoningLevel === undefined) return;
                  void save({ ...model, reasoningLevel });
                }}
              >
                <SelectTrigger className={CONTROL_W.sm} aria-label="Reasoning level">
                  <SelectValue placeholder="Level" />
                </SelectTrigger>
                <SelectContent>
                  {(selectedModel?.reasoningLevels ?? []).map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </OverrideControl>
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Instructions"
        icon={BookOpenIcon}
        hint={<>Volli reads these files before each session&rsquo;s first turn.</>}
        action={
          <SectionAction
            label="Reveal"
            icon={ArrowSquareOutIcon}
            onAct={() => void reveal(`${project.path}/AGENTS.md`)}
          />
        }
      >
        <ItemRow name="AGENTS.md" meta="repo root" />
        <ItemRow name="CLAUDE.md" meta="repo root" />
      </PrefSection>
    </>
  );
}

function modelPickerPlaceholder(status: ModelCatalogStatus, modelCount: number): string {
  if (status === "loading") return "Loading models…";
  if (status === "error") return "Couldn't load models";
  if (status === "unavailable") return "Model Access unavailable";
  return modelCount === 0 ? "No signed-in models" : "From Settings → Models";
}

function modelKey(model: Pick<ModelAccessModel, "providerId" | "modelId">): string {
  return JSON.stringify([model.providerId, model.modelId]);
}

async function reveal(path: string): Promise<void> {
  await writeThrough("reveal the file", () => window.api.fs.revealInFinder(path));
}
