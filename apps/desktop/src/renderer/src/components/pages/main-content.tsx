import { BoardPage } from "@renderer/components/pages/board-page";
import { FilesPage } from "@renderer/components/pages/files-page";
import { SessionsPage } from "@renderer/components/pages/sessions-page";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";

/** No router: the selected project's nav page dispatches directly to a page component. */
export function MainContent() {
  const selected = useSelectedProject();
  const [activeNav] = useActiveNav();

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
    case "settings":
      return <SettingsPage />;
  }
}
