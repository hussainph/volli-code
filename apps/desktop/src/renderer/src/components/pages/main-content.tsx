import type { ReactNode } from "react";
import { FolderPlusIcon } from "@phosphor-icons/react/dist/csr/FolderPlus";

import { AutomationsPage } from "@renderer/components/automations/automations-page";
import { HomeSurface } from "@renderer/components/home/home-surface";
import { ConfigurePage } from "@renderer/components/pages/configure-page";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { SessionEnvironmentAlert } from "@renderer/components/session-environment-alert";
import { WorkspaceDependenciesOffer } from "@renderer/components/workspace-dependencies-offer";
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
  const projectCount = useProjectsStore((state) => state.projects.length);
  const [activeNav] = useActiveNav();
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const settingsCategory = useUiStore((state) => state.settingsCategory);
  const settingsSignInProviderId = useUiStore((state) => state.settingsSignInProviderId);

  // Keep-alive seam (CLAUDE.md: never unmount a live terminal incidentally).
  // Home hosts the layer that owns every live PTY terminal in the app, so it is
  // ALWAYS mounted and merely hidden via CSS — switching nav, switching
  // projects, or opening Settings must not tear its terminals down. Configure
  // and Settings are stateless, so they keep plain conditional rendering.
  const homeVisible = !settingsOpen && selected !== null && activeNav === "home";

  if (override !== undefined) {
    return <div className="relative flex min-h-0 flex-1 flex-col">{override}</div>;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <SessionEnvironmentAlert />
      {/* Under the fault surface, because it is not one: an uninstalled
          workspace is a normal state with an action attached, and it must
          never be the loudest thing on a freshly added project (VC-156). */}
      <WorkspaceDependenciesOffer />
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
        ) : selected === null && projectCount === 0 ? (
          <EmptyProjectsState />
        ) : selected === null ? (
          <div className={cn("flex-1", EMPTY_PAGE)}>
            <p className="text-sm text-muted-foreground">Select a project</p>
          </div>
        ) : activeNav === "configure" ? (
          <ConfigurePage />
        ) : activeNav === "automations" ? (
          // Stateless like Configure, so plain conditional rendering: nothing
          // on this page owns a live PTY, and it re-reads its record on mount.
          <AutomationsPage />
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
      <div className="relative z-10 flex max-w-sm flex-col items-center">
        {/* The frame is the glyph plus its inset — 20 + 8 + 8 — so a bigger
            or smaller icon moves the box instead of overflowing a fixed one. */}
        <div className="mb-4 flex items-center justify-center rounded-xl border border-border bg-card/70 p-2 shadow-raised">
          <FolderPlusIcon className="size-5 text-muted-foreground" />
        </div>
        <h1 className="text-title font-semibold">Add your first project</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Pick a folder with a git repo.
        </p>
        <Button className="mt-6 app-region-no-drag" onClick={() => void pickAndAdd()}>
          Add Project…
        </Button>
      </div>
    </div>
  );
}
