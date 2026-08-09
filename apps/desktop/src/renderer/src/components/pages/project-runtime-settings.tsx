import * as React from "react";
import { type Project } from "@volli/shared";

import { activeHarness } from "@renderer/components/pages/harness-catalog";
import {
  HarnessIdentitySection,
  HarnessSelector,
  useHarnessListings,
} from "@renderer/components/pages/harness-picker";

/**
 * Configure → Runtime: which models one project's chat picks from.
 *
 * The same master-detail as app-wide Settings, at project scope — every harness
 * the host can launch is listed, not just the one with something to configure,
 * because a list pruned to OpenCode would quietly claim this host can launch one
 * harness. The others get the identity card and nothing else, which is the whole
 * truth about them here.
 *
 * The binary override is deliberately ABSENT. It is global by construction —
 * one launch path reads the stored value, and it reads it per harness, never per
 * project — so offering it here would persist a value no launch consults: a
 * setting that appears to work and does nothing. Models are the opposite; they
 * resolve per project already (migration 019), and this is the surface that
 * writes that column.
 *
 * Keyed on the project so switching projects while the pane is open remounts the
 * detail: the selection and the catalog's local load state describe ONE
 * project's session with this pane.
 */
export function ProjectRuntimeSettings({ project }: { project: Project }) {
  const listings = useHarnessListings();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const active = activeHarness(listings, selectedId);

  return (
    <div key={project.id} className="flex flex-col gap-3">
      <HarnessSelector listings={listings} activeId={active?.id ?? null} onSelect={setSelectedId} />
      {active ? (
        <div className="flex flex-col gap-6">
          <HarnessIdentitySection listing={active} />
        </div>
      ) : null}
    </div>
  );
}
