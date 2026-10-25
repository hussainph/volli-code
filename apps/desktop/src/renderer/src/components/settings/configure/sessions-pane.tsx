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
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import {
  errorMessage,
  type ModelAccessModel,
  type ModelAccessProvider,
  type ModelSelection,
  type Project,
} from "@volli/shared";

import { ProjectDecisionModelRow } from "@renderer/components/pages/decision-model-settings";
import {
  availableModelsByProvider,
  offerableModels,
  preferredReasoning,
} from "@renderer/components/pages/model-access-settings";
import {
  AsyncSection,
  CONTROL_W,
  ItemRow,
  OverrideControl,
  PrefRow,
  PrefSection,
  RowAction,
  SectionAction,
  SectionIconAction,
  type AsyncState,
} from "@renderer/components/settings/kit";
import { MODELS_CATEGORY_KEY } from "@renderer/components/settings/settings-groups";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { ModelName } from "@renderer/components/models/model-identity";
import { writeThrough } from "@renderer/stores/mutate";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { boardApi } from "@renderer/lib/board-api";
import { useLatestAsync, type LatestAsyncGuard } from "@renderer/hooks/use-latest-async";

import { ContentPreviewDialog, type PreviewState } from "./content-preview-dialog";
import {
  instructionFiles,
  type InstructionFile,
  type InstructionFileName,
} from "./instruction-files";

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
  // The attempt already spent. Only the effect run that sees a new number is
  // a retry, and a retry forces a refresh; the run the refresh's own shared-
  // revision bump causes must read the refreshed catalog instead of forcing
  // another refresh, or every Try again would refresh forever.
  const spentAttempt = React.useRef(0);

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
    const refresh = catalogAttempt > spentAttempt.current;
    spentAttempt.current = catalogAttempt;
    setModelCatalogStatus("loading");
    void inspect({ refresh })
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
      boardApi().projects.setSessionDefaults({ id: project.id, model: selection }),
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
                  {availableModelsByProvider(availableModels, providers).map((group) => (
                    <SelectGroup key={group.providerId}>
                      <SelectLabel>{group.providerLabel}</SelectLabel>
                      {group.models.map((availableModel) => (
                        <SelectItem key={modelKey(availableModel)} value={modelKey(availableModel)}>
                          <ModelName
                            model={availableModel}
                            models={availableModels}
                            providers={providers}
                          />
                        </SelectItem>
                      ))}
                    </SelectGroup>
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
        <ProjectDecisionModelRow project={project} onSaved={adoptProject} />
      </PrefSection>

      <InstructionsSection project={project} />
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

/**
 * The repo-root instruction files this project actually has (VC-305).
 *
 * Each row is derived from the root's listing — a file, a symlink, or not in
 * this repo — and only what can actually be read is offered: a file gets
 * Preview and Reveal, a symlink Reveal alone (file reads refuse symlinks), a
 * missing one nothing. No row is marked as the loaded one; see
 * `instruction-files.ts` for who reads which.
 *
 * Inspection only. Nothing here writes, so a read-only (remote) project shows
 * the same rows with the same read actions.
 */
function InstructionsSection({ project }: { project: Project }) {
  const [listing, setListing] = React.useState<FileListing>(LOADING);
  const [previewing, setPreviewing] = React.useState<InstructionFileName | null>(null);
  const [body, setBody] = React.useState<PreviewState>(LOADING);
  const listGuard = useLatestAsync();
  const bodyGuard = useLatestAsync();

  const check = React.useCallback(async (): Promise<void> => {
    const failed = (message: string) => ({
      status: "error" as const,
      message,
      onRetry: () => void check(),
    });
    await settleLatest(listGuard, setListing, failed, async (): Promise<FileListing> => {
      const result = await window.api.fs.listDirectory(project.path);
      return result.ok
        ? { status: "ready", data: instructionFiles(result.entries) }
        : failed(result.error);
    });
  }, [project.path, listGuard]);

  React.useEffect(() => {
    void check();
    return () => listGuard.invalidate();
  }, [check, listGuard]);

  const read = React.useCallback(
    async (name: InstructionFileName): Promise<void> => {
      const failed = (message: string) => ({
        status: "error" as const,
        message,
        onRetry: () => void read(name),
      });
      await settleLatest(bodyGuard, setBody, failed, async (): Promise<PreviewState> => {
        const result = await window.api.files.read({ projectId: project.id, relPath: name });
        if (!result.ok) return failed(result.error);
        if (result.content.type !== "text") {
          return { status: "unavailable", message: `${name} is not a text file.` };
        }
        const { text, truncated } = result.content;
        return { status: "ready", data: { text, truncated } };
      });
    },
    [project.id, bodyGuard],
  );

  React.useEffect(() => () => bodyGuard.invalidate(), [bodyGuard]);

  function preview(name: InstructionFileName): void {
    setPreviewing(name);
    void read(name);
  }

  return (
    <>
      <AsyncSection
        title="Instructions"
        icon={BookOpenIcon}
        hint={
          <>
            Chats read whichever of these the repo has when the work calls for it; Volli
            doesn&rsquo;t add them to the prompt. Terminal harnesses load their own: Claude Code
            reads CLAUDE.md, Codex, Cursor and OpenCode read AGENTS.md.
          </>
        }
        action={
          <SectionIconAction
            label="Check the repo again"
            busy={listing.status === "loading"}
            onAct={() => void check()}
          />
        }
        state={listing}
      >
        {(files) =>
          files.map((file) => (
            <ItemRow
              key={file.name}
              name={file.name}
              meta={INSTRUCTION_META[file.state]}
              testId={`instruction-file-${file.name}`}
            >
              {file.state === "file" ? (
                <RowAction
                  label={`Preview ${file.name}`}
                  hint="Preview"
                  icon={EyeIcon}
                  onAct={() => preview(file.name)}
                />
              ) : null}
              {file.state === "missing" ? null : (
                <RowAction
                  label={`Reveal ${file.name} in Finder`}
                  hint="Reveal in Finder"
                  icon={ArrowSquareOutIcon}
                  onAct={() => void reveal(`${project.path}/${file.name}`)}
                />
              )}
            </ItemRow>
          ))
        }
      </AsyncSection>
      <ContentPreviewDialog
        open={previewing !== null}
        title={previewing ?? ""}
        origin={`repo root · ${project.path}`}
        body={body}
        onClose={() => {
          bodyGuard.invalidate();
          setPreviewing(null);
        }}
      />
    </>
  );
}

const LOADING = { status: "loading" } as const;

type FileListing = AsyncState<readonly InstructionFile[]>;

const INSTRUCTION_META: Record<InstructionFile["state"], string> = {
  file: "repo root",
  link: "symlink at repo root",
  missing: "not in this repo",
};

/**
 * One token-guarded read: claim, show loading, settle with whatever `load`
 * answers — or `failed` if it threw — unless a later read has claimed since.
 */
async function settleLatest<S>(
  guard: LatestAsyncGuard,
  set: (state: S | typeof LOADING) => void,
  failed: (message: string) => S,
  load: () => Promise<S>,
): Promise<void> {
  const token = guard.claim();
  set(LOADING);
  let next: S;
  try {
    next = await load();
  } catch (error) {
    next = failed(errorMessage(error));
  }
  if (guard.isCurrent(token)) set(next);
}

async function reveal(path: string): Promise<void> {
  await writeThrough("reveal the file", () => window.api.fs.revealInFinder(path));
}
