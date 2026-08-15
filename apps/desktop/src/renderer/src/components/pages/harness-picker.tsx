/**
 * The harness master list, and the two spare views every surface that offers a
 * per-harness choice draws it with.
 *
 * Lifted out of `harness-settings.tsx` when Configure gained a Runtime category:
 * app-wide Settings and one project's Configure page now ask the same host the
 * same question, and two copies of the fetch would be two places for its failure
 * behaviour — and for the pill row's pressed-state contract — to drift.
 *
 * The pure union rule stays where it was, in `harness-catalog.ts`: that module
 * is enrolled at 100% coverage precisely because it decides what a user sees,
 * and an effect and some JSX are not decisions. This file is the view glue over
 * it, and holds no rule of its own.
 */
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import * as React from "react";
import { errorMessage, type HarnessAdapter } from "@volli/shared";

import {
  harnessListings,
  type HarnessListing,
  type HarnessOrigin,
} from "@renderer/components/pages/harness-catalog";
import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import { Badge } from "@renderer/components/ui/badge";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

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

/**
 * The master list, as one row of pills above the detail it selects.
 *
 * Above rather than beside: a settings pane is one reading column (the app's
 * `max-w-content` measure inside its gutter), and it already sits behind
 * Settings' own category rail. A second vertical rail in front of that is two
 * rails deep to reach one card, and it spends the column's width on chrome
 * rather than on the command a launch resolves. Above, the selector costs one
 * row and the detail keeps the full width.
 *
 * Every harness is listed, including the ones with nothing to configure. A list
 * pruned to the configurable one would quietly claim this host can launch
 * exactly one harness.
 */
export function HarnessSelector({
  listings,
  activeId,
  onSelect,
}: {
  listings: readonly HarnessListing[];
  activeId: string | null;
  onSelect(harnessId: string): void;
}) {
  return (
    // The track wears the same fill as the sections below it and no frame, for
    // the same reason they dropped theirs: this pane already sits inside the
    // app shell's framed card.
    <div
      role="group"
      aria-label="Harnesses"
      className="flex w-fit flex-wrap gap-1 rounded-lg bg-card p-1"
    >
      {listings.map((listing) => {
        const isActive = listing.id === activeId;
        return (
          <button
            key={listing.id}
            type="button"
            aria-current={isActive ? true : undefined}
            onClick={() => onSelect(listing.id)}
            className={cn(
              "h-7 rounded-md px-4 text-ui transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {listing.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The selected harness's identity card: the executable a launch resolves, and
 * where the harness came from.
 *
 * Deliberately spare — these are what is true and knowable about a harness
 * Volli has nothing else to change about, and padding a pane out to a matching
 * size would state things nobody can act on. There is nothing else to show:
 * the one row that ever sat under these, the binary override, was retired once
 * its only launch-time reader went, and a launch resolves its binary off the
 * login-shell PATH the generated wrapper walks.
 */
export function HarnessIdentitySection({ listing }: { listing: HarnessListing }) {
  return (
    <SettingsSection
      title={listing.label}
      icon={CpuIcon}
      action={<OriginChip origin={listing.origin} />}
    >
      <SettingsRow label="Command">
        <code className="rounded-sm border border-border/50 bg-muted/30 px-1 py-1 font-mono text-ui text-foreground">
          {listing.command}
        </code>
      </SettingsRow>
    </SettingsSection>
  );
}

/** Built-in or registered, stated where the harness's other identity facts are. */
function OriginChip({ origin }: { origin: HarnessOrigin }) {
  return <Badge className="uppercase">{origin === "built-in" ? "Built-in" : "Registered"}</Badge>;
}
