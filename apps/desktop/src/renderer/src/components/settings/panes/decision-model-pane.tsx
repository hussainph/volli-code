import { Skeleton } from "@renderer/components/ui/skeleton";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import { SignpostIcon } from "@phosphor-icons/react/dist/csr/Signpost";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import * as React from "react";
import {
  decisionCloudDisclosure,
  DEFAULT_LOCAL_DECISION_URL,
  errorMessage,
  type DecisionModelCatalogEntry,
  type DecisionModelSetting,
  type Project,
} from "@volli/shared";

import type {
  DecisionModelResult,
  DecisionModelSettingsView,
  DecisionModelTestView,
} from "../../../../../ipc/contract";
import {
  catalogGroups,
  cloudLabel,
  cloudOptionKey,
  cloudSetting,
  cloudStatus,
  autoPickOn,
  autoPickSetting,
  DECISION_MODES,
  DEFAULT_LOCAL_DECISION_MODEL_ID,
  decisionMode,
  entryForKey,
  localSetting,
  priceLabel,
  settingLabel,
  type DecisionMode,
} from "@renderer/components/pages/decision-model-model";
import {
  CONTROL_W,
  OverrideControl,
  PrefRow,
  PrefSection,
} from "@renderer/components/settings/kit";
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
import { Notice } from "@renderer/components/ui/notice";
import { Segmented } from "@renderer/components/ui/segmented";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { Switch } from "@renderer/components/ui/switch";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { toastError } from "@renderer/lib/toast";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; view: DecisionModelSettingsView }
  | { status: "error"; message: string };

function useDecisionModelView(projectId: string | null) {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const fetches = useLatestAsync();
  const revision = useModelAccessClient()?.revision ?? 0;
  const load = React.useCallback(async () => {
    const token = fetches.claim();
    try {
      const result = await window.api.decisionModel.get(projectId);
      if (!fetches.isCurrent(token)) return;
      setState(
        result.ok
          ? { status: "loaded", view: result.settings }
          : { status: "error", message: result.error },
      );
    } catch (error) {
      if (fetches.isCurrent(token)) setState({ status: "error", message: errorMessage(error) });
    }
  }, [fetches, projectId]);
  React.useEffect(() => {
    void load();
    return () => fetches.invalidate();
  }, [load, fetches, revision]);
  const adopt = React.useCallback((result: Extract<DecisionModelResult, { ok: true }>) => {
    setState({ status: "loaded", view: result.settings });
  }, []);
  return { state, load, adopt };
}

function CloudItems({ catalog }: { catalog: readonly DecisionModelCatalogEntry[] }) {
  return (
    <>
      {catalogGroups(catalog).map((group) => (
        <SelectGroup key={group.providerId}>
          <SelectLabel>
            {group.providerLabel}
            {group.ready ? "" : " · needs sign-in"}
          </SelectLabel>
          {group.entries.map((entry) => (
            <SelectItem key={cloudOptionKey(entry)} value={cloudOptionKey(entry)}>
              {entry.label} · {priceLabel(entry)}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </>
  );
}

export function CloudOptInDialog({
  entry,
  onCancel,
  onAllow,
}: {
  entry: DecisionModelCatalogEntry | null;
  onCancel(): void;
  onAllow(entry: DecisionModelCatalogEntry): void;
}) {
  // The last model asked about, held while the dialog animates out: the
  // caller clears `entry` the moment a button is pressed, and the closing
  // frames must not read "Send decisions to ?".
  const [shown, setShown] = React.useState(entry);
  React.useEffect(() => {
    if (entry !== null) setShown(entry);
  }, [entry]);
  const label = shown === null ? "" : cloudLabel(shown);
  return (
    <AlertDialog open={entry !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Send decisions to {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {shown === null ? "" : decisionCloudDisclosure(label)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="decision-model-allow"
            onClick={() => (entry === null ? undefined : onAllow(entry))}
          >
            Allow
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AutoPickRow({
  setting,
  catalog,
  busy,
  testId,
  onChange,
}: {
  setting: Extract<DecisionModelSetting, { kind: "cloud" }>;
  catalog: readonly DecisionModelCatalogEntry[];
  busy: boolean;
  testId: string;
  onChange(next: DecisionModelSetting): void;
}) {
  const [asking, setAsking] = React.useState(false);
  const label = settingLabel(setting, catalog);
  return (
    <PrefRow label="Pick models automatically" testId={testId}>
      <Switch
        aria-label="Pick models automatically"
        checked={autoPickOn(setting)}
        disabled={busy}
        onCheckedChange={(enabled) => {
          if (enabled) {
            setAsking(true);
            return;
          }
          const next = autoPickSetting(setting, false, Date.now());
          if (next !== null) onChange(next);
        }}
      />
      <AlertDialog open={asking} onOpenChange={(open) => (open ? undefined : setAsking(false))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Let {label} choose models?</AlertDialogTitle>
            <AlertDialogDescription>
              {decisionCloudDisclosure(label, ["model.select"])}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setAsking(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid={`${testId}-allow`}
              onClick={() => {
                setAsking(false);
                const next = autoPickSetting(setting, true, Date.now());
                if (next !== null) onChange(next);
              }}
            >
              Allow
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PrefRow>
  );
}

function TestResult({ test }: { test: DecisionModelTestView | null }) {
  if (test === null) return null;
  return (
    <span
      className="flex items-center gap-2 text-ui text-muted-foreground"
      data-testid="decision-model-test-result"
      role="status"
    >
      <StatusDot state={test.ok ? "ready" : "error"} />
      {test.ok ? `Answered in ${Math.round(test.elapsedMs)} ms` : test.message}
    </span>
  );
}

export function DecisionModelSettings({ onSignIn }: { onSignIn(providerId: string): void }) {
  const { state, load, adopt } = useDecisionModelView(null);
  const [draftMode, setDraftMode] = React.useState<DecisionMode | null>(null);
  const [serverUrl, setServerUrl] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [asking, setAsking] = React.useState<DecisionModelCatalogEntry | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [test, setTest] = React.useState<DecisionModelTestView | null>(null);

  const stored = state.status === "loaded" ? state.view.global : null;
  // The fields follow what is STORED, keyed on the stored values rather than
  // on the view object: a re-read that changed nothing (a sign-in elsewhere
  // on the page) must not wipe what a person is halfway through typing.
  const storedUrl = stored?.kind === "local" ? stored.baseUrl : null;
  const storedModel = stored?.kind === "local" ? stored.modelId : null;
  React.useEffect(() => {
    if (storedUrl === null || storedModel === null) return;
    setServerUrl(storedUrl);
    setModelId(storedModel === DEFAULT_LOCAL_DECISION_MODEL_ID ? "" : storedModel);
  }, [storedUrl, storedModel]);

  async function save(setting: DecisionModelSetting): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setFieldError(null);
    setTest(null);
    try {
      const result = await window.api.decisionModel.set({ scope: "global" }, setting);
      if (!result.ok) {
        setFieldError(result.error);
        return false;
      }
      adopt(result);
      setDraftMode(null);
      return true;
    } catch (error) {
      toastError(`Couldn't save the decision model: ${errorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runTest(setting: DecisionModelSetting): Promise<void> {
    if (busy) return;
    setBusy(true);
    setTest(null);
    try {
      const result = await window.api.decisionModel.test(setting);
      if (result.ok) setTest(result.test);
      else setFieldError(result.error);
    } catch (error) {
      toastError(`Couldn't test the decision model: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") {
    return (
      <PrefSection title="Decision model" icon={SignpostIcon}>
        <div className="space-y-4 p-4" aria-label="Loading decision model">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </PrefSection>
    );
  }
  if (state.status === "error") {
    return (
      <PrefSection title="Decision model" icon={SignpostIcon}>
        <Notice
          announce
          tone="error"
          icon={WarningIcon}
          title="Couldn't read the decision model"
          detail={state.message}
          actions={
            <Button size="xs" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      </PrefSection>
    );
  }

  const { view } = state;
  const global = view.global;
  const mode = draftMode ?? decisionMode(global);
  const local = localSetting(serverUrl, modelId);
  const cloud = global.kind === "cloud" ? cloudStatus(global, view.catalog) : null;

  return (
    <PrefSection title="Decision model" icon={SignpostIcon}>
      <PrefRow label="Model" testId="decision-model-mode">
        <Segmented
          ariaLabel="Decision model"
          testId="decision-model-mode-control"
          value={mode}
          options={DECISION_MODES}
          disabled={busy}
          onChange={(next) => {
            setFieldError(null);
            setTest(null);
            if (next === "none") {
              setDraftMode(null);
              void save({ kind: "none" });
              return;
            }
            setDraftMode(next === decisionMode(global) ? null : next);
          }}
        />
      </PrefRow>

      {mode === "local" ? (
        <>
          <PrefRow label="Server" htmlFor="decision-model-url">
            <Input
              id="decision-model-url"
              className={CONTROL_W.lg}
              value={serverUrl}
              placeholder={DEFAULT_LOCAL_DECISION_URL}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setServerUrl(event.target.value)}
            />
          </PrefRow>
          <PrefRow label="Model id" htmlFor="decision-model-id">
            <Input
              id="decision-model-id"
              className={CONTROL_W.lg}
              value={modelId}
              placeholder="Any, for a single-model server"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setModelId(event.target.value)}
            />
          </PrefRow>
          <PrefRow label="Connection">
            <div className="flex items-center gap-3">
              <TestResult test={test} />
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void runTest(local)}
              >
                Test
              </Button>
              <Button size="xs" disabled={busy} onClick={() => void save(local)}>
                Save
              </Button>
            </div>
          </PrefRow>
        </>
      ) : null}

      {mode === "cloud" ? (
        <>
          <PrefRow label="Cloud model" testId="decision-model-cloud">
            <Select
              value={global.kind === "cloud" && draftMode === null ? cloudOptionKey(global) : ""}
              disabled={busy || view.catalog.length === 0}
              onValueChange={(key) => setAsking(entryForKey(view.catalog, key))}
            >
              <SelectTrigger className={CONTROL_W.lg}>
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                <CloudItems catalog={view.catalog} />
              </SelectContent>
            </Select>
          </PrefRow>
          {cloud !== null && draftMode === null ? (
            <PrefRow label="Status">
              <div className="flex items-center gap-3">
                {cloud.kind === "ready" ? (
                  <>
                    <TestResult test={test} />
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void runTest(global)}
                    >
                      Test
                    </Button>
                  </>
                ) : cloud.kind === "needs-setup" ? (
                  <>
                    <span className="flex items-center gap-2 text-ui text-muted-foreground">
                      <StatusDot state="waiting" />
                      Needs setup
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onSignIn(cloud.entry.providerId)}
                    >
                      Sign in to {cloud.entry.providerLabel}
                    </Button>
                  </>
                ) : (
                  <span className="text-ui text-attention">
                    This model is no longer available. Choose another.
                  </span>
                )}
              </div>
            </PrefRow>
          ) : null}
          {global.kind === "cloud" && draftMode === null ? (
            // The one-line trust boundary, kept on screen for as long as the
            // choice stands.
            // Only what this person opted into: a purpose added later is not
            // sent anything until they allow it.
            <p className="px-1 text-ui text-muted-foreground" data-testid="decision-model-sends">
              {decisionCloudDisclosure(settingLabel(global, view.catalog), global.optIn.purposes)}
            </p>
          ) : null}
          {global.kind === "cloud" && draftMode === null ? (
            <AutoPickRow
              setting={global}
              catalog={view.catalog}
              busy={busy}
              testId="decision-model-auto-pick"
              onChange={(next) => void save(next)}
            />
          ) : null}
        </>
      ) : null}

      {fieldError === null ? null : (
        <Notice announce tone="error" icon={WarningIcon} title={fieldError} />
      )}

      <CloudOptInDialog
        entry={asking}
        onCancel={() => setAsking(null)}
        onAllow={(entry) => {
          setAsking(null);
          void save(cloudSetting(entry, Date.now()));
        }}
      />
    </PrefSection>
  );
}

const NONE_VALUE = "__none__";
const LOCAL_VALUE = "__local__";

function optionValue(setting: DecisionModelSetting): string {
  if (setting.kind === "none") return NONE_VALUE;
  if (setting.kind === "local") return LOCAL_VALUE;
  return cloudOptionKey(setting);
}

export function ProjectDecisionModelRow({
  project,
  onSaved,
}: {
  project: Project;
  onSaved(project: Project): void;
}) {
  const { state, load, adopt } = useDecisionModelView(project.id);
  const [asking, setAsking] = React.useState<DecisionModelCatalogEntry | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (state.status !== "loaded") {
    return (
      <PrefRow label="Decision model" testId="project-decision-model">
        {state.status === "loading" ? (
          <span className="text-ui text-muted-foreground">
            <LoadingLabel>Loading</LoadingLabel>
          </span>
        ) : (
          <div className="flex items-center gap-3" title={state.message}>
            <span className="text-ui text-muted-foreground">Couldn&rsquo;t load</span>
            <Button size="xs" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
      </PrefRow>
    );
  }
  const { view } = state;
  const override = view.project ?? null;
  const effective = override ?? view.global;

  async function save(setting: DecisionModelSetting | null): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      const result = await window.api.decisionModel.set(
        { scope: "project", projectId: project.id },
        setting,
      );
      if (!result.ok) {
        toastError(`Couldn't save this project's decision model: ${result.error}`);
        return false;
      }
      adopt(result);
      if (result.project !== undefined) onSaved(result.project);
      return true;
    } catch (error) {
      toastError(`Couldn't save this project's decision model: ${errorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PrefRow
        label="Decision model"
        testId="project-decision-model"
        // The same trust boundary the app-wide page keeps on screen, for the
        // opt-in that applies here (this project's own, or the one it inherits)
        // and only for the purposes that opt-in covers.
        description={
          effective.kind === "cloud" ? (
            <span data-testid="project-decision-model-sends">
              {decisionCloudDisclosure(
                settingLabel(effective, view.catalog),
                effective.optIn.purposes,
              )}
            </span>
          ) : undefined
        }
      >
        <OverrideControl
          label="Decision model"
          inheritedValue={settingLabel(view.global, view.catalog)}
          overridden={override !== null}
          disabled={busy}
          onRevert={() => void save(null)}
        >
          <Select
            value={optionValue(effective)}
            disabled={busy}
            onValueChange={(value) => {
              if (value === NONE_VALUE) {
                void save({ kind: "none" });
                return;
              }
              if (value === LOCAL_VALUE) {
                // The server Settings names, or the default one.
                void save(
                  view.global.kind === "local"
                    ? view.global
                    : localSetting(DEFAULT_LOCAL_DECISION_URL, ""),
                );
                return;
              }
              setAsking(entryForKey(view.catalog, value));
            }}
          >
            <SelectTrigger className={CONTROL_W.lg}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>None</SelectItem>
              <SelectItem value={LOCAL_VALUE}>
                {view.global.kind === "local"
                  ? settingLabel(view.global, view.catalog)
                  : "Local server"}
              </SelectItem>
              <CloudItems catalog={view.catalog} />
            </SelectContent>
          </Select>
        </OverrideControl>
        <CloudOptInDialog
          entry={asking}
          onCancel={() => setAsking(null)}
          onAllow={(entry) => {
            setAsking(null);
            void save(cloudSetting(entry, Date.now()));
          }}
        />
      </PrefRow>
      {override?.kind === "cloud" ? (
        // Only a project's own cloud model has a switch here; one that inherits
        // follows the app-wide switch above it.
        <AutoPickRow
          setting={override}
          catalog={view.catalog}
          busy={busy}
          testId="project-decision-model-auto-pick"
          onChange={(next) => void save(next)}
        />
      ) : null}
    </>
  );
}
