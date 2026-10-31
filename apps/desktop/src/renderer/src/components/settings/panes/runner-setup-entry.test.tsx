// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";
import { adoptLaunch } from "@renderer/stores/launch";
import { useUpdateStore } from "@renderer/stores/update";
import { fakeCloud } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import { RunnersPane } from "./runners-pane";

vi.mock("./runner-availability", () => ({ RunnerAvailability: () => null }));
vi.mock("./use-runners", async (original) => ({
  ...(await original<typeof import("./use-runners")>()),
  useRunners: () => ({
    thisMac: { kind: "loading" },
    runners: { kind: "ready", value: [] },
    commands: {},
    retry: vi.fn(),
  }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  adoptLaunch({
    store: "cloud",
    userId: "person",
    backendUrl: "https://staging.convex.cloud",
    siteUrl: "https://staging.convex.site",
    deployment: "cloud",
  });
  useUpdateStore.setState({
    state: {
      supported: true,
      phase: "idle",
      currentVersion: "0.3.0-canary.1",
      targetVersion: null,
      percent: null,
      error: null,
      lastCheck: null,
    },
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  adoptLaunch(LOCAL_LAUNCH);
  useUpdateStore.setState({ state: null });
  vi.restoreAllMocks();
});
async function click(label: string) {
  const node = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  expect(node).toBeDefined();
  await act(async () => node!.click());
}

it.each(["Add a runner", "Get an always-on runner"])(
  "opens %s from Settings and observes the linked runner through the generated API",
  async (entry) => {
    const cloud = fakeCloud();
    const expiresAt = Date.now() + 3600000;
    const action = vi.fn(async () => ({
      installTokenId: "token-id",
      installToken: "vrt_fixture",
      expiresAt,
    }));
    const session = {
      ...cloud.session,
      client: { ...cloud.session.client, action: action as never },
    };
    act(() => root.render(<RunnersPane current={() => session} />));
    await click(entry);
    await click("Create install command");
    expect(action).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("/v0.3.0-canary.1/volli-runner-install.sh");
    expect(document.body.textContent).toContain("--server 'https://staging.convex.site'");
    act(() =>
      cloud.answer(
        "runners:installTokenStatus",
        { installTokenId: "token-id" },
        { state: "used", expiresAt, runner: { id: "runner", name: "box", status: "online" } },
      ),
    );
    expect(document.body.textContent).toContain("box is online. Pick it in the composer.");
    await click("Done");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe(entry));
    expect(cloud.watchers("runners:installTokenStatus", { installTokenId: "token-id" })).toBe(0);
  },
);

it("opens the device code sheet without requiring install metadata", async () => {
  useUpdateStore.setState({ state: null });
  act(() => root.render(<RunnersPane />));
  await click("Link a runner");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Runner code");
});
