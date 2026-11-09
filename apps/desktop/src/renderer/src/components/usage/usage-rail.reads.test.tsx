// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { HomeUsageRailFooter, TicketUsageRailFooter } from "./usage-rail";
import { InspectorVisibleContext } from "../sidebar/inspector-host";

const state = vi.hoisted(() => ({
  visible: false,
  revision: 0,
  refresh: vi.fn(async (_query: unknown, _signal: string) => {}),
  ensure: vi.fn(async () => {}),
}));
vi.mock("@renderer/stores/ui", () => ({
  useUiStore: (select: (value: unknown) => unknown) =>
    select({ costVisible: state.visible, railFolds: { usage: false } }),
}));
vi.mock("@renderer/stores/chat-sessions", () => ({
  useChatSessionsStore: (select: (value: unknown) => unknown) =>
    select({ settleRevision: state.revision }),
}));
vi.mock("@renderer/stores/project-sessions", () => ({
  useProjectSessionsStore: (select: (value: unknown) => unknown) =>
    select({ ensure: state.ensure, byProject: {} }),
}));
vi.mock("@renderer/stores/ticket-session-records", () => ({
  useTicketSessionRecordsStore: (select: (value: unknown) => unknown) => select({ byTicket: {} }),
}));
vi.mock("@renderer/stores/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@renderer/stores/usage")>()),
  useUsageStore: Object.assign(() => undefined, { getState: () => ({ refresh: state.refresh }) }),
}));
vi.mock("./usage-model-catalogue", () => ({ useUsageModelCatalogue: () => [] }));
vi.mock("./home-usage-block", () => ({ HomeUsageFooter: () => null }));
vi.mock("./ticket-usage-block", () => ({ TicketUsageBlock: () => null }));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(node));
  return { rerender: (next: ReactNode) => act(() => root.render(next)) };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.visible = false;
  state.revision = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("usage request preference gate", () => {
  it("defers a hidden resident inspector and revalidates under its latest signal on reveal", () => {
    state.visible = true;
    const content = (
      <>
        <HomeUsageRailFooter projectId="p" sessionId="s" />
        <TicketUsageRailFooter ticketId="t" />
      </>
    );
    const view = render(
      <InspectorVisibleContext.Provider value={false}>{content}</InspectorVisibleContext.Provider>,
    );
    state.revision++;
    view.rerender(
      <InspectorVisibleContext.Provider value={false}>{content}</InspectorVisibleContext.Provider>,
    );
    expect(state.refresh).not.toHaveBeenCalled();
    view.rerender(
      <InspectorVisibleContext.Provider value={true}>{content}</InspectorVisibleContext.Provider>,
    );
    expect(state.refresh).toHaveBeenCalledTimes(4);
    expect(state.refresh.mock.calls.every((call) => call[1] === "1")).toBe(true);
    state.refresh.mockClear();
    view.rerender(
      <InspectorVisibleContext.Provider value={false}>{content}</InspectorVisibleContext.Provider>,
    );
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("spends no reports while disabled, even as lifecycle activity changes", () => {
    const view = render(
      <>
        <HomeUsageRailFooter projectId="p" sessionId="s" />
        <TicketUsageRailFooter ticketId="t" />
      </>,
    );
    state.revision++;
    view.rerender(
      <>
        <HomeUsageRailFooter projectId="p" sessionId="s" />
        <TicketUsageRailFooter ticketId="t" />
      </>,
    );
    expect(state.refresh).not.toHaveBeenCalled();
    state.visible = true;
    view.rerender(
      <>
        <HomeUsageRailFooter projectId="p" sessionId="s" />
        <TicketUsageRailFooter ticketId="t" />
      </>,
    );
    expect(state.refresh).toHaveBeenCalledTimes(4);
    expect(state.refresh).toHaveBeenCalledWith(
      { scope: { kind: "project", projectId: "p" }, windowMs: 30 * 86_400_000, groupBy: "model" },
      "1",
    );
    expect(state.refresh).toHaveBeenCalledWith(
      { scope: { kind: "session", sessionId: "s" }, windowMs: 30 * 86_400_000 },
      "1",
    );
    expect(state.refresh).toHaveBeenCalledWith(
      { scope: { kind: "ticket", ticketId: "t" }, groupBy: "session" },
      "1",
    );
    expect(state.refresh).toHaveBeenCalledWith(
      { scope: { kind: "ticket", ticketId: "t" }, groupBy: "model" },
      "1",
    );
  });
});
