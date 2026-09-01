// @vitest-environment jsdom
/**
 * Who started the Session a Home tab names (VC-131).
 *
 * Home and a ticket workspace are the same object at two scopes, and this strip
 * is the same header — so a Session that gained or lost its mark by being
 * opened from Home rather than from a Ticket would be the rule "everywhere a
 * Session appears" failing at exactly the seam it was written for. A Project
 * Session is also the case a Run's fan-out produces most often.
 *
 * jsdom rather than a static render, and the store seeded per case, for the
 * reason `ticket/ticket-tab-provenance.test.tsx` gives: zustand's server
 * snapshot is the store's initial state, so a static render cannot see a seed.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionProvenance } from "@volli/shared";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import type { SessionTab } from "@renderer/stores/sessions";
import { HOME_BOARD_TAB, HomeTabStrip, type HomeTabDescriptor } from "./home-tab-strip";

const noop = (): void => {};

const RUN: SessionProvenance = { kind: "automation", automationName: "Nightly sweep" };

const TERMINAL_TAB: SessionTab = {
  sessionId: "session-run",
  title: "Nightly sweep",
  scope: { kind: "project", projectId: "project-1" },
  layout: { kind: "pane", sessionId: "session-run", exitCode: null },
  activePaneId: "session-run",
};

const CHAT: HomeTabDescriptor = {
  kind: "chat",
  id: "chat:session-run",
  sessionId: "session-run",
  title: "Fix the flaky worktree test",
  status: "working",
};
const TERMINAL: HomeTabDescriptor = {
  kind: "terminal",
  id: "session-run",
  tab: TERMINAL_TAB,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function seed(provenance: Record<string, SessionProvenance>): void {
  useProjectSessionsStore.setState({
    byProject: { "project-1": { terminal: [], chat: [], provenance } },
  });
}

async function mount(tabs: readonly HomeTabDescriptor[]): Promise<string> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <HomeTabStrip
          projectId="project-1"
          tabs={tabs}
          activeTabId={HOME_BOARD_TAB.id}
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
      </TooltipProvider>,
    );
  });
  return container.innerHTML;
}

function tab(label: string): HTMLElement {
  const found = document.querySelector(`[role="tab"][aria-label="${label}"]`);
  if (found === null) throw new Error(`no tab labelled ${label}`);
  return found as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useProjectSessionsStore.setState({ byProject: {} });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  useProjectSessionsStore.setState({ byProject: {} });
  vi.unstubAllGlobals();
});

describe("a Home Session tab's provenance", () => {
  it("marks a chat tab a Run opened, in the same words the ticket strip uses", async () => {
    seed({ "session-run": RUN });

    const html = await mount([HOME_BOARD_TAB, CHAT]);

    expect(html).toContain('aria-label="Started by the Automation Nightly sweep"');
    expect(tab("Fix the flaky worktree test").getAttribute("title")).toBe(
      "Fix the flaky worktree test\nAutomation · Nightly sweep",
    );
  });

  it("marks a terminal tab the same way", async () => {
    seed({ "session-run": RUN });

    const html = await mount([HOME_BOARD_TAB, TERMINAL]);

    expect(html).toContain('aria-label="Started by the Automation Nightly sweep"');
  });

  it("names the parent Session in the tooltip, and mints no glyph for it", async () => {
    seed({
      "session-run": {
        kind: "session",
        parentSessionId: "session-parent",
        parentTitle: "Orchestrator",
      },
    });

    const html = await mount([HOME_BOARD_TAB, CHAT]);

    expect(tab("Fix the flaky worktree test").getAttribute("title")).toBe(
      "Fix the flaky worktree test\nStarted by Orchestrator",
    );
    expect(html).not.toContain("Started by the Automation");
  });

  it("leaves a person's Session tab exactly as it was", async () => {
    seed({ "session-run": RUN });
    const marked = await mount([HOME_BOARD_TAB, CHAT]);
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    seed({});
    const resting = await mount([HOME_BOARD_TAB, CHAT]);

    expect(resting).not.toContain("Started by");
    expect(resting.length).toBeLessThan(marked.length);
  });
});
