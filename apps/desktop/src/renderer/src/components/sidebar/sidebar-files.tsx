import type { Project } from "@volli/shared";
import { FileTreeNavigator } from "@renderer/components/files/file-tree-navigator";
import { useUiStore } from "@renderer/stores/ui";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { fileTabId, parseFileTabId } from "@renderer/components/ticket/ticket-file-tab";
import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";

/** Read the same takeover condition Home uses; a parked ticket is not scope. */
export function SidebarFiles({ project }: { project: Project }) {
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const ticketId = useProjectUiStore((state) => {
    const workspace = state.byProject[project.id];
    return !settingsOpen &&
      workspace?.nav === "home" &&
      workspace.homeActiveTab === HOME_BOARD_TAB_ID
      ? workspace.openTicketId
      : null;
  });
  const ticket = useBoardStore((state) =>
    state.ticketsByProject[project.id]?.find((row) => row.id === ticketId),
  );
  const selected = useProjectUiStore((state) =>
    ticket
      ? parseFileTabId(state.byProject[project.id]?.ticketTabs[ticket.id]?.active ?? "")
      : state.byProject[project.id]?.projectFiles.activeRelPath,
  );
  const open = (path: string) => {
    useUiStore.getState().setSettingsOpen(false);
    const workspace = useProjectUiStore.getState();
    if (ticket) {
      workspace.pinTicketFile(project.id, ticket.id, path);
      workspace.setTicketActiveTab(project.id, ticket.id, fileTabId(path));
    } else workspace.pinHomeFile(project.id, path);
  };
  return (
    <FileTreeNavigator
      projectId={project.id}
      ticketId={ticket?.id}
      root={ticket ? (ticket.branch ?? ticket.baseBranch ?? "No branch yet") : project.name}
      available={!ticket || ticket.worktreePath !== null}
      selected={selected}
      onOpen={open}
      onPin={open}
      onRename={(from, to) => {
        const workspace = useProjectUiStore.getState();
        if (ticket) workspace.renameTicketFile(project.id, ticket.id, from, to);
        else workspace.renameHomeFile(project.id, from, to);
      }}
    />
  );
}
