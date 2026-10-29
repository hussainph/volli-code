// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";
import { adoptLaunch } from "@renderer/stores/launch";
import { useCloudPlacesStore } from "@renderer/lib/cloud-places";
import { useAutomationsStore } from "@renderer/stores/automations";
import {
  useCloudAutomationsStore,
  clearCloudAutomations,
  automationRunners,
} from "@renderer/stores/cloud-automations/state";
import {
  P,
  A,
  R,
  U,
  T,
  automation,
  arming,
  schedule,
  runner,
  run,
} from "@renderer/stores/cloud-automations/fixtures.test-support";
import {
  CloudAutomationControls,
  CloudColumnArming,
  CloudNextScheduledRun,
} from "./cloud-automation-controls";
import { CloudRunHistory, cloudRunLabel } from "./cloud-run-history";
import { toastError } from "@renderer/lib/toast";
import { ArmedRunWindows } from "./armed-run-window";
import { AutomationsOnly } from "./automation-availability";
vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
vi.mock("@renderer/components/hosts/use-hosts", () => ({
  useCanWrite: () => true,
  guardWrite: () => true,
}));
vi.mock("@renderer/components/models/resolved-model-name", () => ({
  ResolvedModelName: ({ selection }: { selection: { modelId: string } }) => (
    <span>{selection.modelId}</span>
  ),
}));
let root: Root;
let container: HTMLDivElement;
const originalArm = useAutomationsStore.getState().arm;
const originalEnabled = useAutomationsStore.getState().setEnabled;
async function mount(node: React.ReactNode) {
  await act(async () => root.render(node));
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (row) => row.textContent === label || row.getAttribute("aria-label") === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  HTMLElement.prototype.scrollIntoView = () => {};
  adoptLaunch({ store: "cloud", userId: U, backendUrl: "http://127.0.0.1:1" });
  clearCloudAutomations();
  useCloudPlacesStore.setState({ thisRunnerId: R });
  useCloudAutomationsStore.setState({
    runners: [runner()],
    armings: { [P]: [arming] },
    schedules: { [P]: [schedule] },
  });
  useAutomationsStore.setState({
    byProject: { [P]: [automation] },
    orderByProject: {},
    enabledIds: [A],
    arm: vi.fn(async () => null),
    setEnabled: vi.fn(async () => {}),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  adoptLaunch(LOCAL_LAUNCH);
  clearCloudAutomations();
  useAutomationsStore.setState({ arm: originalArm, setEnabled: originalEnabled });
});

describe("cloud Automation controls", () => {
  it("offers only capable, non-revoked own runners (old builds never appear)", () => {
    expect(
      automationRunners([
        runner(),
        runner({ id: "old", capabilities: { tools: [] } }),
        runner({ id: "gone", status: "revoked" }),
        runner({ id: "unknown", capabilities: null }),
      ]).map((row) => row.id),
    ).toEqual([R]);
  });
  it("defaults column arming to this Mac, shows its armer, and has no per-machine switch", async () => {
    await mount(<CloudColumnArming projectId={P} status="doing" />);
    await click("Doing runs Review on Ada’s Mac · Armed by Ada");
    expect(document.body.textContent).toContain("Armed by Ada");
    expect(document.body.textContent).toContain("on Ada’s Mac (this Mac)");
    expect(document.querySelector('[role="switch"]')).toBeNull();
    await click("Review");
    expect(useAutomationsStore.getState().arm).toHaveBeenCalledWith({
      projectId: P,
      status: "doing",
      automationId: A,
      runnerId: R,
    });
    expect(useAutomationsStore.getState().setEnabled).not.toHaveBeenCalled();
  });
  it("keeps paused armings visible and re-arms on the caller's Mac", async () => {
    useCloudAutomationsStore.setState({
      armings: {
        [P]: [
          {
            ...arming,
            runnerId: "removed",
            runnerName: "Removed runner",
            pausedAt: 1,
            pausedReason: "runner_removed",
          },
        ],
      },
    });
    await mount(<CloudColumnArming projectId={P} status="doing" />);
    expect(container.textContent).toContain("Paused · Re-arm");
    await click("Doing · Paused · Re-arm");
    await click("Re-arm Review");
    expect(useAutomationsStore.getState().arm).toHaveBeenCalledWith({
      projectId: P,
      status: "doing",
      automationId: A,
      runnerId: R,
    });
  });
  it("a schedule's switch disarms its shared arming, not a local preference", async () => {
    const scheduled = {
      ...automation,
      trigger: {
        kind: "schedule" as const,
        schedule: { preset: "daily" as const, hour: 9, minute: 0, timeZone: "UTC" },
      },
    };
    await mount(<CloudAutomationControls projectId={P} automation={scheduled} />);
    expect(container.textContent).toContain("Armed by Ada");
    await click("Armed: Review");
    expect(useAutomationsStore.getState().setEnabled).toHaveBeenCalledWith(A, false, R);
  });
  it("a paused schedule offers Re-arm and displays only the backend's next due time", async () => {
    useCloudAutomationsStore.setState({
      schedules: { [P]: [{ ...schedule, pausedAt: 1, pausedReason: "moved" }] },
    });
    const scheduled = {
      ...automation,
      trigger: {
        kind: "schedule" as const,
        schedule: { preset: "daily" as const, hour: 9, minute: 0, timeZone: "UTC" },
      },
    };
    await mount(
      <>
        <CloudAutomationControls projectId={P} automation={scheduled} />
        <CloudNextScheduledRun projectId={P} automationId={A} />
      </>,
    );
    expect(container.textContent).not.toContain("Next:");
    await click("Re-arm");
    expect(useAutomationsStore.getState().setEnabled).toHaveBeenCalledWith(A, true, R);
    await act(async () =>
      useCloudAutomationsStore.setState({
        schedules: { [P]: [{ ...schedule, nextFireAt: Date.parse("2026-03-07T12:34:00Z") }] },
      }),
    );
    expect(container.textContent).toContain("12:34");
  });
  it("names the update recovery when this Mac has an old build", async () => {
    useCloudAutomationsStore.setState({ runners: [runner({ capabilities: { tools: [] } })] });
    await mount(<CloudColumnArming projectId={P} status="doing" />);
    await click("Doing runs Review on Ada’s Mac · Armed by Ada");
    expect(document.body.textContent).toContain("Update Volli on Ada’s Mac");
  });
  it("offers a capable degraded runner, never the old-build default", async () => {
    useCloudAutomationsStore.setState({
      runners: [
        runner({ capabilities: { tools: [] } }),
        runner({ id: "degraded", name: "Other Mac", status: "degraded" }),
      ],
    });
    await mount(<CloudColumnArming projectId={P} status="doing" />);
    await click("Doing runs Review on Ada’s Mac · Armed by Ada");
    expect(document.body.textContent).toContain("Update Volli on Ada’s Mac");
    const picker = document.querySelector('[aria-label="Automation runner"]')!;
    await act(async () =>
      picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.some((option) => option.textContent?.includes("Ada’s Mac"))).toBe(false);
    const degraded = options.find((option) => option.textContent?.includes("Other Mac"));
    expect(degraded).toBeDefined();
    expect(degraded!.hasAttribute("data-disabled")).toBe(false);
  });
  it("allows only Automation children through the cloud availability wrapper", async () => {
    await mount(
      <AutomationsOnly projectId={P}>
        <span>Automations work</span>
      </AutomationsOnly>,
    );
    expect(container.textContent).toBe("Automations work");
  });
});

describe("cloud Run evidence", () => {
  it.each([
    [run(), "Waiting for Ada’s Mac (asleep)"],
    [
      run({ runner: { id: R, statusChangedAt: null, name: "Mac", status: "offline" } }),
      "Waiting for Mac (offline)",
    ],
    [
      run({ runner: { id: R, statusChangedAt: null, name: "Mac", status: "online" } }),
      "Waiting for Mac",
    ],
    [run({ status: "failed", error: "Choose a model" }), "Failed · Choose a model"],
    [
      run({
        status: "skipped",
        skipReason: { kind: "runner-asleep", runnerId: R },
        missedCount: 3,
      }),
      "Skipped · Ada’s Mac was asleep (3 missed)",
    ],
    [
      run({ status: "skipped", skipReason: { kind: "superseded" } }),
      "Skipped · Replaced by the next run",
    ],
    [
      run({ status: "skipped", skipReason: { kind: "runner-unavailable", code: "armer_left" } }),
      "Skipped · Runner unavailable",
    ],
    [run({ status: "started", sessionAccess: "private" }), "Private Session"],
    [run({ status: "started", sessionAccess: "starting" }), "Starting…"],
    [run({ status: "started", sessionAccess: "gone" }), "Session removed"],
    [run({ status: "started", sessionAccess: "ready", attendance: "unattended" }), "Automatic"],
    [run({ status: "started", sessionAccess: "ready" }), "By hand"],
  ])("prints %s as %s", (row, text) => expect(cloudRunLabel(row)).toBe(text));
  it("draws one coalesced skip and inert private/starting/waiting rows, without inventing a model", async () => {
    useCloudAutomationsStore.setState({
      histories: {
        [P]: [
          run(),
          run({
            id: "skip",
            status: "skipped",
            skipReason: { kind: "runner-asleep", runnerId: R },
            missedCount: 3,
          }),
          run({ id: "private", status: "started", sessionAccess: "private" }),
          run({ id: "starting", status: "started" }),
        ],
      },
    });
    await mount(<CloudRunHistory projectId={P} automationId={null} />);
    expect(container.textContent).toContain("Waiting for Ada’s Mac");
    expect(container.textContent).toContain("3 missed");
    expect(container.textContent).toContain("Private Session");
    expect(container.textContent).toContain("Starting…");
    expect(container.querySelectorAll('[data-run-history-run="skip"]')).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-run-history-run] button[data-slot="list-row-main"]'),
    ).toHaveLength(0);
    expect(container.textContent).not.toContain("effort");
  });
  it("surfaces Retry failure when the cloud source has closed", async () => {
    useCloudAutomationsStore.setState({
      histories: { [P]: [run({ status: "failed", retryCommandId: T })] },
    });
    await mount(<CloudRunHistory projectId={P} automationId={null} />);
    await click("Retry");
    expect(toastError).toHaveBeenCalledWith("Volli Cloud isn’t connected yet.");
  });
  it("the pending arrival waits after its countdown and cannot Cancel a leased start", async () => {
    useCloudAutomationsStore.setState({
      pending: {
        [P]: {
          pending: [
            {
              jobId: A,
              runId: A,
              ticketId: T,
              automationId: A,
              status: "doing",
              origin: "armed",
              availableAt: 1,
              leased: false,
              runner: { id: R, statusChangedAt: null, name: "Ada’s Mac", status: "asleep" },
            },
          ],
          failures: [],
        },
      },
    });
    await mount(<ArmedRunWindows />);
    expect(container.textContent).toContain("Waiting for Ada’s Mac (asleep)");
    await act(async () =>
      useCloudAutomationsStore.setState((state) => ({
        pending: {
          [P]: {
            ...state.pending[P]!,
            pending: state.pending[P]!.pending.map((row) =>
              Object.assign({}, row, { leased: true }),
            ),
          },
        },
      })),
    );
    expect(container.textContent).toContain("Starting…");
    expect(container.querySelector("button")?.disabled).toBe(true);
  });
});
