// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  RunnerStartStatusPanel,
  useRunnerStartStatus,
  type RunnerStartStatus,
} from "./runner-picker-start-status";

const fake = vi.hoisted(() => ({ follow: vi.fn() }));
vi.mock("@renderer/lib/cloud-client", () => ({ followCloudSession: fake.follow }));
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("follows queued, starting, started and unavailable status without leaking the old subscription", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let value: RunnerStartStatus | null | undefined;
  let update = () => {};
  const off = vi.fn();
  const stop = vi.fn();
  const watch = vi.fn(() => ({
    localQueryResult: () => value,
    onUpdate: (fn: () => void) => {
      update = fn;
      return off;
    },
  }));
  fake.follow.mockImplementation((fn) => {
    fn({ client: { watchQuery: watch } });
    return stop;
  });
  let answer: ReturnType<typeof useRunnerStartStatus>;
  function Probe({ id }: { id?: string }) {
    answer = useRunnerStartStatus(id);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Probe />));
  expect(fake.follow).not.toHaveBeenCalled();
  await act(async () => root!.render(<Probe id="first" />));
  for (const state of ["queued", "starting", "started"] as const) {
    await act(async () => {
      value = { sessionId: "first", state, runner: null, failure: null };
      update();
    });
    expect(answer!.status?.state).toBe(state);
  }
  await act(async () => {
    value = undefined;
    root!.render(<Probe id="next" />);
  });
  expect(answer!).toBeNull();
  expect(off).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
  await act(async () => {
    value = null;
    update();
  });
  expect(answer!.error).toContain("no longer available");
});

it("offers only identical retry while unconfirmed, and editing only after a confirmed failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  root = createRoot(container);
  const retry = vi.fn();
  const edit = vi.fn();
  const panel = (accepted: boolean, status: RunnerStartStatus | null = null) => (
    <RunnerStartStatusPanel
      name="Build box"
      accepted={accepted}
      status={status}
      error={null}
      onRetry={retry}
      onEdit={edit}
    />
  );
  await act(async () => root!.render(panel(false)));
  expect(container.textContent).toContain("Confirming start on Build box");
  await act(async () => container.querySelector("button")!.click());
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => root!.render(panel(true)));
  expect(container.textContent).toContain("Sent — waiting for Build box");
  expect(container.querySelector("button")).toBeNull();
  await act(async () =>
    root!.render(
      panel(true, {
        sessionId: "s",
        state: "failed",
        runner: null,
        failure: { code: "checkout_missing", detail: "Choose a folder on Build box." },
      }),
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Choose a folder on Build box.",
  );
  await act(async () => container.querySelector("button")!.click());
  expect(edit).toHaveBeenCalledTimes(1);
});
