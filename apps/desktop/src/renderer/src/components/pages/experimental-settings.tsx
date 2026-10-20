import { FlaskIcon } from "@phosphor-icons/react/dist/csr/Flask";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import * as React from "react";
import {
  errorMessage,
  EXPERIMENTS,
  type ExperimentId,
  type ExperimentSnapshot,
} from "@volli/shared";

import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Notice } from "@renderer/components/ui/notice";
import { Switch } from "@renderer/components/ui/switch";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";
import { hasVisibleExperiments, useExperimentsStore } from "@renderer/stores/experiments";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; snapshot: ExperimentSnapshot }
  | { status: "error"; message: string };

/** Settings → System → Experimental. The host owns this registry and its writes. */
export function ExperimentalSettings() {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [busy, setBusy] = React.useState(false);
  const reads = useLatestAsync();
  const saveGeneration = React.useRef(0);

  const load = React.useCallback(async () => {
    const token = reads.claim();
    setState({ status: "loading" });
    try {
      const snapshot = await sessionRpcClient().settings.experiments.query();
      // The host's answer heals the app-wide projection too: a boot read that
      // failed (and stays failed) or an environment-locked flag this page
      // cannot save still reaches every flagged surface once it is seen here.
      useExperimentsStore.getState().receive(snapshot);
      if (!reads.isCurrent(token)) return;
      setState({ status: "loaded", snapshot });
    } catch (error) {
      if (!reads.isCurrent(token)) return;
      const message = errorMessage(error);
      setState({ status: "error", message });
      toastError(`Couldn't load experimental settings: ${message}`);
    }
  }, [reads]);

  React.useEffect(() => {
    void load();
    return () => {
      reads.invalidate();
      // A late mutation must not update a page that has gone away.
      saveGeneration.current += 1;
    };
  }, [load, reads]);

  async function save(id: ExperimentId, enabled: boolean): Promise<void> {
    if (busy || state.status !== "loaded") return;
    setBusy(true);
    // A save supersedes a read already in flight. The returned snapshot is the
    // new source of truth; no optimistic toggle can outlive a refused write.
    reads.claim();
    const generation = ++saveGeneration.current;
    try {
      const snapshot = await sessionRpcClient().settings.setExperiment.mutate({ id, enabled });
      // The host's answer, wherever this page went: flagged surfaces follow it.
      useExperimentsStore.getState().receive(snapshot);
      if (generation !== saveGeneration.current) return;
      setState({ status: "loaded", snapshot });
    } catch (error) {
      // The person requested this write: report failure even if they navigated
      // away while it was pending. Only component-state updates are retired.
      toastError(`Couldn't save experimental settings: ${errorMessage(error)}`);
    } finally {
      if (generation === saveGeneration.current) setBusy(false);
    }
  }

  const snapshot = state.status === "loaded" ? state.snapshot : null;
  if (snapshot !== null && !hasVisibleExperiments(snapshot)) return null;
  const experiments = EXPERIMENTS.filter(({ id }) => snapshot?.[id].visible !== false);

  return (
    <PrefSection title="Experimental" icon={FlaskIcon}>
      {experiments.map((experiment) => {
        const value = snapshot?.[experiment.id];
        const environmentLocked = value?.source === "environment";
        return (
          <PrefRow
            key={experiment.id}
            label={experiment.label}
            description={experiment.description}
            testId={`experiment-${experiment.id}`}
          >
            {environmentLocked ? (
              <span className="text-ui text-muted-foreground" data-testid="experiment-source">
                Set by environment
              </span>
            ) : null}
            <Switch
              aria-label={experiment.label}
              data-testid={`experiment-${experiment.id}-switch`}
              checked={value?.enabled ?? false}
              disabled={value === undefined || busy || environmentLocked}
              onCheckedChange={(enabled) => void save(experiment.id, enabled)}
            />
          </PrefRow>
        );
      })}

      {state.status === "loading" ? <p className={EMPTY_INLINE}>Loading…</p> : null}
      {state.status === "error" ? (
        <Notice
          announce
          tone="error"
          icon={WarningIcon}
          title="Couldn't read experimental settings"
          detail={state.message}
          actions={
            <Button size="xs" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : null}
    </PrefSection>
  );
}
