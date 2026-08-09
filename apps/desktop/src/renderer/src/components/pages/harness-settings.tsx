import * as React from "react";

import { activeHarness, type HarnessListing } from "@renderer/components/pages/harness-catalog";
import {
  HarnessIdentitySection,
  HarnessSelector,
  useHarnessListings,
} from "@renderer/components/pages/harness-picker";

/**
 * The Harness Runtimes category: every harness this host can launch, and what
 * there is to configure about the selected one, app-wide.
 *
 * Master-detail INSIDE the pane — see {@link HarnessSelector} for why the
 * selector sits above the detail rather than beside it.
 */
export function HarnessSettings() {
  const listings = useHarnessListings();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const active = activeHarness(listings, selectedId);

  return (
    <div className="flex flex-col gap-3">
      <HarnessSelector listings={listings} activeId={active?.id ?? null} onSelect={setSelectedId} />
      {active ? <HarnessDetail listing={active} /> : null}
    </div>
  );
}

/** The selected harness's pane: its identity card, plus whatever it alone can configure. */
function HarnessDetail({ listing }: { listing: HarnessListing }) {
  return (
    <div className="flex flex-col gap-6">
      <HarnessIdentitySection listing={listing} />
    </div>
  );
}
