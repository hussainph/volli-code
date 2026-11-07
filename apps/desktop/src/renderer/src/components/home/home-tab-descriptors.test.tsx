// @vitest-environment jsdom
/**
 * A Home chat tab with no resident Session behind it yet — restored at
 * relaunch, adopted only when a pane shows it (VC-515) — still says what it is:
 * its title and state come off the durable listing row until the Session's own
 * stream answers, and the stream wins once it has.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChatSessionRecord } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HomeTabDescriptor } from "@renderer/components/home/home-tab-strip";
import { rememberSessionProject } from "@renderer/lib/session-project";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { seedSlice } from "@volli/session-presentation";
import { useHomeTabDescriptors } from "./home-tab-descriptors";

const PROJECT = "p-descriptors";
const CHAT_IDS = ["listed-working", "listed-waiting", "listed-idle", "unlisted"] as const;

let container: HTMLDivElement;
let root: Root;
let seen: readonly HomeTabDescriptor[] = [];

function Harness() {
  seen = useHomeTabDescriptors({
    terminalTabs: [],
    chatIds: CHAT_IDS,
    fileTabs: [],
    browserTabs: [],
    dirtyFilePaths: new Set(),
  });
  return null;
}

function row(sessionId: string, title: string, activity: ChatSessionRecord["activity"]) {
  return { sessionId, projectId: PROJECT, ticketId: null, title, activity } as ChatSessionRecord;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const sessionId of CHAT_IDS) rememberSessionProject(sessionId, PROJECT);
  useProjectSessionsStore.setState({
    byProject: {
      [PROJECT]: {
        terminal: [],
        provenance: {},
        chat: [
          row("listed-working", "Parser", "working"),
          row("listed-waiting", "Question", "waiting"),
          row("listed-idle", "Quiet", "stopped"),
        ],
      },
    },
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  useProjectSessionsStore.setState({ byProject: {} });
  useChatSessionsStore.setState({ sessions: {} });
  vi.unstubAllGlobals();
});

const chats = () =>
  seen.flatMap((tab) => (tab.kind === "chat" ? [{ title: tab.title, status: tab.status }] : []));

describe("useHomeTabDescriptors (VC-515)", () => {
  it("labels an unadopted chat tab from its listing row", () => {
    act(() => root.render(<Harness />));

    expect(chats()).toEqual([
      { title: "Parser", status: "working" },
      { title: "Question", status: "waiting" },
      { title: "Quiet", status: "idle" },
      { title: "Chat", status: "idle" },
    ]);
  });

  it("prefers the resident Session's own reading once it is adopted", () => {
    act(() => root.render(<Harness />));
    const slice = seedSlice("ready");
    act(() => useChatSessionsStore.setState({ sessions: { "listed-working": slice } }));

    // Resident but undescribed: the listing still names it; the lifecycle is the slice's.
    expect(chats()[0]).toEqual({ title: "Parser", status: "ready" });
  });
});
