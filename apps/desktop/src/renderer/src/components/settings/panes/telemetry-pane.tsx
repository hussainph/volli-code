import { TrendIcon, WarningIcon } from "@renderer/components/ui/icon";

import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@volli/shared";

import type { AgentObservabilityView } from "../../../../../ipc/contract";
import { agentObservabilityPanel } from "@renderer/components/pages/agent-observability-model";
import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
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
      <PrefSection title="Agent telemetry" icon={TrendIcon}>
        <div className="space-y-4 p-4" aria-label="Loading telemetry settings"></div>
      </PrefSection>
    );
  }
  if (state.status === "error") {
    return (
      <PrefSection title="Agent telemetry" icon={TrendIcon}>
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
    <PrefSection title="Agent telemetry" icon={TrendIcon}>
      <PrefRow label="Export agent telemetry">
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

      <PrefRow label="Collector" htmlFor="agent-observability-endpoint">
        <div className="flex w-64 max-w-full flex-col items-end gap-2">
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
