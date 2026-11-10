// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  type ChatSessionRecord,
  type SessionProvenance,
} from "@volli/shared";
import type { ModelCatalogue } from "@renderer/lib/use-model-catalogue";
import { HomeTabStrip } from "@renderer/components/home/home-tab-strip";
import { TicketTabStrip } from "@renderer/components/ticket/ticket-tabs";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

const held = vi.hoisted(() => ({ catalogue: null as ModelCatalogue | null }));
vi.mock("@renderer/lib/use-model-catalogue", () => ({ useModelCatalogue: () => held.catalogue }));
const noop = () => {};
const providerId = "qwen-token-plan-individual";
const providerLabel = "Qwen Token Plan Individual";
const provenance: SessionProvenance = {
  kind: "automation",
  automationRunId: null,
  automationName: "Nightly sweep",
};
const record: ChatSessionRecord = {
  sessionId: "s1",
  title: "Review",
  projectId: "p1",
  ticketId: null,
  createdAt: 1,
  adapterId: null,
  live: false,
  activity: "idle",
  waitingOn: null,
  outcome: null,
  lastActivityAt: 1,
  bornTicketless: true,
  role: "project",
  parentSessionId: null,
  model: { providerId, modelId: "qwen3", reasoningLevel: "high" },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  held.catalogue = {
    models: [],
    providers: [
      {
        id: providerId,
        label: providerLabel,
        state: "available",
        accountLabel: null,
        billingSource: "unknown",
        recovery: null,
        signIn: [],
        hasStoredCredential: true,
      },
    ],
  };
  useChatSessionsStore.setState({ sessions: {} });
  useProjectSessionsStore.setState({
    byProject: { p1: { terminal: [], chat: [record], provenance: { s1: provenance } } },
  });
  useTicketSessionRecordsStore.setState({
    byTicket: {
      t1: [
        {
          kind: "chat",
          record: { ...record, ticketId: "t1" },
          usage: EMPTY_SESSION_USAGE_SUMMARY,
          provenance,
        },
      ],
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectSessionsStore.setState({ byProject: {} });
  useTicketSessionRecordsStore.setState({ byTicket: {} });
  useChatSessionsStore.setState({ sessions: {} });
  vi.unstubAllGlobals();
});
async function mount(surface: "Home" | "Ticket") {
  await act(async () =>
    root.render(
      surface === "Home" ? (
        <HomeTabStrip
          projectId="p1"
          tabs={[{ kind: "chat", id: "chat:s1", sessionId: "s1", title: "Review", status: "idle" }]}
          activeTabId="chat:s1"
          onSelect={noop}
          onClose={noop}
          onRename={noop}
          onPinFile={noop}
          onCloseOtherFiles={noop}
          onNewSession={noop}
          onNewChat={noop}
          onNewBrowser={noop}
          creating={false}
          railCollapsed={false}
          railTogglable
          onToggleRail={noop}
        />
      ) : (
        <TicketTabStrip
          projectId="p1"
          ticketId="t1"
          tabs={[{ kind: "chat", id: "chat:s1", label: "Review", status: "idle" }]}
          activeTabId="chat:s1"
          onSelectTab={noop}
          onCloseTab={noop}
          onRenameSessionTab={noop}
          onNewSession={noop}
          onNewChat={noop}
          onNewBrowser={noop}
          creating={false}
          railCollapsed={false}
          onToggleRail={noop}
        />
      ),
    ),
  );
  return container.querySelector<HTMLElement>('[role="tab"]')!;
}
describe("provider help receiving callers", () => {
  it.each(["Home", "Ticket"] as const)(
    "wires %s tabs to catalogue names and the existing help anchor",
    async (surface) => {
      const tab = await mount(surface);
      expect(tab.getAttribute("aria-label")).toBe(`Review · ${providerLabel}`);
      expect(tab.hasAttribute("title")).toBe(false);
      const mark = tab.querySelector("[data-session-glyph]")!;
      expect(mark.getAttribute("aria-label")).toContain(providerLabel);
      expect(mark.hasAttribute("tabindex")).toBe(false);
      expect(mark.querySelector('[data-slot="help-tag"]')).toBeNull();
      expect(tab.querySelector('[data-slot="tab-label"]')?.textContent).toBe("Review");
      await act(async () => tab.focus());
      const help = document.body.querySelector('[data-slot="tooltip-content"]');
      expect(help?.textContent).toContain(providerLabel);
      expect(help?.textContent).toContain("Automation · Nightly sweep");
      expect(document.body.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1);
    },
  );
});
