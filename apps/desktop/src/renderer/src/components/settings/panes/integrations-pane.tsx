/**
 * Settings → Integrations: the outside applications Volli can hand a file to.
 *
 * Read-only today, and honestly so. `external-apps.ts` probes Launch Services,
 * so this list is already what is INSTALLED rather than what is imaginable —
 * which is why the empty state below is reachable and not decorative.
 *
 * There is no "default editor" preference to set yet: every surface that opens
 * a file offers the whole list in a menu, and nothing stores a preferred one.
 * That is a real setting worth adding; it is not one this pane can pretend to
 * have. So the pane reports what was found and says where it is used.
 */
import * as React from "react";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { errorMessage } from "@volli/shared";

import type { ExternalApp } from "../../../../../ipc/contract";

import {
  AsyncSection,
  ItemRow,
  Provenance,
  type AsyncState,
} from "@renderer/components/settings/kit";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";

export function IntegrationsPane() {
  const [state, setState] = React.useState<AsyncState<readonly ExternalApp[]>>({
    status: "loading",
  });
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
      setState({ status: "ready", data: result.apps });
    } catch (error) {
      if (fetcher.isCurrent(token)) {
        setState({ status: "error", message: errorMessage(error), onRetry: () => void load() });
      }
    }
  }, [fetcher]);

  React.useEffect(() => {
    void load();
    return () => fetcher.invalidate();
  }, [load, fetcher]);

  return (
    <AsyncSection
      title="Open in…"
      icon={PlugsIcon}
      hint={<>Offered wherever Volli can hand over a file or a worktree.</>}
      state={state}
      isEmpty={(apps) => apps.length === 0}
      empty="None of the editors Volli knows are installed."
    >
      {(apps) => (
        <>
          {apps.map((app) => (
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
