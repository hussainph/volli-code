/**
 * App-wide preferences — the sidebar-footer gear overlay.
 *
 * Everything here applies across every project, always. Project-scoped
 * configuration lives on the Configure nav tab, and there is no scope switch on
 * either surface: the surface IS the scope (VC-111). Where a value has two
 * tiers it appears on both, and the Configure side carries the revert control
 * that says it has diverged.
 *
 * The rail, the categories and their search keywords live in
 * `settings/settings-groups.tsx`; this file is the selection state around them.
 */
import * as React from "react";

import { PrefShell } from "@renderer/components/settings/kit";
import {
  resolveSettingsCategory,
  settingsGroups,
} from "@renderer/components/settings/settings-groups";

export function SettingsPage({
  initialCategoryKey,
  initialSignInProviderId,
}: { initialCategoryKey?: string; initialSignInProviderId?: string } = {}) {
  const groups = React.useMemo(
    () => settingsGroups(initialSignInProviderId),
    [initialSignInProviderId],
  );

  // Resolved once, from the deep link. `resolveSettingsCategory` maps the
  // retired `model-access` key onto `models` — the chat blocker still sends
  // the old one, and without the alias an auto-sign-in link opens General.
  const [activeKey, setActiveKey] = React.useState(
    () => resolveSettingsCategory(initialCategoryKey) ?? groups[0]?.categories[0]?.key ?? "general",
  );

  return (
    <PrefShell
      surfaceLabel="Settings"
      groups={groups}
      activeKey={activeKey}
      onSelect={setActiveKey}
    />
  );
}
