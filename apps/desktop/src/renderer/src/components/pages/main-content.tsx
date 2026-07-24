import { FolderPlusIcon } from "@phosphor-icons/react/dist/csr/FolderPlus";

import { BoardPage } from "@renderer/components/pages/board-page";
import { ConfigurePage } from "@renderer/components/pages/configure-page";
import { FilesPage } from "@renderer/components/pages/files-page";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { SessionsLayer } from "@renderer/components/sessions/sessions-layer";
import { Button } from "@renderer/components/ui/button";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import { useAddProject } from "@renderer/hooks/use-add-project";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

/** No router: the selected project's nav page dispatches directly to a page component. */
export function MainContent() {
  const selected = useSelectedProject();
  const projectCount = useProjectsStore((state) => state.projects.length);
  const [activeNav] = useActiveNav();
  const settingsOpen = useUiStore((state) => state.settingsOpen);

  // Keep-alive seam (CLAUDE.md: never unmount a live terminal incidentally).
  // The Sessions surface hosts live PTY terminals, so it is ALWAYS mounted and
  // merely hidden via CSS — switching nav (Board/Files), switching projects, or
  // opening Settings must not tear its terminals down. Board/Files/Settings are
  // stateless, so they keep plain conditional rendering. `SessionsLayer` owns
  // every terminal across all projects and toggles its own visibility.
  const sessionsVisible = !settingsOpen && selected !== null && activeNav === "sessions";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <SessionsLayer visible={sessionsVisible} />
      {
        settingsOpen ? (
          <SettingsPage />
        ) : selected === null && projectCount === 0 ? (
          <EmptyProjectsState />
        ) : selected === null ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a project</p>
          </div>
        ) : activeNav === "board" ? (
          <BoardPage />
        ) : activeNav === "files" ? (
          <FilesPage />
        ) : activeNav === "configure" ? (
          <ConfigurePage />
        ) : null /* sessions: rendered by the always-mounted SessionsLayer above */
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
      className="empty-projects-canvas relative flex flex-1 items-center justify-center overflow-hidden px-6"
    >
      <div className="relative z-10 flex max-w-sm flex-col items-center text-center">
        <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-border bg-card/70 shadow-sm">
          <FolderPlusIcon className="size-5 text-muted-foreground" weight="regular" />
        </div>
        <h1 className="text-title font-semibold">Add your first project</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Choose a local codebase to start planning work.
        </p>
        <Button className="mt-6 app-region-no-drag" onClick={() => void pickAndAdd()}>
          Add Project…
        </Button>
      </div>
    </div>
  );
}
