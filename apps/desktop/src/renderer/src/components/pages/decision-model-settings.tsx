/**
 * Settings → Models → Decision model, and the project's override in
 * Configure → Sessions (VC-478).
 *
 * View glue only: what a setting is called, what a cloud choice writes and
 * what a model's status says live in `decision-model-model.ts`; this file
 * draws it and does the I/O through `window.api.decisionModel`.
 *
 * **Three choices, one control.** None, Local or Cloud, as the ticket names
 * them. None saves at once — turning a model off should never wait on a
 * second step. Local opens its two fields and saves when told to; Cloud
 * opens the catalog, and choosing a model asks the opt-in before anything is
 * saved.
 *
 * **The opt-in is the one trust boundary on the page**, so it is the one
 * place that speaks in sentences: a dialog at the moment of choice that says
 * what leaves this Mac, and one muted line under a saved cloud model that
 * keeps saying it. Nothing else here explains itself.
 *
 * **No key is ever typed here.** A cloud model whose provider needs a key
 * says "needs setup" and offers Sign in, which hands over to the Accounts
 * section below, where every provider credential is entered.
 */
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
} from "../../../../ipc/contract";
import {
  catalogGroups,
  cloudLabel,
  cloudOptionKey,
  cloudSetting,
  cloudStatus,
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
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
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
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { toastError } from "@renderer/lib/toast";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; view: DecisionModelSettingsView }
  | { status: "error"; message: string };

/** The view for one page — app-wide, or one project's — and the write that replaces it. */
function useDecisionModelView(projectId: string | null) {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const fetches = useLatestAsync();
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
  }, [load, fetches]);
  const adopt = React.useCallback((result: Extract<DecisionModelResult, { ok: true }>) => {
    setState({ status: "loaded", view: result.settings });
  }, []);
  return { state, load, adopt };
}

/** The cloud catalog as Select items, grouped by provider, signed-in providers first. */
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

/**
 * The opt-in, asked at the moment a cloud model is chosen: what the model is,
 * and what each feature that uses it sends. Allow is the only thing that
 * writes a cloud setting.
 */
export function CloudOptInDialog({
  entry,
  onCancel,
  onAllow,
}: {
  entry: DecisionModelCatalogEntry | null;
  onCancel(): void;
  onAllow(entry: DecisionModelCatalogEntry): void;
}) {
  return (
    <AlertDialog open={entry !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Send decisions to {entry === null ? "" : cloudLabel(entry)}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {entry === null ? "" : decisionCloudDisclosure(cloudLabel(entry))} Choose None at any
            time to stop.
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

/**
 * Settings → Models: the app-wide decision model.
 *
 * `onSignIn` hands a provider to the Accounts section on the same page, which
 * presses that provider's own sign-in — the one place a key is entered.
 */
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
  // The fields follow what is stored until a person starts editing them.
  React.useEffect(() => {
    if (stored?.kind !== "local") return;
    setServerUrl(stored.baseUrl);
    setModelId(stored.modelId === DEFAULT_LOCAL_DECISION_MODEL_ID ? "" : stored.modelId);
  }, [stored]);

  async function save(setting: DecisionModelSetting): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFieldError(null);
    setTest(null);
    try {
      const result = await window.api.decisionModel.set({ scope: "global" }, setting);
      if (!result.ok) {
        setFieldError(result.error);
        return;
      }
      adopt(result);
      setDraftMode(null);
    } catch (error) {
      toastError(`Couldn't save the decision model: ${errorMessage(error)}`);
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
        <p className={EMPTY_INLINE}>Loading…</p>
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
    <PrefSection
      title="Decision model"
      icon={SignpostIcon}
      hint={<>Answers typed questions without writing text. New Sessions get the classify tool.</>}
    >
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
                    No longer offered — choose another model.
                  </span>
                )}
              </div>
            </PrefRow>
          ) : null}
          {global.kind === "cloud" && draftMode === null ? (
            // The one-line trust boundary, kept on screen for as long as the
            // choice stands.
            <p className="px-1 text-ui text-muted-foreground" data-testid="decision-model-sends">
              {decisionCloudDisclosure(settingLabel(global, view.catalog))}
            </p>
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

/** The value the project Select shows for each kind of setting. */
const NONE_VALUE = "__none__";
const LOCAL_VALUE = "__local__";

function optionValue(setting: DecisionModelSetting): string {
  if (setting.kind === "none") return NONE_VALUE;
  if (setting.kind === "local") return LOCAL_VALUE;
  return cloudOptionKey(setting);
}

/**
 * Configure → Sessions: this project's decision model, or the app-wide one.
 *
 * An `OverrideControl`, on the Model row's pattern above it: the Select shows
 * the inherited value until touched, and a revert button is the one sign the
 * project differs. A project chooses None, the local server Settings names
 * (or the default one), or a cloud model — which asks the same opt-in.
 */
export function ProjectDecisionModelRow({
  project,
  onSaved,
}: {
  project: Project;
  onSaved(project: Project): void;
}) {
  const { state, adopt } = useDecisionModelView(project.id);
  const [asking, setAsking] = React.useState<DecisionModelCatalogEntry | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (state.status !== "loaded") {
    return (
      <PrefRow label="Decision model" testId="project-decision-model">
        <span className="text-ui text-muted-foreground">
          {state.status === "loading" ? "Loading…" : "Unavailable"}
        </span>
      </PrefRow>
    );
  }
  const { view } = state;
  const override = view.project ?? null;
  const effective = override ?? view.global;

  async function save(setting: DecisionModelSetting | null): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.api.decisionModel.set(
        { scope: "project", projectId: project.id },
        setting,
      );
      if (!result.ok) {
        toastError(`Couldn't save this project's decision model: ${result.error}`);
        return;
      }
      adopt(result);
      if (result.project !== undefined) onSaved(result.project);
    } catch (error) {
      toastError(`Couldn't save this project's decision model: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PrefRow label="Decision model" testId="project-decision-model">
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
  );
}
