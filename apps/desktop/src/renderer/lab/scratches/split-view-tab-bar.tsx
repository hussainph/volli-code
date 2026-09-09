/** Real Home/Ticket surfaces; browser chrome is real, native page pixels are absent in the lab. */
import * as React from "react";
import { SPLIT_VIEW_ROOT_PANE_ID } from "@volli/shared";
import type { BrowserTabState } from "../../../ipc/contract";

import { AppShell } from "@renderer/components/app-shell";
import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { Button } from "@renderer/components/ui/button";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useWorkspaceStore } from "@renderer/stores/workspace";

import { project, tickets } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Split view · shared main bar";
export const note =
  "Real Home/Ticket tabs: right, down, mixed, resizing and rail alignment. Native pages are not rendered.";
export const viewport = "window" as const;

const ticketId = tickets[0]!.id;
const browserTabs: BrowserTabState[] = [null, ticketId].flatMap((owner) =>
  [1, 2].map((index) => ({
    tabId: `${owner ?? "home"}-${index}`,
    projectId: project.id,
    ticketId: owner,
    createdBy: "user" as const,
    ownerSessionId: null,
    presentation: "tab" as const,
    url: `https://example.com/${index}`,
    title: index === 1 ? "Inside a Volli context" : "Reference notes",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 0,
    heldBy: null,
  })),
);

export const api = {
  ...appApi,
  shells: { list: async () => ({ ok: true, shells: [] }) },
  browser: {
    list: async () => ({ ok: true, tabs: browserTabs }),
    show: async () => ({ ok: true }),
    hide: async () => ({ ok: true }),
    setBounds: async () => ({ ok: true }),
    capture: async () => ({ ok: true, frames: [] }),
  },
};

type Layout = "Unsplit" | "Right" | "Down" | "Mixed";
function arrange(ticket: boolean, layout: Layout) {
  seedApp();
  useBrowserTabsStore.setState({
    byId: Object.fromEntries(browserTabs.map((tab) => [tab.tabId, tab])),
    hydratedProjects: new Set([project.id]),
  });
  const store = useWorkspaceStore.getState();
  const owner = ticket ? ticketId : "home";
  const primary = ticket ? TICKET_BODY_TAB_ID : HOME_BOARD_TAB_ID;
  const ids = [primary, `browser:${owner}-1`, `browser:${owner}-2`];
  if (ticket) store.openTicketWorkspace(project.id, ticketId);
  if (layout === "Unsplit") return;
  const split = (paneId: string, edge: "right" | "down", tabId: string) => {
    const opts = { tabId, surfaceTabIds: ids };
    if (ticket) store.splitTicketPane(project.id, ticketId, paneId, edge, opts);
    else store.splitHomePane(project.id, paneId, edge, opts);
  };
  split(SPLIT_VIEW_ROOT_PANE_ID, layout === "Down" ? "down" : "right", ids[1]!);
  if (layout === "Mixed") {
    const ui = useWorkspaceStore.getState().byProject[project.id]!;
    const view = ticket ? ui.ticketTabs[ticketId]?.splitView : ui.homeSplitView;
    split(view!.focusedPaneId, "down", ids[2]!);
  }
}
export const seed = () => arrange(false, "Right");

export default function SplitViewTabBarScratch() {
  const [ticket, setTicket] = React.useState(false);
  const [layout, setLayout] = React.useState<Layout>("Right");
  return (
    <>
      <AppShell />
      <div className="fixed bottom-4 left-20 z-50 flex gap-2 rounded-container border border-border bg-card p-2 shadow-overlay">
        <Button
          variant="outline"
          onClick={() => {
            setTicket(!ticket);
            arrange(!ticket, layout);
          }}
        >
          {ticket ? "Ticket" : "Home"}
        </Button>
        {(["Unsplit", "Right", "Down", "Mixed"] as const).map((next) => (
          <Button
            key={next}
            variant={layout === next ? "default" : "ghost"}
            onClick={() => {
              setLayout(next);
              arrange(ticket, next);
            }}
          >
            {next}
          </Button>
        ))}
      </div>
    </>
  );
}
