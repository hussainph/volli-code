/**
 * The one external-app discovery state, shared by every Files menu and by
 * Settings → Integrations.
 *
 * Two surfaces used to scan independently and each kept only the successful
 * half of the answer: Files ignored a failure outright, Integrations held its
 * own copy of the list. That is why a failed inspection could read as a
 * finished one — nothing in either surface could say "we did not get to look".
 * This module holds the third state explicitly:
 *
 *   scanning — a look is in flight; `apps` is whatever a previous scan confirmed
 *   ready    — a COMPLETED scan; `apps` is the whole truth, empty included
 *   failed   — the look could not run; `apps` is the last confirmed list
 *
 * The rules that follow from it are the point. A failed scan never replaces
 * the app list (Files keeps what it knows) and never reconciles the saved
 * default (it has no evidence the app went away). Only `ready` may say this
 * Mac has no supported apps, and only Integrations offers the retry — the
 * Files menus fall back to Finder in silence rather than growing a recovery
 * control apiece.
 */
import * as React from "react";
import { errorMessage } from "@volli/shared";

import type { ExternalApp } from "../../../../ipc/contract";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { useUiStore } from "@renderer/stores/ui";

export type ExternalAppDiscovery =
  | { status: "scanning"; apps: readonly ExternalApp[] }
  | { status: "ready"; apps: readonly ExternalApp[] }
  | { status: "failed"; apps: readonly ExternalApp[]; message: string };

/** What one scan can report back. */
export type ExternalAppScanOutcome =
  | { kind: "started" }
  | { kind: "scanned"; apps: readonly ExternalApp[] }
  | { kind: "failed"; message: string };

const NO_EXTERNAL_APPS: readonly ExternalApp[] = [];

/** Before the first scan answers: a look is in flight and nothing is confirmed. */
export const UNSCANNED_EXTERNAL_APPS: ExternalAppDiscovery = {
  status: "scanning",
  apps: NO_EXTERNAL_APPS,
};

/**
 * The whole state machine, pure. `apps` only ever changes on `scanned`: that
 * single rule is what keeps a confirmed menu on screen across a failed refresh.
 */
export function nextExternalAppDiscovery(
  current: ExternalAppDiscovery,
  outcome: ExternalAppScanOutcome,
): ExternalAppDiscovery {
  switch (outcome.kind) {
    case "started": {
      return { status: "scanning", apps: current.apps };
    }
    case "scanned": {
      return { status: "ready", apps: outcome.apps };
    }
    case "failed": {
      return { status: "failed", apps: current.apps, message: outcome.message };
    }
  }
}

export interface ExternalAppDiscoveryHandle {
  discovery: ExternalAppDiscovery;
  /** Look again. Integrations' Try again and its mount both call this. */
  rescan: () => void;
}

const ExternalAppsContext = React.createContext<ExternalAppDiscoveryHandle>({
  discovery: UNSCANNED_EXTERNAL_APPS,
  rescan: () => {},
});

/**
 * Detect after the app is ready, reconcile a stale default from a completed
 * scan only, then let every surface render the same one answer.
 */
export function ExternalAppsProvider({ children }: { children: React.ReactNode }) {
  // Always UNSCANNED at mount. The `initialApps` seed this provider used to
  // accept had no caller in app, lab, or test, and it was the one way to reach
  // a "ready" state that no scan had produced.
  const [discovery, setDiscovery] = React.useState<ExternalAppDiscovery>(UNSCANNED_EXTERNAL_APPS);
  const fetcher = useLatestAsync();

  const rescan = React.useCallback(() => {
    const token = fetcher.claim();
    const apply = (outcome: ExternalAppScanOutcome) => {
      if (fetcher.isCurrent(token)) {
        setDiscovery((current) => nextExternalAppDiscovery(current, outcome));
      }
    };
    apply({ kind: "started" });
    void (async () => {
      try {
        const result = await window.api.files.listExternalApps();
        if (!result.ok) {
          apply({ kind: "failed", message: result.error });
          return;
        }
        // A completed scan is the only evidence that a saved app is gone.
        if (fetcher.isCurrent(token)) {
          useUiStore.getState().reconcileDefaultExternalApp(result.apps);
        }
        apply({ kind: "scanned", apps: result.apps });
      } catch (error: unknown) {
        apply({ kind: "failed", message: errorMessage(error) });
      }
    })();
  }, [fetcher]);

  React.useEffect(() => {
    rescan();
    return () => fetcher.invalidate();
  }, [rescan, fetcher]);

  const value = React.useMemo(() => ({ discovery, rescan }), [discovery, rescan]);
  return <ExternalAppsContext.Provider value={value}>{children}</ExternalAppsContext.Provider>;
}

/** What the Files menus render: the last list a scan actually confirmed. */
export function useExternalApps(): readonly ExternalApp[] {
  return React.useContext(ExternalAppsContext).discovery.apps;
}

/** The full state plus its retry — for the one surface that owns recovery. */
export function useExternalAppDiscovery(): ExternalAppDiscoveryHandle {
  return React.useContext(ExternalAppsContext);
}
