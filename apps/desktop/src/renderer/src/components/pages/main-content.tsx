import { useEffect, type ReactNode } from "react";
import { AddFolderIcon } from "@renderer/components/ui/icon";

import { AutomationsPage } from "@renderer/components/automations/automations-page";
import { HomeSurface } from "@renderer/components/home/home-surface";
import { CloudMoveReadOnlyBanner } from "@renderer/components/cloud-moves/cloud-moves";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { SessionEnvironmentAlert } from "@renderer/components/session-environment-alert";
import { WorkspaceDependenciesOffer } from "@renderer/components/workspace-dependencies-offer";
import { AutomationsOnly } from "@renderer/components/automations/automation-availability";
import { LocalOnly } from "@renderer/components/hosts/local-only";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import { useAddProject } from "@renderer/hooks/use-add-project";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { cn } from "@renderer/lib/utils";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

/** No router: the selected project's nav page dispatches directly to a page component. */
export function MainContent({ override }: { override?: ReactNode } = {}) {
  const selected = useSelectedProject();
  const pending = useProjectsStore((state) => state.pendingRemoteSelection);
  const projectCount = useProjectsStore((state) => state.projects.length);
  const [activeNav, setActiveNav] = useActiveNav();
  // Old navigation-history entries redirect; Configure is no longer a page.
  useEffect(() => {
    if (activeNav !== "configure") return;
    useUiStore.getState().requestConfigureCategory("overview");
    setActiveNav("home");
  }, [activeNav, setActiveNav]);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const settingsCategory = useUiStore((state) => state.settingsCategory);
  const settingsSignInProviderId = useUiStore((state) => state.settingsSignInProviderId);

  // Keep-alive seam (CLAUDE.md: never unmount a live terminal incidentally).
  // Home hosts the layer that owns every live PTY terminal in the app, so it is
  // ALWAYS mounted and merely hidden via CSS — switching nav, switching
  // projects, or opening Settings must not tear its terminals down. Settings
  // has no process lifetime, so it keeps plain conditional rendering.
  const homeVisible = !settingsOpen && selected !== null && activeNav === "home";

  if (override !== undefined) {
    return <div className="relative flex min-h-0 flex-1 flex-col">{override}</div>;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <CloudMoveReadOnlyBanner />
      {/* Both measure THIS Mac's tools in the project's folder: a remote
          project's folder is on its host (VC-711), so neither runs for it. */}
      <LocalOnly projectId={selected?.id ?? null} fallback={null}>
        <SessionEnvironmentAlert />
      </LocalOnly>
      {/* Under the fault surface, because it is not one: an uninstalled
          workspace is a normal state with an action attached, and it must
          never be the loudest thing on a freshly added project (VC-156). */}
      <LocalOnly projectId={selected?.id ?? null} fallback={null}>
        <WorkspaceDependenciesOffer />
      </LocalOnly>
      {/* Home renders its own strip, its board (or the ticket that has taken it
          over) and its Session planes, in that DOM order, so the strip is the
          top edge of whatever is below it. It is a fragment on purpose: it
          shares this flex column rather than nesting one inside it. */}
      <HomeSurface visible={homeVisible} />
      {
        settingsOpen ? (
          <SettingsPage
            initialCategoryKey={settingsCategory ?? undefined}
            initialSignInProviderId={settingsSignInProviderId ?? undefined}
          />
        ) : pending !== null ? (
          <div className={cn("flex-1", EMPTY_PAGE)} />
        ) : selected === null && projectCount === 0 ? (
          <EmptyProjectsState />
        ) : selected === null ? (
          <div className={cn("flex-1", EMPTY_PAGE)}>
            <h2 className="text-heading font-semibold text-foreground">Select a project</h2>
          </div>
        ) : activeNav === "automations" ? (
          // Plain conditional rendering: nothing
          // on this page owns a live PTY, and it re-reads its record on mount.
          <AutomationsOnly projectId={selected.id}>
            <AutomationsPage />
          </AutomationsOnly>
        ) : null /* home: rendered by the always-mounted HomeSurface above */
      }
    </div>
  );
}

/**
 * The only explanatory first-run surface. The rail's compact plus button stays
 * available as a shortcut, but this canvas owns the next step and avoids
 * competing empty-state messages in the sidebar and content area.
 */
function EmptyProjectsState() {
  const pickAndAdd = useAddProject();

  return (
    <div
      data-empty-projects-state
      className={cn("empty-projects-canvas relative flex-1 overflow-hidden", EMPTY_PAGE)}
    >
      <AddFolderIcon aria-hidden className="size-6 text-muted-foreground" />
      <h1 className="text-heading font-semibold">Add your first project</h1>
      <Button className="mt-2 app-region-no-drag" onClick={() => void pickAndAdd()}>
        Add project
      </Button>
    </div>
  );
}
