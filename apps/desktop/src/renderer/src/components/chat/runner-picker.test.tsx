// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH, THIS_MAC_RUNNER_OFF, type ThisMacRunnerSnapshot } from "@volli/shared";
import { adoptLaunch } from "@renderer/stores/launch";
import { seedAppStateCache } from "@renderer/lib/app-state-storage";
import { useRunnerPicker, type RunnerPickerState } from "./runner-picker";
import type { ComposerRunners } from "./runner-picker-model";

const fake = vi.hoisted(() => ({ follow: vi.fn(), subscribe: vi.fn() }));
vi.mock("@renderer/lib/cloud-client", () => ({ followCloudSession: fake.follow }));
vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({ runners: { subscribeThisMac: { subscribe: fake.subscribe } } }),
}));
vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  adoptLaunch(LOCAL_LAUNCH);
  vi.clearAllMocks();
});

async function fixture(cloud = true) {
  if (cloud)
    adoptLaunch({
      store: "cloud",
      userId: "user",
      backendUrl: "https://example.convex.cloud",
      siteUrl: "https://example.convex.site",
    });
  let value: ComposerRunners | undefined;
  let update = () => {};
  let mac = (_snapshot: ThisMacRunnerSnapshot) => {};
  const offQuery = vi.fn();
  const offFollow = vi.fn();
  const unsubscribe = vi.fn();
  fake.subscribe.mockImplementation((_args, handlers) => {
    mac = handlers.onData;
    return { unsubscribe };
  });
  const watchQuery = vi.fn(() => ({
    localQueryResult: () => value,
    onUpdate: (fn: () => void) => {
      update = fn;
      return offQuery;
    },
  }));
  fake.follow.mockImplementation((fn) => {
    fn({ client: { watchQuery } });
    return offFollow;
  });
  let state: RunnerPickerState;
  function Probe({ projectId }: { projectId: string }) {
    state = useRunnerPicker(projectId);
    return null;
  }
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(<Probe projectId="project" />));
  return {
    state: () => state!,
    watchQuery,
    offQuery,
    offFollow,
    unsubscribe,
    async load(next: ComposerRunners) {
      await act(async () => {
        value = next;
        update();
        mac({ ...THIS_MAC_RUNNER_OFF, runnerId: "mac", state: "online" });
      });
    },
    async project(projectId: string) {
      value = undefined;
      await act(async () => root.render(<Probe projectId={projectId} />));
    },
    async stop() {
      await act(async () => root.unmount());
    },
  };
}

const mac = {
  id: "mac",
  name: "Mac",
  kind: "mac",
  status: "online",
  statusChangedAt: 1,
  power: { source: "battery" as const, alwaysOn: false },
  providers: ["anthropic"],
  version: "1",
  upgradeRequired: false,
};
const box = { ...mac, id: "box", name: "Box", kind: "linux", providers: ["openai"] };

describe("composer runner subscription", () => {
  it("does nothing at all in a local launch", async () => {
    const f = await fixture(false);
    try {
      expect(fake.follow).not.toHaveBeenCalled();
      expect(fake.subscribe).not.toHaveBeenCalled();
      expect(f.state().selected).toBeNull();
    } finally {
      await f.stop();
    }
  });
  it("follows the query, remembers a choice per project, and cleans up", async () => {
    seedAppStateCache({ "composer-runner-choices": "{}" });
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { appState: { set: vi.fn().mockResolvedValue({ ok: true }) } },
    });
    const f = await fixture();
    try {
      expect(f.state().loading).toBe(true);
      await f.load({ runners: [mac, box], defaultRunnerId: "box" });
      expect(f.state().selected?.id).toBe("box");
      await act(async () => f.state().choose("mac"));
      expect(f.state().selected?.id).toBe("mac");
      await f.project("other");
      expect(f.state().selected).toBeNull();
      await f.load({ runners: [mac, box], defaultRunnerId: "box" });
      expect(f.state().selected?.id).toBe("box");
      await f.project("project");
      await f.load({ runners: [mac, box], defaultRunnerId: "box" });
      expect(f.state().selected?.id).toBe("mac");
    } finally {
      await f.stop();
    }
    expect(f.offQuery).toHaveBeenCalled();
    expect(f.offFollow).toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalled();
  });
});
