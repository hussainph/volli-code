import { BoardPage } from "@renderer/components/pages/board-page";
import { FilesPage } from "@renderer/components/pages/files-page";
import { SessionsPage } from "@renderer/components/pages/sessions-page";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useUiStore } from "@renderer/stores/ui";

/** No router: the selected project's nav page dispatches directly to a page component. */
export function MainContent() {
  const selected = useSelectedProject();
  const [activeNav] = useActiveNav();
  const settingsOpen = useUiStore((state) => state.settingsOpen);

  // Settings is app-wide chrome, checked before the no-project state: it
  // covers whichever workspace page is active and needs no project at all.
  if (settingsOpen) {
    return <SettingsPage />;
  }

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Select a project</p>
      </div>
    );
  }

  // Keep-alive seam: today these pages are stateless placeholders, so a plain
  // conditional render is fine. Any page that ever hosts a live terminal must
  // NOT be unmounted on nav switches — convert it to render-hidden
  // (display:none) at this seam instead (CLAUDE.md: never unmount a live
  // terminal incidentally).
  switch (activeNav) {
    case "board":
      return <BoardPage />;
    case "sessions":
      return <SessionsPage />;
    case "files":
      return <FilesPage />;
  }
}
