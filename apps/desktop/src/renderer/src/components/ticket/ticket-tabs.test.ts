// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import {
  isClosableTicketTab,
  TicketPaneTabStrip,
  type TicketTabDescriptor,
  type TicketTabKind,
} from "./ticket-tabs";

const noop = (): void => {};

describe("a ticket terminal tab's exit status", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useSessionsStore.setState(useSessionsStore.getInitialState(), true);
    // Keep provenance local so mounting the real tab does not fetch over IPC.
    useProjectSessionsStore.setState({
      byProject: { "project-1": { terminal: [], chat: [], provenance: {} } },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useSessionsStore.setState(useSessionsStore.getInitialState(), true);
    useProjectSessionsStore.setState(useProjectSessionsStore.getInitialState(), true);
    vi.unstubAllGlobals();
  });

  it("shows Exited (137), not Exited (0), after a SIGKILL-normalized exit", async () => {
    useSessionsStore.getState().addSession(ticketScope("project-1", "ticket-1"), "session-1", {
      title: "Shell",
      harnessId: "claude-code",
      launchKind: "shell",
      createdAt: 1,
    });
    await act(async () => {
      root.render(
        createElement(TicketPaneTabStrip, {
          label: "Ticket tabs",
          projectId: "project-1",
          ticketId: "ticket-1",
          tabs: [{ id: "session-1", kind: "session", label: "Shell" }],
          activeTabId: "session-1",
          onSelectTab: noop,
          onCloseTab: noop,
          onRenameSessionTab: noop,
        }),
      );
    });
    const tab = container.querySelector('[role="tab"][aria-label="Shell"]');
    expect(tab?.getAttribute("title")).toBe("Shell");

    await act(async () => {
      // The host normalizes SIGKILL (9) to 128 + 9 before publishing exitCode.
      useSessionsStore.getState().markExited("session-1", 137);
    });

    expect(tab?.getAttribute("title")).toBe("Exited (137)");
    expect(container.querySelector('[title="Exited (0)"]')).toBeNull();
  });
});

describe("isClosableTicketTab", () => {
  it("treats file, diff, chat, and Browser tabs as closable like sessions", () => {
    const kinds: TicketTabKind[] = ["body", "session", "file", "diff", "chat", "browser"];
    expect(kinds.map(isClosableTicketTab)).toEqual([false, true, true, true, true, true]);
  });

  it("accepts a chat descriptor with a prefixed id and a lifecycle dot", () => {
    const tab: TicketTabDescriptor = {
      id: "chat:sess-9",
      kind: "chat",
      label: "Plan the migration",
      status: "working",
    };
    expect(isClosableTicketTab(tab.kind)).toBe(true);
    expect(tab.id.startsWith("chat:")).toBe(true);
  });

  it("accepts diff descriptors with relPath, optional previousPath, and dirty", () => {
    const tab: TicketTabDescriptor = {
      id: "diff:src/app.ts",
      kind: "diff",
      label: "app.ts",
      relPath: "src/app.ts",
      previousPath: "src/old.ts",
      dirty: true,
    };
    expect(isClosableTicketTab(tab.kind)).toBe(true);
    expect(tab.previousPath).toBe("src/old.ts");
  });

  it("accepts a preview File descriptor (decision #56)", () => {
    const tab: TicketTabDescriptor = {
      id: "file:src/app.ts",
      kind: "file",
      label: "app.ts",
      relPath: "src/app.ts",
      preview: true,
    };
    expect(isClosableTicketTab(tab.kind)).toBe(true);
    expect(tab.preview).toBe(true);
  });
});
