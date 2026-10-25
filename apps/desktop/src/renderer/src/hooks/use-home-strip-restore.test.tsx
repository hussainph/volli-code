// @vitest-environment jsdom
/**
 * Home's whole-strip relaunch (VC-105), wired the way `home-surface.tsx` wires
 * it: the real project UI store rehydrating a persisted record, the real chat
 * tab store the restore opens tabs in, and the active-tab receipt beside it.
 * Only the Session client is stubbed — adopting attaches to main, and what is
 * under test is which Sessions are adopted, in what order, and when.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { arrangeTabs, EMPTY_TAB_ORDER } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { HOME_BOARD_TAB_ID, browserTabId } from "@renderer/components/home/home-tabs";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { createProjectUiStore } from "@renderer/stores/project-ui";
import { useHomeStripRestore } from "./use-home-strip-restore";
import { useHomeTabReceipt } from "./use-home-tab-receipt";

const PROJECT = "project-1";
const NO_CHATS: readonly string[] = [];
const NO_EXTRA: readonly string[] = [];
const NOTHING_TRANSIENT: ReadonlySet<string> = new Set();
const [A, B, C] = [chatTabId("sess-a"), chatTabId("sess-b"), chatTabId("sess-c")];
const adoptChatSession = useChatSessionsStore.getState().adoptChatSession;

type ProjectUiStore = ReturnType<typeof createProjectUiStore>;

let container: HTMLDivElement;
let root: Root;
let adopted: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
/** What the surface would draw, as of the latest render. */
let seen: { active: string; strip: readonly string[] };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  adopted = vi.fn<(sessionId: string) => void>();
  useChatSessionsStore.setState({ openTabs: {}, adoptChatSession: adopted });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  useChatSessionsStore.setState({ openTabs: {}, adoptChatSession });
  vi.unstubAllGlobals();
});

/** A project UI store booted from what the last run persisted for {@link PROJECT}. */
function relaunch(record?: Record<string, unknown>) {
  const data = new Map<string, string>();
  if (record !== undefined) {
    data.set(
      "volli:workspace",
      JSON.stringify({ state: { byProject: { [PROJECT]: record } }, version: 1 }),
    );
  }
  const storage = {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => void data.set(name, value),
    removeItem: (name: string) => void data.delete(name),
  };
  const store = createProjectUiStore(storage);
  /** The project's record as it would be written to disk now. */
  const persisted = () => {
    const raw = data.get("volli:workspace");
    const parsed = raw === undefined ? undefined : JSON.parse(raw);
    return parsed?.state?.byProject?.[PROJECT] as Record<string, unknown> | undefined;
  };
  return { store, persisted };
}

interface HarnessProps {
  store: ProjectUiStore;
  /** The project's durable ticketless chats, or `undefined` before the listing answers. */
  durable: readonly string[] | undefined;
  /** Non-chat tabs on the strip: files, browsers. */
  extra?: readonly string[];
  browserTabsHydrated?: boolean;
}

/** `home-surface.tsx`'s wiring, minus everything that draws. */
function Harness({ store, durable, extra = NO_EXTRA, browserTabsHydrated = true }: HarnessProps) {
  const chats = useChatSessionsStore((state) => state.openTabs[PROJECT] ?? NO_CHATS);
  const tabOrder = store((state) => state.byProject[PROJECT]?.homeTabOrder ?? EMPTY_TAB_ORDER);
  const recorded = store((state) => state.byProject[PROJECT]?.homeActiveTab ?? HOME_BOARD_TAB_ID);
  const tabIds = React.useMemo(() => [...chats.map(chatTabId), ...extra], [chats, extra]);
  const orderedTabIds = React.useMemo(
    () =>
      arrangeTabs(
        [HOME_BOARD_TAB_ID, ...tabIds].map((id) => ({ id })),
        tabOrder,
        1,
      ).map((tab) => tab.id),
    [tabIds, tabOrder],
  );
  const { active, restore } = useHomeStripRestore({
    projectId: PROJECT,
    tabIds,
    orderedTabIds,
    emptyTabIds: NOTHING_TRANSIENT,
    recorded,
    tabOrder,
    containerActive: null,
    durableChatIds: durable,
    browserTabsHydrated,
    recordTabOrder: store.getState().recordHomeTabOrder,
  });
  useHomeTabReceipt({
    projectId: PROJECT,
    provisionalActive: null,
    emptyTabIds: NOTHING_TRANSIENT,
    restoreKind: restore.kind,
    activeTabId: active,
    recordedTab: recorded,
    recordResolvedTab: store.getState().recordResolvedHomeTab,
  });
  seen = { active, strip: orderedTabIds };
  return null;
}

function render(props: HarnessProps) {
  act(() => root.render(<Harness {...props} />));
}

describe("useHomeStripRestore — Home's strip across a relaunch (VC-105)", () => {
  it("brings three Sessions back in the same order, with the same tab in front", () => {
    const { store, persisted } = relaunch({
      homeActiveTab: B,
      homeTabOrder: [A, "term-dead", B, C],
    });

    // The listing has not answered: nothing is adopted, nothing written, and
    // the Board stands in while the strip comes back.
    render({ store, durable: undefined });
    expect(adopted).not.toHaveBeenCalled();
    expect(seen).toEqual({ active: HOME_BOARD_TAB_ID, strip: [HOME_BOARD_TAB_ID] });
    expect(store.getState().byProject[PROJECT]?.homeTabOrder).toEqual([A, "term-dead", B, C]);
    expect(store.getState().byProject[PROJECT]?.homeActiveTab).toBe(B);

    render({ store, durable: ["sess-c", "sess-a", "sess-b"] });
    expect(adopted.mock.calls).toEqual([["sess-a"], ["sess-b"], ["sess-c"]]);
    expect(seen).toEqual({ active: B, strip: [HOME_BOARD_TAB_ID, A, B, C] });
    // The record now names the strip as drawn: the dead terminal is pruned
    // live, and what will be written to disk is the next relaunch's strip.
    expect(persisted()).toMatchObject({ homeActiveTab: B, homeTabOrder: [A, B, C] });
  });

  it("drops a Session archived since the quit without failing its neighbours, and lands on the Board", () => {
    const { store, persisted } = relaunch({ homeActiveTab: B, homeTabOrder: [A, B, C] });

    render({ store, durable: ["sess-a", "sess-c"] });
    expect(adopted.mock.calls).toEqual([["sess-a"], ["sess-c"]]);
    expect(seen).toEqual({ active: HOME_BOARD_TAB_ID, strip: [HOME_BOARD_TAB_ID, A, C] });
    expect(persisted()).toMatchObject({ homeActiveTab: HOME_BOARD_TAB_ID, homeTabOrder: [A, C] });
  });

  it("lands a cold profile on the Board and records nothing", () => {
    const { store, persisted } = relaunch();

    render({ store, durable: [] });
    expect(adopted).not.toHaveBeenCalled();
    expect(seen).toEqual({ active: HOME_BOARD_TAB_ID, strip: [HOME_BOARD_TAB_ID] });
    expect(store.getState().byProject[PROJECT]).toBeUndefined();
    expect(persisted()).toBeUndefined();
  });

  it("restores once: a Session closed after the restore stays closed, and leaves the record", () => {
    const { store, persisted } = relaunch({ homeActiveTab: A, homeTabOrder: [A, B] });
    render({ store, durable: ["sess-a", "sess-b"] });
    expect(seen.strip).toEqual([HOME_BOARD_TAB_ID, A, B]);

    act(() => useChatSessionsStore.setState({ openTabs: { [PROJECT]: ["sess-a"] } }));
    expect(adopted).toHaveBeenCalledTimes(2);
    expect(seen.strip).toEqual([HOME_BOARD_TAB_ID, A]);
    expect(persisted()).toMatchObject({ homeTabOrder: [A] });
  });

  it("keeps a Session still waiting on the listing when a drag rewrites the strip first", () => {
    const { store } = relaunch({ homeActiveTab: A, homeTabOrder: [A, "file:x.ts", B] });
    const extra = ["file:x.ts"];
    render({ store, durable: undefined, extra });

    // Dragged in the boot window: the drag knows only the tabs on screen.
    act(() => store.getState().moveHomeTab(PROJECT, "file:x.ts", ["file:x.ts"]));
    render({ store, durable: ["sess-a", "sess-b"], extra });

    expect(adopted.mock.calls).toEqual([["sess-a"], ["sess-b"]]);
    expect(seen).toEqual({ active: A, strip: [HOME_BOARD_TAB_ID, "file:x.ts", A, B] });
  });

  it("writes nothing back until main's Browser Tab registry has answered", () => {
    const browser = browserTabId("tab-1");
    const { store } = relaunch({ homeTabOrder: [browser, A] });

    render({ store, durable: ["sess-a"], browserTabsHydrated: false });
    expect(adopted.mock.calls).toEqual([["sess-a"]]);
    // A record written now would drop the Browser Tab that has not arrived.
    expect(store.getState().byProject[PROJECT]?.homeTabOrder).toEqual([browser, A]);

    render({ store, durable: ["sess-a"], extra: [browser], browserTabsHydrated: true });
    expect(seen.strip).toEqual([HOME_BOARD_TAB_ID, browser, A]);
    expect(store.getState().byProject[PROJECT]?.homeTabOrder).toEqual([browser, A]);
  });
});
