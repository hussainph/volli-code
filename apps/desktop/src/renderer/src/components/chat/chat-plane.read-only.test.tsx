// @vitest-environment jsdom
/** Real plane/composer, with the same refusing bridge as the island tests. */
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH, type RendererSessionInteraction } from "@volli/shared";
import { api as cloudApi } from "@volli/convex/api";
import * as cloudClient from "@renderer/lib/cloud-client";
import { adoptLaunch } from "@renderer/stores/launch";
import {
  EMPTY_TRANSCRIPT,
  type ChatSessionProjection,
  type ChatSessionTransport,
} from "@volli/session-presentation";

import { hostWorld, type HostWorld } from "@renderer/components/hosts/hosts.test-support";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { useCloudPlacesStore } from "@renderer/lib/cloud-places";
import { noteProjectTeam, useCloudTeamStore } from "@renderer/lib/cloud-team";
import { ChatPlane } from "./chat-plane";
import * as runnerPicker from "./runner-picker";
import { getFunctionName } from "convex/server";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const SESSION = "read-only-chat";
const PROJECT = "remote";
const DRAFT = "Keep these half-typed words";
const OFFLINE = { status: "offline", since: 0, retryAt: null } as const;
const originalProjects = useProjectsStore.getState();
const originalDrafts = useChatDraftsStore.getState();
const originalTabs = useBrowserTabsStore.getState();
const originalShells = useBackgroundShellsStore.getState();
const originalRows = useProjectSessionsStore.getState();
const originalPlaces = useCloudPlacesStore.getState();
let world: HostWorld | null = null;

/** Refused reads exercise the app's normal fallback, rather than UI doubles. */
function refusingBridge(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      return refusingBridge([...path, key]);
    },
    apply(_target, _this, args) {
      const name = path.at(-1) ?? "";
      if (name.startsWith("on")) return () => {};
      if (name === "pathForFile") return String(args[0]);
      return Promise.resolve({ ok: false, error: "not stubbed" });
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("api", refusingBridge());
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  MotionGlobalConfig.skipAnimations = true;
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
  useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
  useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
  useChatDraftsStore.setState({ drafts: {} });
});

afterEach(async () => {
  adoptLaunch(LOCAL_LAUNCH);
  await world?.cleanup();
  useCloudTeamStore.setState({
    viewerUserId: null,
    people: [],
    sessions: {},
    byProject: {},
    shareAll: null,
    readError: null,
  });
  world = null;
  MotionGlobalConfig.skipAnimations = false;
  useChatDraftsStore.setState(originalDrafts, true);
  useProjectsStore.setState(originalProjects, true);
  useBrowserTabsStore.setState(originalTabs, true);
  useBackgroundShellsStore.setState(originalShells, true);
  useProjectSessionsStore.setState(originalRows, true);
  useCloudPlacesStore.setState(originalPlaces, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function chatStore(turnActive = false, active: RendererSessionInteraction[] = []) {
  const projection: ChatSessionProjection = {
    session: {
      id: SESSION,
      projectId: PROJECT,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Chat",
      createdAt: 0,
    },
    status: "open",
    signal: null,
    modelSelection: { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" },
    modelTier: null,
    turnActive,
    lastActivityAt: 0,
    bornTicketless: true,
    scheduledResume: null,
    attention: { active: [], primary: null },
    interactions: { active, resolved: [] },
    liveExecutor: null,
  };
  // A silent transport holds the seeded snapshot steady. Sending must first
  // hold the draft, so spy on that seam as well as checking the visible value.
  const store = createChatSessionsStore(
    () => ({ connect: async () => {}, dispose: () => {} }) as unknown as ChatSessionTransport,
  );
  store.setState({
    sessions: {
      [SESSION]: {
        projection,
        transcript: EMPTY_TRANSCRIPT,
        lifecycle: "ready",
        sessionError: null,
        queue: [],
      },
    },
  });
  const holdMessage = vi.spyOn(useChatDraftsStore.getState(), "holdMessage");
  return { store, holdMessage };
}

async function mountPlane(
  cloud = true,
  turnActive = false,
  drafting = false,
  interactions: RendererSessionInteraction[] = [],
) {
  world = hostWorld({ cloud });
  const { store, holdMessage } = chatStore(turnActive, interactions);
  if (drafting)
    store.setState((state) => ({
      sessions: { ...state.sessions, [SESSION]: { ...state.sessions[SESSION]!, projection: null } },
    }));
  const container = await world.render(
    <TooltipProvider delayDuration={0}>
      <ChatPlane
        sessionId={SESSION}
        projectId={PROJECT}
        ticketId={null}
        onOpenFile={() => {}}
        store={store}
      />
    </TooltipProvider>,
  );
  return { container, holdMessage, store };
}

const credentialRequest = (id: string): RendererSessionInteraction => ({
  id,
  attachmentId: "attachment",
  kind: "question",
  title: "Credential requested",
  detail: null,
  options: [],
  multiple: false,
  native: { id: null, detail: null },
  credential: {
    id,
    sessionId: SESSION,
    sessionLabel: "Deploy Session",
    projectId: PROJECT,
    projectLabel: "Website",
    name: "DEPLOY_TOKEN",
    agentSays: "Deploy the website",
  },
});

function cloudSecrets(runnerId: string | null) {
  adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
  useCloudTeamStore.setState({
    viewerUserId: "u",
    people: [{ userId: "u", displayName: "Ana", status: "active" }],
  });
  noteProjectTeam(PROJECT, [
    { id: SESSION, ownerUserId: "u", visibility: "private", role: "project", turnActive: true },
  ]);
  useCloudPlacesStore.setState({
    thisRunnerId: runnerId,
    sessions: { [SESSION]: { placeRunnerId: "r1", turnActive: true } },
    runners: {
      r1: {
        id: "r1",
        name: "deploy-mac",
        kind: "mac",
        status: "online",
        statusChangedAt: 0,
        statusReason: null,
        owned: true,
      },
    },
  });
  const client = {
    mutation: vi.fn(),
    action: vi.fn(),
    query: vi.fn(),
    watchQuery: vi.fn(() => ({
      onUpdate: () => () => {},
      localQueryResult: () => undefined,
    })),
  };
  const session = { client, api: cloudApi } as unknown as cloudClient.CloudSession;
  vi.spyOn(cloudClient, "cloudSession").mockReturnValue(session);
  vi.spyOn(cloudClient, "followCloudSession").mockImplementation((listener) => {
    listener(session);
    return () => {};
  });
  const submit = vi.fn().mockResolvedValue({ ok: true });
  const decline = vi.fn().mockResolvedValue({ ok: true });
  const send = vi.fn();
  const resolveInteraction = vi.fn();
  const bridge = refusingBridge() as typeof window.api;
  vi.stubGlobal(
    "api",
    new Proxy(bridge, {
      get(target, key) {
        if (key === "secrets") return { submit, decline };
        if (key === "chat") return { send, resolveInteraction };
        return Reflect.get(target, key);
      },
    }),
  );
  return { client, submit, decline, send, resolveInteraction };
}

it("shows a cloud Session's local secure card, preserves pending requests, and sends no value to Convex or the transcript", async () => {
  const { client, submit, decline, send, resolveInteraction } = cloudSecrets("r1");
  const pending = Promise.withResolvers<{ ok: true }>();
  submit.mockReturnValueOnce(pending.promise);
  const { container, store } = await mountPlane(true, true, false, [
    credentialRequest("first"),
    credentialRequest("next"),
  ]);
  expect(container.querySelectorAll("input[type=password]")).toHaveLength(1);
  const cloudCallsBefore = {
    mutation: client.mutation.mock.calls.length,
    action: client.action.mock.calls.length,
    query: client.query.mock.calls.length,
  };
  const chatBefore = store.getState();
  const draftsBefore = useChatDraftsStore.getState();
  const field = container.querySelector<HTMLInputElement>("input[type=password]")!;
  expect(field).not.toBeNull();
  expect(field.closest('[data-slot="chat-composer-dock"]')).not.toBeNull();
  const sentinel = "cloud-local-person-only-sentinel";
  field.value = sentinel;
  const submitButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Submit credential",
  )!;
  act(() => {
    submitButton.click();
    expect(field.value).toBe("");
    submitButton.click();
  });
  expect(submit.mock.calls).toEqual([[{ requestId: "first", value: sentinel, scope: "session" }]]);
  await act(async () => pending.resolve({ ok: true }));
  expect(container.querySelectorAll('[data-slot="secret-card"]')).toHaveLength(1);
  expect(store.getState()).toBe(chatBefore);
  expect(useChatDraftsStore.getState()).toBe(draftsBefore);
  expect(container.innerHTML).not.toContain(sentinel);
  expect(JSON.stringify(chatBefore)).not.toContain(sentinel);
  expect(client.watchQuery).toHaveBeenCalled();
  expect({
    mutation: client.mutation.mock.calls.length,
    action: client.action.mock.calls.length,
    query: client.query.mock.calls.length,
  }).toEqual(cloudCallsBefore);
  for (const method of [client.mutation, client.action, client.query, client.watchQuery]) {
    expect(JSON.stringify(method.mock.calls.map((call) => call[1]))).not.toContain(sentinel);
  }
  expect(send).not.toHaveBeenCalled();
  expect(resolveInteraction).not.toHaveBeenCalled();

  // The already-pending request advances without waiting for a new cloud
  // projection; only the successful head is hidden by the local latch.
  expect(container.querySelector<HTMLInputElement>("input[type=password]")?.value).toBe("");
  const declineButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Decline",
  )!;
  await act(async () => declineButton.click());
  expect(decline).toHaveBeenCalledWith("next");
  expect(container.querySelector('[data-slot="secret-card"]')).toBeNull();
});

it.each(["another-runner", null])(
  "offers no credential controls for foreign or unknown local runner identity (%s)",
  async (runnerId) => {
    const { client, submit, decline, resolveInteraction } = cloudSecrets(runnerId);
    const { container } = await mountPlane(true, true, false, [credentialRequest("foreign")]);
    expect(container.textContent).toContain("DEPLOY_TOKEN: Enter this on deploy-mac.");
    const card = container.querySelector('[data-slot="secret-card"]')!;
    expect(card.querySelector("input, select, button, form")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(decline).not.toHaveBeenCalled();
    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(JSON.stringify(client.mutation.mock.calls.map((call) => call[1]))).not.toContain(
      "foreign",
    );
  },
);

it("keeps the composer in a cloud launch, with where the Session runs above it", async () => {
  useCloudTeamStore.setState({
    viewerUserId: "u",
    people: [{ userId: "u", displayName: "Ana", status: "active" }],
  });
  noteProjectTeam(PROJECT, [
    { id: SESSION, ownerUserId: "u", visibility: "private", role: "project", turnActive: true },
  ]);
  adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
  useCloudPlacesStore.setState({
    sessions: { [SESSION]: { placeRunnerId: "r1", turnActive: true } },
    runners: {
      r1: {
        id: "r1",
        name: "hp-mac",
        kind: "mac",
        status: "stopped",
        statusChangedAt: 0,
        statusReason: null,
        owned: false,
      },
    },
  });
  try {
    const { container, holdMessage } = await mountPlane(true, true);
    // The header's corner names the Place, in place of the host pill.
    const pill = container.querySelector('[data-slot="cloud-place"]');
    expect(pill?.textContent).toBe("Paused — Volli is closed on hp-mac");
    expect(container.querySelector('[data-slot="running-on"]')).toBeNull();
    // The box stays, so a message can wait for the runner; the line rides above it.
    expect(container.textContent).not.toContain("Not available yet in cloud");
    const textarea = message(container);
    const status = container.querySelector('[data-slot="cloud-composer-status"]');
    expect(status?.textContent).toBe("Paused — Volli is closed on hp-mac");
    const dock = container.querySelector('[data-slot="chat-composer-dock"]');
    expect(
      status!.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(dock?.contains(textarea)).toBe(true);
    // No window client is connected in this test: a press keeps its words.
    typeDraft(textarea);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(holdMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe(DRAFT);
  } finally {
    act(() => useCloudPlacesStore.setState({ sessions: {}, runners: {} }));
  }
});

it("replaces a teammate's composer, answers and stop controls with the owner boundary", async () => {
  adoptLaunch({ store: "cloud", userId: "viewer", backendUrl: "https://example.convex.cloud" });
  useCloudTeamStore.setState({
    viewerUserId: "viewer",
    people: [{ userId: "owner", displayName: "Ana Li", status: "active" }],
  });
  noteProjectTeam(PROJECT, [
    { id: SESSION, ownerUserId: "owner", visibility: "shared", role: "ticket", turnActive: true },
  ]);
  const { container, holdMessage } = await mountPlane(true, true, false, [
    credentialRequest("teammate"),
  ]);
  expect(container.textContent).toContain("Only Ana Li can send to this Session.");
  expect(container.querySelector('[data-slot="secret-card"]')).toBeNull();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.querySelector('textarea[aria-label="Message"]')).toBeNull();
  expect(container.querySelector('[aria-label="Stop"]')).toBeNull();
  expect(container.querySelector('[aria-label="Session sharing"]')).toBeNull();
  expect(holdMessage).not.toHaveBeenCalled();
  act(() =>
    useCloudTeamStore.setState({
      people: [{ userId: "owner", displayName: "Ana Li", status: "left" }],
    }),
  );
  expect(container.textContent).toContain("Ended · Ana Li left");
});

it("keeps a new cloud chat's composer before any Session exists", async () => {
  adoptLaunch({ store: "cloud", userId: "owner", backendUrl: "https://example.convex.cloud" });
  useChatDraftsStore.getState().openProvisional(SESSION, {
    projectId: PROJECT,
    ticketId: null,
    title: null,
    operationId: "new-chat",
  });
  const { container } = await mountPlane(true, false, true);
  expect(container.querySelector('textarea[aria-label="Message"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Loading Session owner…");
});

it("picks another runner in the composer and sends its durable first-message request without local promotion", async () => {
  adoptLaunch({ store: "cloud", userId: "owner", backendUrl: "https://example.convex.cloud" });
  const requestId = "20000000-0000-4000-8000-000000000001";
  useChatDraftsStore.getState().openProvisional(SESSION, {
    projectId: PROJECT,
    ticketId: null,
    title: null,
    operationId: requestId,
  });
  const mac = {
    id: "mac",
    name: "This Mac",
    kind: "mac",
    status: "online",
    statusChangedAt: 1,
    providers: [],
    version: "1",
    upgradeRequired: false,
  };
  const box = { ...mac, id: "box", name: "Build box", kind: "linux" };
  vi.spyOn(runnerPicker, "useRunnerPicker").mockImplementation((_project, _enabled, pinned) => ({
    runners: [mac, box],
    selected: pinned === "box" ? box : mac,
    thisMacId: "mac",
    loading: false,
    error: null,
    choose: () => {},
  }));
  const mutation = vi.fn().mockResolvedValue({ sessionId: "remote-session" });
  const client = {
    mutation,
    connectionState: () => ({ isWebSocketConnected: true }),
    watchQuery: () => ({ localQueryResult: () => undefined, onUpdate: () => () => {} }),
  };
  const cloud = { client, api: cloudApi } as unknown as cloudClient.CloudSession;
  vi.spyOn(cloudClient, "cloudSession").mockReturnValue(cloud);
  vi.spyOn(cloudClient, "followCloudSession").mockImplementation((listener) => {
    listener(cloud);
    return () => {};
  });
  const bridge = refusingBridge() as typeof window.api;
  const persisted = Promise.withResolvers<{ ok: true }>();
  let writes = 0;
  vi.stubGlobal(
    "api",
    new Proxy(bridge, {
      get(target, key) {
        if (key === "appState")
          return { set: async () => (++writes === 1 ? persisted.promise : { ok: true }) };
        return Reflect.get(target, key);
      },
    }),
  );
  const { container, store } = await mountPlane(true, false, true);
  const localPromotion = vi.spyOn(store.getState(), "promoteChatSession");
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Runner: This Mac"]')!;
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (node) => node.textContent?.includes("Build box"),
  )!;
  await act(async () => option.click());
  typeDraft(message(container));
  await act(async () => {
    const send = container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
    send.click();
    // Same tick, before React paints the disabled state or storage acknowledges.
    send.click();
  });
  expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toHaveLength(1);
  expect(mutation).not.toHaveBeenCalled();
  await act(async () => persisted.resolve({ ok: true }));
  await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
  expect(getFunctionName(mutation.mock.calls[0]![0])).toBe("sessionStarts:startOn");
  expect(mutation.mock.calls[0]![1]).toMatchObject({
    runnerId: "box",
    clientRequestId: requestId,
    projectId: PROJECT,
    ticketId: null,
  });
  expect(JSON.parse(mutation.mock.calls[0]![1].body).parts).toEqual([
    { type: "text", text: DRAFT },
  ]);
  expect(localPromotion).not.toHaveBeenCalled();
  expect(useChatDraftsStore.getState().drafts[SESSION]?.provisional?.runnerStart?.sessionId).toBe(
    "remote-session",
  );
  expect(container.textContent).toContain("Sent — waiting for Build box");
});

it("keeps the known owner's composer while names load or fail", async () => {
  adoptLaunch({ store: "cloud", userId: "owner", backendUrl: "https://example.convex.cloud" });
  noteProjectTeam(PROJECT, [
    {
      id: SESSION,
      ownerUserId: "owner",
      visibility: "private",
      role: "project",
      turnActive: false,
    },
  ]);
  const { container } = await mountPlane();
  expect(container.querySelector('textarea[aria-label="Message"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Only Unknown");
  act(() => useCloudTeamStore.setState({ readError: "Couldn’t load members." }));
  expect(container.querySelector('textarea[aria-label="Message"]')).not.toBeNull();
  expect(container.textContent).toContain("Couldn’t load members.");
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Retry"),
  ).toBe(true);
});

it("fails closed while cloud ownership has not answered", async () => {
  adoptLaunch({ store: "cloud", userId: "viewer", backendUrl: "https://example.convex.cloud" });
  const { container } = await mountPlane(true, false, false, [credentialRequest("unknown-owner")]);
  expect(container.textContent).toContain("Loading Session owner…");
  expect(container.querySelector('[data-slot="secret-card"]')).toBeNull();
  expect(container.querySelector('textarea[aria-label="Message"]')).toBeNull();
});

function message(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (textarea === null) throw new Error("Missing composer textarea");
  return textarea;
}

function typeDraft(textarea: HTMLTextAreaElement): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      DRAFT,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ChatPlane host read-only", () => {
  it("keeps a typed draft across offline/open and refuses every composer submission while offline", async () => {
    const { container, holdMessage } = await mountPlane();
    const textarea = message(container);
    expect(textarea.disabled).toBe(false);
    typeDraft(textarea);
    expect(useChatDraftsStore.getState().drafts[SESSION]?.text).toBe(DRAFT);

    world!.setHetzner({ link: OFFLINE });
    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toBe(DRAFT);
    const send = container.querySelector<HTMLButtonElement>('[aria-label="Send"]');
    expect(send).not.toBeNull();
    expect(send!.disabled).toBe(true);
    // Greyed and desaturated like every write control, not a quieter orange.
    expect(send!.hasAttribute("data-host-read-only")).toBe(true);
    await act(async () => {
      send!.click();
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      // Even a synthetic form submission cannot bypass the disabled composer.
      textarea
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(holdMessage).not.toHaveBeenCalled();
    expect(useChatDraftsStore.getState().drafts[SESSION]?.held).toEqual([]);
    expect(textarea.value).toBe(DRAFT);

    world!.setHetzner({ link: { status: "open" } });
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe(DRAFT);
    expect(send!.disabled).toBe(false);
    expect(send!.hasAttribute("data-host-read-only")).toBe(false);
  });

  it("draws Running on at the plane root, never inside the composer dock", async () => {
    const { container } = await mountPlane();
    const plane = container.querySelector('[style*="--composer-height"]');
    const label = container.querySelector('[data-slot="running-on"]');
    expect(plane).not.toBeNull();
    expect(label).not.toBeNull();
    expect(label!.parentElement).toBe(plane);
    expect(label!.textContent).toBe("Running on hetzner-1");
    expect(label!.closest('[data-slot="chat-composer-dock"]')).toBeNull();
    const dock = container.querySelector('[data-slot="chat-composer-dock"]');
    expect(dock).not.toBeNull();
    expect(dock!.contains(label)).toBe(false);
  });

  it("with cloud off draws no Running on label and keeps the composer enabled offline", async () => {
    const { container } = await mountPlane(false);
    typeDraft(message(container));
    world!.setHetzner({ link: OFFLINE });
    expect(container.querySelector('[data-slot="running-on"]')).toBeNull();
    expect(message(container).disabled).toBe(false);
    expect(message(container).value).toBe(DRAFT);
    const send = container.querySelector('[aria-label="Send"]');
    expect(send?.hasAttribute("data-host-read-only")).toBe(false);
  });
});
