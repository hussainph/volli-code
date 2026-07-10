import { BoardPage } from "@renderer/components/pages/board-page";
import { FilesPage } from "@renderer/components/pages/files-page";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { SessionsLayer } from "@renderer/components/sessions/sessions-layer";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useUiStore } from "@renderer/stores/ui";

/** No router: the selected project's nav page dispatches directly to a page component. */
export function MainContent() {
  const selected = useSelectedProject();
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
        ) : selected === null ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a project</p>
          </div>
        ) : activeNav === "board" ? (
          <BoardPage />
        ) : activeNav === "files" ? (
          <FilesPage />
        ) : null /* sessions: rendered by the always-mounted SessionsLayer above */
      }
    </div>
  );
}
