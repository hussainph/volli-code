// @vitest-environment jsdom
/**
 * Who started the Session this tab NAMES (VC-131).
 *
 * The tab strip is the Session's header — `chat-plane.tsx` says so in as many
 * words ("There is no header: the tab already names the Session and carries its
 * liveness") — and VC-112 names that header as a surface provenance must reach.
 * So "everywhere a Session appears" lands here as much as on the rail: an open
 * Run Session that lost its bolt the moment you opened it would be a Session
 * whose provenance depended on which surface you happened to be looking at.
 *
 * A real jsdom ENVIRONMENT rather than `renderToStaticMarkup`, for a reason
 * specific to what is being tested: the strip reads provenance out of the
 * shared project-sessions store at the leaf, and zustand's server snapshot is
 * the store's INITIAL state — a static render would therefore report the
 * resting case for every seed and pass whatever this file asserted. Reading it
 * at the leaf is the design (a tab descriptor needs no new field, and a Run
 * that starts while the strip is open marks itself), so the test has to be able
 * to see a live store.
 *
 * Each seed writes the project's rows, which also keeps the hook's `ensure`
 * from reaching for an IPC door: a project already in the cache is not fetched.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionProvenance } from "@volli/shared";

import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { TicketTabStrip, type TicketTabDescriptor } from "./ticket-tabs";

const noop = (): void => {};

const RUN: SessionProvenance = { kind: "automation", automationName: "Nightly sweep" };
const CHILD: SessionProvenance = {
  kind: "session",
  parentSessionId: "session-parent",
  parentTitle: "Orchestrator",
};

const BODY: TicketTabDescriptor = { id: "doc", kind: "body", label: "VC-6" };
const CHAT: TicketTabDescriptor = {
  id: "chat:session-run",
  kind: "chat",
  label: "Fix the flaky worktree test",
  status: "working",
};
const TERMINAL: TicketTabDescriptor = {
  id: "session-run",
  kind: "session",
  label: "Nightly sweep",
};
const FILE: TicketTabDescriptor = {
  id: "file:src/app.ts",
  kind: "file",
  label: "app.ts",
  relPath: "src/app.ts",
  badge: "worktree",
};

let root: Root | null = null;
let container: HTMLElement | null = null;

/** Seeds the one store the strip reads provenance out of, sparse as it ships. */
function seed(provenance: Record<string, SessionProvenance>): void {
  useProjectSessionsStore.setState({
    byProject: { "project-1": { terminal: [], chat: [], provenance } },
  });
}

async function mount(tabs: readonly TicketTabDescriptor[]): Promise<string> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TicketTabStrip
        projectId="project-1"
        ticketId="ticket-1"
        tabs={tabs}
        activeTabId="doc"
        creating={false}
        onSelectTab={noop}
        onCloseTab={noop}
        onRenameSessionTab={noop}
        onNewSession={noop}
        onNewChat={noop}
        onNewBrowser={noop}
        railCollapsed={false}
        onToggleRail={noop}
      />,
    );
  });
  return container.innerHTML;
}

/** One tab's node, found by the accessible name the strip gives it. */
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

describe("a ticket Session tab's provenance", () => {
  it("carries the bolt and the Automation's name on a chat tab", async () => {
    seed({ "session-run": RUN });

    const html = await mount([BODY, CHAT]);

    expect(html).toContain('aria-label="Started by the Automation Nightly sweep"');
    // The tab's own label is the Session title, so the name is printed beside
    // the bolt here rather than repeated from it.
    expect(tab("Fix the flaky worktree test").textContent).toContain("Nightly sweep");
  });

  // The tab's own accessible NAME stays the label alone: it is read out on
  // every arrow through the strip, and a name that grew a clause would make the
  // strip slower to walk for exactly the people it was meant to help. The line
  // rides as the tab's description instead, which is what a `title` beside an
  // explicit `aria-label` computes to.
  it("adds the provenance line to the tab's tooltip and not to its name", async () => {
    seed({ "session-run": RUN });

    await mount([BODY, CHAT]);

    expect(tab("Fix the flaky worktree test").getAttribute("title")).toBe(
      "Fix the flaky worktree test\nAutomation · Nightly sweep",
    );
  });

  // The terminal half of the same strip reaches the store by a different id
  // shape — a terminal tab's id IS the Session id, a chat tab's is prefixed.
  // One of the two getting this wrong stays invisible until a Run opens the
  // other kind.
  it("marks a terminal Session tab from the same reading", async () => {
    seed({ "session-run": RUN });

    const html = await mount([BODY, TERMINAL]);

    expect(html).toContain('aria-label="Started by the Automation Nightly sweep"');
    // The label already IS the Automation, so the mark declines to repeat it.
    expect(tab("Nightly sweep").textContent).toBe("Nightly sweep");
  });

  it("names the parent in the tooltip for a Session another Session started", async () => {
    seed({ "session-run": CHILD });

    const html = await mount([BODY, CHAT]);

    expect(tab("Fix the flaky worktree test").getAttribute("title")).toBe(
      "Fix the flaky worktree test\nStarted by Orchestrator",
    );
    // No glyph is minted for this arm, here or anywhere else (VC-112).
    expect(html).not.toContain("Started by the Automation");
  });

  // The pre-Run window: the launch event says `automation` and the Run record
  // that would name it has not landed. The bolt still draws.
  it("says an Automation started it even when nothing can name which", async () => {
    seed({ "session-run": { kind: "automation", automationName: null } });

    const html = await mount([BODY, CHAT]);

    expect(html).toContain('aria-label="Started by an Automation"');
    expect(tab("Fix the flaky worktree test").getAttribute("title")).toBe(
      "Fix the flaky worktree test\nStarted by an Automation",
    );
  });

  it("leaves a person's Session tab exactly as it was", async () => {
    seed({ "session-run": RUN });
    const marked = await mount([BODY, CHAT]);
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    seed({});
    const resting = await mount([BODY, CHAT]);

    expect(resting).not.toContain("Started by");
    expect(tab("Fix the flaky worktree test").getAttribute("title")).toBe(
      "Fix the flaky worktree test",
    );
    // Strictly shorter: no node, no class and no character on a strip nobody
    // automated.
    expect(resting.length).toBeLessThan(marked.length);
  });

  // A File tab has no Session, and the badge slot it already uses for the
  // worktree dot must not be taken away from it.
  it("leaves a tab that is not a Session alone", async () => {
    seed({ "session-run": RUN });

    const html = await mount([BODY, FILE]);

    expect(html).toContain('aria-label="Worktree copy"');
    expect(html).not.toContain("Started by");
  });
});
