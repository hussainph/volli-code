/**
 * Settings → Integrations: the outside applications Volli can hand a file to.
 *
 * Launch Services owns availability, and this pane is where a look that could
 * not run is reported: it reads the app-wide discovery state
 * (`files/external-app-discovery.tsx`) rather than scanning on its own, so the
 * Try again below is the ONE recovery for every Files menu too, and a failure
 * can no longer render here as "no supported apps" — a claim only a completed
 * scan earns. The chosen default stays in the UI store, which every Files
 * surface reads.
 */
import * as React from "react";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";

import type { ExternalApp } from "../../../../../ipc/contract";

import { useExternalAppDiscovery } from "@renderer/components/files/external-app-discovery";
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
import { useUiStore } from "@renderer/stores/ui";

const ASK_EVERY_TIME_VALUE = "__ask-every-time__";

/** The shared discovery state in this section's four-state vocabulary. */
function sectionState(
  discovery: ReturnType<typeof useExternalAppDiscovery>["discovery"],
  rescan: () => void,
): AsyncState<readonly ExternalApp[]> {
  switch (discovery.status) {
    case "scanning": {
      return { status: "loading" };
    }
    case "failed": {
      return { status: "error", message: discovery.message, onRetry: rescan };
    }
    case "ready": {
      return { status: "ready", data: discovery.apps };
    }
  }
}

export function IntegrationsPane() {
  const { discovery, rescan } = useExternalAppDiscovery();
  const defaultExternalAppId = useUiStore((store) => store.defaultExternalAppId);
  const setDefaultExternalAppId = useUiStore((store) => store.setDefaultExternalAppId);

  // Opening Settings is the gesture that means "look again" — an app installed
  // since launch appears without a relaunch, and the result reaches Files too.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    rescan();
  }, [rescan]);

  const state = sectionState(discovery, rescan);
  // The Select speaks for the PREFERENCE, so it reads the last confirmed list
  // rather than the section's state: a failed rescan must not make a standing
  // choice read back as "Ask every time", which looks like it was discarded.
  const apps = discovery.apps;
  const selectedApp =
    defaultExternalAppId === null ? undefined : apps.find((app) => app.id === defaultExternalAppId);
  const selectedValue = selectedApp?.id ?? ASK_EVERY_TIME_VALUE;
  const selectedLabel = selectedApp?.label ?? "Ask every time";

  return (
    <AsyncSection
      title="External apps"
      icon={PlugsIcon}
      hint={<>Volli offers these apps whenever you open a file or a worktree.</>}
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
      empty="Volli found no supported apps on this Mac."
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
