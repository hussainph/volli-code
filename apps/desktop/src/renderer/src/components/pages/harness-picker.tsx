/**
 * The harness master list — every harness this host can launch.
 *
 * ONE READ, two surfaces. Settings → About lists the inventory; Configure →
 * Sessions picks one per project. Both ask the same host the same question, and
 * two copies of the fetch would be two places for its failure behaviour to
 * drift.
 *
 * The pill-row selector and the identity card that used to live here went with
 * the Harness Runtimes category (VC-111): a settings category whose pane held
 * one read-only command string was a page teaching people the rail is not worth
 * reading. The command is a row in About now, beside the other facts about this
 * install.
 *
 * The pure union rule stays in `harness-catalog.ts`, which is enrolled at 100%
 * coverage precisely because it decides what a user sees. This file is view
 * glue over it and holds no rule of its own.
 */
import * as React from "react";
import { errorMessage, type HarnessAdapter } from "@volli/shared";

import { harnessListings, type HarnessListing } from "@renderer/components/pages/harness-catalog";
import { toastError } from "@renderer/lib/toast";

/**
 * `window.api` where there is one. The settings surfaces render under
 * `renderToStaticMarkup` in unit tests, where there is no `window` at all and
 * no preload bridge — the built-in half of the list is compiled in, so the pane
 * still renders every first-class harness with nothing to fetch.
 */
function preloadApi(): Window["api"] | undefined {
  return typeof window === "undefined" ? undefined : window.api;
}

/** Whether the registered half of the host inventory has settled truthfully. */
export type HarnessListingsStatus = "loading" | "ready" | "unavailable";

export interface HarnessListingsState {
  listings: readonly HarnessListing[];
  status: HarnessListingsStatus;
  refresh(): void;
}

/**
 * Every harness this host can launch: the compiled-in first-class adapters, plus
 * whatever manifests main reports registered.
 *
 * Per HOST, not per scope — a project cannot register or revoke a harness — so
 * both callers get the identical list and only the detail beneath it is scoped.
 * `status` lets a support report wait for the registered half rather than
 * silently calling the built-in prefix a complete inventory.
 */
export function useHarnessListingsState(): HarnessListingsState {
  const [registered, setRegistered] = React.useState<readonly HarnessAdapter[]>([]);
  const [status, setStatus] = React.useState<HarnessListingsStatus>("loading");
  const [request, setRequest] = React.useState(0);
  const refresh = React.useCallback(() => setRequest((current) => current + 1), []);

  React.useEffect(() => {
    const api = preloadApi();
    if (api === undefined) {
      setStatus("ready");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    api.harness
      .registered()
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          toastError(`Couldn't load registered harnesses: ${result.error}`);
          setStatus("unavailable");
          return;
        }
        setRegistered(result.harnesses);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastError(`Couldn't load registered harnesses: ${errorMessage(error)}`);
        setStatus("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const listings = React.useMemo(() => harnessListings(registered), [registered]);
  return React.useMemo(() => ({ listings, status, refresh }), [listings, refresh, status]);
}

/** The inventory alone, for callers that do not need to distinguish a partial first frame. */
export function useHarnessListings(): readonly HarnessListing[] {
  return useHarnessListingsState().listings;
}
