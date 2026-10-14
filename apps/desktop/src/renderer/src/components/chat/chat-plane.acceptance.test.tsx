// @vitest-environment jsdom
/** A normal Send through the real client, router, SQLite runtime and gated Pi. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
} from "@volli/shared";
import { messageDeliveryLabels } from "@volli/session-presentation";
import { gatedProvider } from "../../../../../../../packages/agent-runtime/test-fixtures/gated-provider";
import type {
  SessionRuntime,
  SessionRuntimeCommandResult,
  SessionRuntimeProjectionSnapshot,
} from "@volli/session-engine";
import { runtimeTransport } from "../../../../../../../packages/session-rpc/test-fixtures/runtime-transport";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { ChatPlane } from "./chat-plane";
import { forgetTranscriptViews } from "./transcript-window";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const MODEL = {
  providerId: "scripted-fixture",
  modelId: "scripted",
  reasoningLevel: "off" as const,
};
const defaults = { ...EMPTY_MODEL_ACCESS_DEFAULTS, global: MODEL };
const modelAccess: ModelAccessClient = {
  inspect: async () => ({
    observedAt: 1,
    providers: [
      {
        id: MODEL.providerId,
        label: "Fixture",
        state: "available",
        accountLabel: null,
        billingSource: "unknown",
        recovery: null,
        signIn: [],
        hasStoredCredential: true,
      },
    ],
    models: [
      {
        ...MODEL,
        label: "Scripted",
        state: "available",
        reasoningLevels: ["off"],
        acceptsImageInput: false,
      },
    ],
  }),
  defaults: async () => defaults,
  setDefault: async () => defaults,
  hiddenModels: async () => [],
  setHiddenModels: async (hidden) => hidden,
  compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
  setCompactionPolicy: async (policy) => policy,
  codeModePolicy: async () => DEFAULT_CODE_MODE_POLICY,
  setCodeModePolicy: async (policy) => policy,
  pickerView: async () => "all",
  setPickerView: async (view) => view,
  beginSignIn: async () => {
    throw new Error("No sign-ins in this test");
  },
  signOut: async () => {},
};

const bridge = (): unknown =>
  new Proxy(() => {}, {
    get(_target, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      if (key.startsWith("on")) return () => () => {};
      if (key === "set") return async () => ({ ok: true });
      return bridge();
    },
    apply() {
      return Promise.resolve({ ok: false, error: "Not under test" });
    },
  });
let root: Root | undefined;
let container: HTMLDivElement;
// Load the Node fixture at test runtime, not into the browser TypeScript
// project: its storage modules legitimately import explicit .ts paths. The
// host package typechecks the fixture independently; this is its narrow edge.
interface HostFixture {
  sessionId: string;
  runtime: SessionRuntime;
  attach(): Promise<SessionRuntimeCommandResult>;
  projection(): Promise<SessionRuntimeProjectionSnapshot["projection"]>;
  peek(): Promise<Record<string, unknown>>;
  terminal: Promise<void>;
  close(): Promise<void>;
}
async function realFixture(provider: ReturnType<typeof gatedProvider>): Promise<HostFixture> {
  const path = decodeURIComponent(
    new URL(
      "../../../../../../../packages/host-core/src/session-runtime/silent-ends.test-support.ts",
      import.meta.url,
    ).pathname,
  );
  const module: {
    silentEndsFixture(options: { provider: typeof provider }): Promise<HostFixture>;
  } = await import(path);
  return module.silentEndsFixture({ provider });
}
let fixture: HostFixture | undefined;
let provider: ReturnType<typeof gatedProvider> | undefined;
let store: ReturnType<typeof createChatSessionsStore> | undefined;
const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  forgetTranscriptViews();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("api", bridge());
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  MotionGlobalConfig.skipAnimations = true;
  useChatDraftsStore.setState({ drafts: {} });
  useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set(["project"]) });
  useProjectSessionsStore.setState({ byProject: { project: EMPTY_PROJECT_SESSION_ROWS } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    provider?.release();
    root?.unmount();
    if (fixture) store?.getState().closeChatSession(fixture.sessionId);
    await fixture?.close();
  });
  container.remove();
  fixture = undefined;
  store = undefined;
  provider = undefined;
  root = undefined;
  MotionGlobalConfig.skipAnimations = false;
  HTMLElement.prototype.scrollTo = originalScrollTo;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assertion();
  });
}

it("shows a normal delivered prompt above Working and its streaming reply, then retires Working", async () => {
  provider = gatedProvider("Streaming reply");
  fixture = await realFixture(provider);
  await fixture.attach();
  const f = fixture;
  store = createChatSessionsStore(() => runtimeTransport(f.runtime));
  const chat = store;
  await act(async () => {
    chat.getState().adoptChatSession(f.sessionId, "project");
  });
  await eventually(() =>
    expect(chat.getState().sessions[f.sessionId]?.projection?.liveExecutor?.id).toBeTypeOf(
      "string",
    ),
  );
  await act(async () => {
    root!.render(
      <ModelAccessProvider client={modelAccess}>
        <TooltipProvider delayDuration={0}>
          <ChatPlane
            sessionId={f.sessionId}
            projectId="project"
            ticketId={null}
            store={chat}
            onOpenFile={() => {}}
          />
        </TooltipProvider>
      </ModelAccessProvider>,
    );
  });
  const box = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "Ordinary prompt",
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
  expect(send.disabled).toBe(false);
  await act(async () => {
    send.click();
    await provider!.entered;
  });
  await eventually(() => {
    const prompt = container.querySelector(".is-user");
    const reply = container.querySelector(".is-assistant");
    const working = [...container.querySelectorAll('[role="status"]')].find((element) =>
      element.textContent?.includes("Working"),
    );
    expect(prompt?.textContent).toContain("Ordinary prompt");
    expect(reply?.textContent).toContain("Streaming reply");
    expect(working).toBeDefined();
    expect(prompt!.compareDocumentPosition(reply!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      prompt!.compareDocumentPosition(working!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(prompt?.textContent).toContain("Delivered");
    const transcript = chat.getState().sessions[f.sessionId]!.transcript;
    expect(
      messageDeliveryLabels(transcript.frames).get(
        transcript.messages.find((message) => message.role === "user")!.id,
      ),
    ).toBe("Delivered");
  });
  expect((await f.projection()).turnActive).toBe(true);
  expect((await f.peek())["transcript"]).toContainEqual(
    expect.objectContaining({ text: "Ordinary prompt", delivery: "Delivered" }),
  );
  await act(async () => {
    provider!.release();
    await f.terminal;
  });
  await eventually(() => {
    expect(chat.getState().sessions[f.sessionId]!.transcript.turnActive).toBe(false);
    expect(chat.getState().sessions[f.sessionId]!.lifecycle).toBe("ready");
    expect(
      [...container.querySelectorAll('[role="status"]')].some((element) =>
        element.textContent?.includes("Working"),
      ),
    ).toBe(false);
    expect(container.querySelector(".is-user")?.textContent).toContain("Delivered");
    expect(container.querySelector(".is-assistant")?.textContent).toContain("Streaming reply");
  });
});
