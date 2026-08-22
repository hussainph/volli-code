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

/**
 * Every harness this host can launch: the compiled-in first-class adapters, plus
 * whatever manifests main reports registered.
 *
 * Per HOST, not per scope — a project cannot register or revoke a harness — so
 * both callers get the identical list and only the detail beneath it is scoped.
 */
export function useHarnessListings(): readonly HarnessListing[] {
  const [registered, setRegistered] = React.useState<readonly HarnessAdapter[]>([]);

  React.useEffect(() => {
    const api = preloadApi();
    if (api === undefined) return;
    let cancelled = false;
    api.harness
      .registered()
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          toastError(`Couldn't load registered harnesses: ${result.error}`);
          return;
        }
        setRegistered(result.harnesses);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastError(`Couldn't load registered harnesses: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return React.useMemo(() => harnessListings(registered), [registered]);
}
