// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatSessionRecord, Project, SessionRecord } from "@volli/shared";

import { HomeRail } from "./home-rail";
import { HOME_BOARD_TAB_ID } from "./home-tabs";
import { useAgeNow } from "@renderer/lib/use-age-now";

vi.mock("@renderer/lib/use-age-now", async (importOriginal) => {
  const original = await importOriginal<typeof import("@renderer/lib/use-age-now")>();
  return { useAgeNow: vi.fn(original.useAgeNow) };
});
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore, DEFAULT_RAIL_FOLDS } from "@renderer/stores/ui";

// The checkout and cost have independent reads, unrelated to the roster clock.
vi.mock("@renderer/components/home/home-rail-footer", () => ({ HomeCheckoutFooter: () => null }));
vi.mock("@renderer/components/usage/usage-rail", () => ({ HomeUsageRailFooter: () => null }));

const NOW = new Date(2026, 6, 14, 12).getTime();
const project: Project = {
  id: "p1",
  name: "Project",
  path: "/code/project",
  ticketPrefix: "P",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};
function chat(
  id: string,
  at: number,
  activity: ChatSessionRecord["activity"] = "idle",
): ChatSessionRecord {
  return {
    sessionId: id,
    title: id,
    projectId: "p1",
    ticketId: null,
    createdAt: at,
    adapterId: "pi",
    live: true,
    activity,
    waitingOn: null,
    outcome: null,
    lastActivityAt: at,
    bornTicketless: true,
    role: "project",
    parentSessionId: null,
    model: null,
  };
}
let root: Root;
let container: HTMLDivElement;
const renders = vi.mocked(useAgeNow);

async function mount(rows: ChatSessionRecord[], terminals: SessionRecord[] = []) {
  useProjectSessionsStore.setState({
    byProject: { p1: { terminal: terminals, chat: rows, provenance: {} } },
    listingState: { p1: "loaded" },
  });
  await act(async () =>
    root.render(
      <TooltipProvider>
        <HomeRail project={project} activeTabId={HOME_BOARD_TAB_ID} />
      </TooltipProvider>,
    ),
  );
  // Radix settles its mount-only animation frames before the quiet window.
  await advance(100);
  renders.mockClear();
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useUiStore.setState({ homeRailMode: "now", railFolds: DEFAULT_RAIL_FOLDS });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProjectSessionsStore.setState({ byProject: {}, listingState: {} });
  useSessionsStore.setState({ byOwner: {}, lastOutputAt: {}, parkState: {}, harness: {} });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Home roster age boundaries", () => {
  it("still wakes when a terminal's status will make it match the filter", async () => {
    useSessionsStore.setState({
      byOwner: {
        p1: {
          activeSessionId: "terminal",
          tabs: [
            {
              sessionId: "terminal",
              title: "Build",
              scope: { kind: "project", projectId: "p1" },
              activePaneId: "terminal",
              layout: { kind: "pane", sessionId: "terminal", exitCode: null },
            },
          ],
        },
      },
      lastOutputAt: { terminal: NOW },
    });
    await mount(
      [1, 2, 3, 4].map((id) => chat(`Chat ${id}`, NOW - 30_000, "working")),
      [
        {
          id: "terminal",
          projectId: "p1",
          ticketId: null,
          harnessId: "claude-code",
          activeHarnessId: null,
          harnessSessionId: null,
          launchKind: "shell",
          placement: "tab",
          title: "Build",
          cwd: "/code/project",
          createdAt: NOW - 30_000,
          endedAt: null,
          exitCode: null,
          lastActivityAt: NOW - 30_000,
          bornTicketless: true,
        },
      ],
    );
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "idle",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("No matching sessions");
    renders.mockClear();
    await advance(10_002);
    expect(container.textContent).not.toContain("No matching sessions");
    expect(container.querySelector('[data-testid="home-sessions-live"]')?.textContent).toContain(
      "BuildIdle",
    );
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("advances now → 1m without store changes, with one render over a quiet minute", async () => {
    await mount([chat("First", NOW - 30_000), chat("Second", NOW - 30_000)]);
    expect(container.textContent?.match(/· now/g)).toHaveLength(2);
    await advance(14_000);
    expect(renders).not.toHaveBeenCalled();
    await advance(17_000);
    expect(container.textContent?.match(/· 1m/g)).toHaveLength(2);
    expect(renders).toHaveBeenCalledTimes(1);
    await advance(29_000);
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("does not wake for folded stamps and reads their current age on opening", async () => {
    await mount([chat("Earlier", NOW - 30_000, "stopped")]);
    await advance(31_000);
    expect(renders).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="home-sessions-fold"]')?.click();
    });
    expect(container.querySelector('[data-testid="home-sessions-earlier"]')?.textContent).toContain(
      "· 1m",
    );
  });
});
