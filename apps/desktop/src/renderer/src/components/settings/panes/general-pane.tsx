/**
 * Settings → General: the app-wide chrome preferences that had no home.
 *
 * These already existed and already persisted — they were simply unreachable
 * except by keyboard shortcut or by finding the one surface that happened to
 * toggle them. A preference the app remembers forever and offers no way to
 * see is a preference someone will eventually set by accident and never find
 * again.
 *
 * Retention used to live here and now lives in Storage, beside the folders it
 * governs. That move is most of why this category is worth having at all: what
 * is left is genuinely "general", rather than "the one setting we had".
 *
 * The Protection switch (VC-480) is an experiment's door, not a chrome
 * preference: while it is on, Configure's Authority entry draws the simple
 * Protection page instead. It lives here because it is app-wide, and it reads
 * disabled until main has said which way it is set.
 */
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";

import { PrefRow, PrefSection } from "@renderer/components/settings/kit";
import { Switch } from "@renderer/components/ui/switch";
import { useProtectionSetting, useProtectionStore } from "@renderer/stores/protection";
import { useUiStore } from "@renderer/stores/ui";

export function GeneralPane() {
  const workspaceRailHidden = useUiStore((store) => store.workspaceRailHidden);
  const setWorkspaceRailHidden = useUiStore((store) => store.setWorkspaceRailHidden);
  const sidebarPinned = useUiStore((store) => store.sidebarPinned);
  const setSidebarPinned = useUiStore((store) => store.setSidebarPinned);
  const protection = useProtectionSetting();
  const setProtection = useProtectionStore((store) => store.setEnabled);

  return (
    <PrefSection title="Window" icon={GearSixIcon}>
      {/*
       * Stated as the POSITIVE. The flag is `workspaceRailHidden`, but a switch
       * labelled "Hide the project switcher" that is ON when the thing is
       * absent is a double negative every reader has to unpick.
       */}
      <PrefRow label="Show the project switcher" htmlFor="project-switcher">
        <Switch
          id="project-switcher"
          checked={!workspaceRailHidden}
          onCheckedChange={(shown) => setWorkspaceRailHidden(!shown)}
        />
      </PrefRow>
      <PrefRow
        label="Keep the sidebar open"
        htmlFor="sidebar-pinned"
        hint={<>When off, the sidebar opens when the pointer reaches the edge.</>}
      >
        <Switch id="sidebar-pinned" checked={sidebarPinned} onCheckedChange={setSidebarPinned} />
      </PrefRow>
      <PrefRow label="Protection (experimental)" htmlFor="protection-experiment">
        <Switch
          id="protection-experiment"
          checked={protection === true}
          disabled={protection === null}
          onCheckedChange={(next) => void setProtection(next)}
        />
      </PrefRow>
    </PrefSection>
  );
}
