/**
 * Settings → Integrations: the outside applications Volli can hand a file to.
 *
 * Launch Services owns availability, so a successful list both supplies the
 * Select and reconciles a preference whose app has since been removed. The
 * choice itself stays in the app-wide UI store: every Files surface consumes
 * that one value through `external-app-menu.tsx`.
 */
import * as React from "react";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { errorMessage } from "@volli/shared";

import type { ExternalApp } from "../../../../../ipc/contract";

import {
  AsyncSection,
  CONTROL_W,
  ItemRow,
  PrefRow,
  Provenance,
  type AsyncState,
} from "@renderer/components/settings/kit";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { useUiStore } from "@renderer/stores/ui";

const ASK_EVERY_TIME_VALUE = "__ask-every-time__";

export function IntegrationsPane() {
  const [state, setState] = React.useState<AsyncState<readonly ExternalApp[]>>({
    status: "loading",
  });
  const defaultExternalAppId = useUiStore((store) => store.defaultExternalAppId);
  const setDefaultExternalAppId = useUiStore((store) => store.setDefaultExternalAppId);
  const reconcileDefaultExternalApp = useUiStore((store) => store.reconcileDefaultExternalApp);
  const fetcher = useLatestAsync();

  const load = React.useCallback(async () => {
    const token = fetcher.claim();
    setState({ status: "loading" });
    try {
      const result = await window.api.files.listExternalApps();
      if (!fetcher.isCurrent(token)) return;
      if (!result.ok) {
        setState({ status: "error", message: result.error, onRetry: () => void load() });
        return;
      }
      reconcileDefaultExternalApp(result.apps);
      setState({ status: "ready", data: result.apps });
    } catch (error) {
      if (fetcher.isCurrent(token)) {
        setState({ status: "error", message: errorMessage(error), onRetry: () => void load() });
      }
    }
  }, [fetcher, reconcileDefaultExternalApp]);

  React.useEffect(() => {
    void load();
    return () => fetcher.invalidate();
  }, [load, fetcher]);

  const apps = state.status === "ready" ? state.data : [];
  const selectedApp =
    defaultExternalAppId === null ? undefined : apps.find((app) => app.id === defaultExternalAppId);
  const selectedValue = selectedApp?.id ?? ASK_EVERY_TIME_VALUE;
  const selectedLabel = selectedApp?.label ?? "Ask every time";

  return (
    <AsyncSection
      title="Open in…"
      icon={PlugsIcon}
      hint={<>Offered wherever Volli can hand over a file or a worktree.</>}
      before={
        <PrefRow label="Open files in" htmlFor="open-files-in">
          <Select
            value={selectedValue}
            onValueChange={(value) => {
              if (value === ASK_EVERY_TIME_VALUE) {
                setDefaultExternalAppId(null);
                return;
              }
              const app = apps.find((candidate) => candidate.id === value);
              if (app !== undefined) setDefaultExternalAppId(app.id);
            }}
          >
            <SelectTrigger id="open-files-in" className={CONTROL_W.md}>
              <SelectValue>{selectedLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ASK_EVERY_TIME_VALUE}>Ask every time</SelectItem>
              {apps.map((app) => (
                <SelectItem key={app.id} value={app.id}>
                  {app.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PrefRow>
      }
      state={state}
      isEmpty={(availableApps) => availableApps.length === 0}
      empty="No known apps are installed."
    >
      {(availableApps) => (
        <>
          {availableApps.map((app) => (
            <ItemRow
              key={app.id}
              name={app.label}
              badges={<Provenance>{app.kind === "terminal" ? "Terminal" : "Editor"}</Provenance>}
            />
          ))}
        </>
      )}
    </AsyncSection>
  );
}
