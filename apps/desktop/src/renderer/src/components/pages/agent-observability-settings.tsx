/**
 * Settings → Agent telemetry (VC-119): the opt-in OTLP export switch.
 *
 * View glue only. The fold from a saved setting to what this pane shows lives in
 * `agent-observability-model.ts`, which is coverage-enrolled; this file draws it
 * and does the I/O.
 *
 * The switch and the address are saved together because they are one decision:
 * turning export on names where it goes. A refused address arrives here as the
 * endpoint policy's own sentence and is shown in the row rather than toasted
 * away — it is a correction to what was just typed, and it belongs beside the
 * field it was typed into. A collector that stops answering later shows up in
 * the same place, once, and never as a toast.
 */
import { ChartLineIcon } from "@phosphor-icons/react/dist/csr/ChartLine";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@volli/shared";

import type { AgentObservabilityView } from "../../../../ipc/contract";
import { agentObservabilityPanel } from "@renderer/components/pages/agent-observability-model";
import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { Notice } from "@renderer/components/ui/notice";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { Switch } from "@renderer/components/ui/switch";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { toastError } from "@renderer/lib/toast";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; view: AgentObservabilityView }
  | { status: "error"; message: string };

/**
 * How often a healthy exporter is re-asked whether it is still healthy.
 *
 * The transport discovers a collector that has gone away on its own schedule —
 * the first batch that does not land, which the metric reader may not attempt
 * for half a minute. This surface is pull-only, so without a re-ask the pane
 * would keep showing "Exporting" for a state main already knows is broken.
 */
const DELIVERY_RECHECK_MS = 5000;

export function AgentObservabilitySettings() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [endpoint, setEndpoint] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const settingsFetch = useLatestAsync();
  const load = useCallback(async () => {
    const token = settingsFetch.claim();
    try {
      const result = await window.api.agentObservability.get();
      if (!settingsFetch.isCurrent(token)) return;
      if (!result.ok) {
        setState({ status: "error", message: result.error });
        return;
      }
      setState({ status: "loaded", view: result.settings });
      setEndpoint(result.settings.endpoint);
    } catch (error) {
      if (settingsFetch.isCurrent(token)) {
        setState({ status: "error", message: errorMessage(error) });
      }
    }
  }, [settingsFetch]);

  /**
   * Re-read the setting without touching the address field.
   *
   * Deliberately not {@link load}: that adopts the stored address, which would
   * overwrite whatever somebody is in the middle of typing. A recheck is only
   * ever about the delivery state.
   */
  const recheck = useCallback(async () => {
    const token = settingsFetch.claim();
    try {
      const result = await window.api.agentObservability.get();
      if (!settingsFetch.isCurrent(token) || !result.ok) return;
      setState({ status: "loaded", view: result.settings });
    } catch {
      // A failed recheck is not news. The pane keeps the last answer it got
      // rather than replacing a real setting with a transport hiccup.
    }
  }, [settingsFetch]);

  useEffect(() => {
    void load();
    return () => settingsFetch.invalidate();
  }, [load, settingsFetch]);

  // Only a working exporter is worth watching, and only while nothing is being
  // written. `problem` is latched in main, so the moment the answer changes
  // there is nothing further to learn until the person changes the
  // configuration — which means this timer stops itself rather than running for
  // as long as the page is open.
  const watchingDelivery = state.status === "loaded" && state.view.status === "exporting" && !busy;
  useEffect(() => {
    if (!watchingDelivery) return;
    const timer = setInterval(() => void recheck(), DELIVERY_RECHECK_MS);
    return () => clearInterval(timer);
  }, [watchingDelivery, recheck]);

  /** One shape for every write: run it, take the view, put a refusal in the row. */
  async function write(enabled: boolean, address: string): Promise<void> {
    if (busy) return;
    // A write is the newest word on this setting, so it supersedes any read
    // already in flight: a recheck that started first must not land afterwards
    // and paint the state this write just replaced.
    settingsFetch.claim();
    setBusy(true);
    setFieldError(null);
    try {
      const result = await window.api.agentObservability.set(enabled, address);
      if (!result.ok) {
        setFieldError(result.error);
        return;
      }
      setState({ status: "loaded", view: result.settings });
      // The stored address is the normalized one, so the field shows what is
      // actually being used rather than what was typed.
      setEndpoint(result.settings.endpoint);
    } catch (error) {
      toastError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") {
    return (
      <PrefSection title="Agent telemetry" icon={ChartLineIcon}>
        <p className={EMPTY_INLINE}>Loading…</p>
      </PrefSection>
    );
  }
  if (state.status === "error") {
    return (
      <PrefSection title="Agent telemetry" icon={ChartLineIcon}>
        <Notice
          announce
          tone="error"
          icon={WarningIcon}
          title="Couldn't read your telemetry settings"
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

  const panel = agentObservabilityPanel(state.view);
  return (
    <PrefSection title="Agent telemetry" icon={ChartLineIcon}>
      <PrefRow label="Export">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-ui text-muted-foreground">
            <StatusDot state={panel.dotState} />
            {panel.stateLabel}
          </span>
          <Switch
            aria-label="Export agent telemetry"
            data-testid="agent-observability-export"
            checked={panel.enabled}
            disabled={busy}
            onCheckedChange={(next) => void write(next, endpoint)}
          />
        </div>
      </PrefRow>

      <PrefRow label="Collector" htmlFor="agent-observability-endpoint" align="start">
        <div className="flex w-80 flex-col items-end gap-2">
          <Input
            id="agent-observability-endpoint"
            value={endpoint}
            placeholder="http://localhost:4318"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setEndpoint(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={busy || endpoint.trim() === ""}
            onClick={() => void write(state.view.enabled, endpoint)}
          >
            Save collector
          </Button>
        </div>
      </PrefRow>

      {fieldError === null ? null : (
        <Notice announce tone="error" icon={WarningIcon} title={fieldError} />
      )}
      {panel.problem === null || fieldError !== null ? null : (
        <Notice tone="error" icon={WarningIcon} title={panel.problem} />
      )}
    </PrefSection>
  );
}
