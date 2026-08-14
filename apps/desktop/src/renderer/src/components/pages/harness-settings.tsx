import * as React from "react";

import { activeHarness } from "@renderer/components/pages/harness-catalog";
import {
  HarnessIdentitySection,
  HarnessSelector,
  useHarnessListings,
} from "@renderer/components/pages/harness-picker";

/**
 * The Harness Runtimes category: every harness this host can launch, and what
 * is true of the selected one, app-wide.
 *
 * Master-detail INSIDE the pane — see {@link HarnessSelector} for why the
 * selector sits above the detail rather than beside it. The detail is the
 * identity card and nothing else, so it is rendered here directly; a wrapper
 * around one child was only ever describing a stack that no longer stacks.
 */
export function HarnessSettings() {
  const listings = useHarnessListings();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const active = activeHarness(listings, selectedId);

  return (
    <div className="flex flex-col gap-4">
      <HarnessSelector listings={listings} activeId={active?.id ?? null} onSelect={setSelectedId} />
      {active ? <HarnessIdentitySection listing={active} /> : null}
    </div>
  );
}
