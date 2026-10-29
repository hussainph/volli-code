import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CloudSession } from "@renderer/lib/cloud-client";
import { LOCAL_LAUNCH, type Project } from "@volli/shared";
import { fakeCloud } from "../cloud-board/fake-cloud.test-support";
import { useProjectsStore } from "../projects";
import { useAutomationsStore, automationHistoryKey } from "../automations";
import { adoptLaunch } from "../launch";
import { cloudAutomationSource } from "../automation-source";
import { useCloudAutomationsStore, clearCloudAutomations } from "./state";
import { bindCloudAutomations } from "./bind";
import { P, A, U, automation, arming, schedule, runner, run } from "./fixtures.test-support";
import { toastError } from "@renderer/lib/toast";
const events = vi.hoisted(() => ({
  listener: null as ((session: CloudSession | null) => void) | null,
  stop: vi.fn(),
}));
vi.mock("@renderer/lib/cloud-client", async (original) => ({
  ...(await original<typeof import("@renderer/lib/cloud-client")>()),
  followCloudSession: (listener: (session: CloudSession | null) => void) => {
    events.listener = listener;
    return events.stop;
  },
}));
vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
const Q = "20000000-0000-4000-8000-000000000001";
const project = (id: string): Project => ({
  id,
  name: id,
  path: "",
  ticketPrefix: "TEST",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});
let dispose: () => void = () => {};
function setup() {
  const cloud = fakeCloud();
  cloud.queries.set("runners:list", () => [runner()]);
  cloud.queries.set("automations:list", () => [automation]);
  cloud.queries.set("automations:armings", () => [arming]);
  cloud.queries.set("automations:columnOrders", () => []);
  cloud.queries.set("automations:schedules", () => [schedule]);
  cloud.queries.set("automations:pendingArrivals", () => ({ pending: [], failures: [] }));
  return cloud;
}
beforeEach(() => {
  vi.clearAllMocks();
  adoptLaunch({ store: "cloud", userId: U, backendUrl: "http://127.0.0.1:1" });
  useProjectsStore.setState({ projects: [] });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    orderByProject: {},
    runsByProject: {},
    skipsByProject: {},
    runsByAutomation: {},
    skipsByAutomation: {},
    editor: null,
    enabledIds: [],
  });
  clearCloudAutomations();
});
afterEach(() => {
  dispose();
  dispose = () => {};
  adoptLaunch(LOCAL_LAUNCH);
});
describe("cloud Automation binding lifecycle", () => {
  it("follows added projects once and tears down every project/query on client loss", async () => {
    const cloud = setup();
    dispose = bindCloudAutomations(() => null);
    useProjectsStore.setState({ projects: [project(P)] });
    expect(cloudAutomationSource()).toBeNull();
    events.listener!(cloud.session);
    await vi.waitFor(() =>
      expect(useAutomationsStore.getState().byProject[P]).toEqual([automation]),
    );
    expect(cloud.watchers("automations:list", { projectId: P })).toBe(1);
    useProjectsStore.setState({ projects: [project(P)] });
    expect(cloud.watchers("automations:list", { projectId: P })).toBe(1);
    events.listener!(null);
    expect(cloud.watchers("automations:list", { projectId: P })).toBe(0);
    expect(useAutomationsStore.getState().byProject[P]).toBeUndefined();
    expect(cloudAutomationSource()).toBeNull();
    useProjectsStore.setState({ projects: [] });
    events.listener!(cloud.session);
    useProjectsStore.setState({ projects: [project(P)] });
    await vi.waitFor(() =>
      expect(useAutomationsStore.getState().byProject[P]).toEqual([automation]),
    );
    dispose();
    dispose = () => {};
    expect(events.stop).toHaveBeenCalledOnce();
    expect(cloud.watchers("automations:list", { projectId: P })).toBe(0);
    expect(useCloudAutomationsStore.getState().runners).toEqual([]);
  });
  it("forgets only the removed project's evidence and editor, retaining another project's live arming", async () => {
    const cloud = setup();
    dispose = bindCloudAutomations(() => null);
    events.listener!(cloud.session);
    useProjectsStore.setState({ projects: [project(P), project(Q)] });
    await vi.waitFor(() => expect(useAutomationsStore.getState().byProject[Q]).toBeDefined());
    const ownKey = automationHistoryKey(P, A),
      otherKey = automationHistoryKey(Q, A);
    useAutomationsStore.setState({
      editor: { projectId: P, automation },
      runsByAutomation: { [ownKey]: [], [otherKey]: [] },
      skipsByAutomation: { [ownKey]: [], [otherKey]: [] },
    });
    useCloudAutomationsStore.setState({
      histories: { [P]: [run()], [ownKey]: [run()], [Q]: [] },
      armings: { [P]: [arming], [Q]: [{ ...arming, projectId: Q }] },
      schedules: { [P]: [schedule], [Q]: [{ ...schedule, pausedAt: 1 }] },
    });
    useProjectsStore.setState({ projects: [project(Q)] });
    expect(useAutomationsStore.getState().editor).toBeNull();
    expect(useAutomationsStore.getState().runsByAutomation[ownKey]).toBeUndefined();
    expect(useAutomationsStore.getState().runsByAutomation[otherKey]).toEqual([]);
    expect(useCloudAutomationsStore.getState().histories[P]).toBeUndefined();
    expect(useCloudAutomationsStore.getState().histories[ownKey]).toBeUndefined();
    expect(useCloudAutomationsStore.getState().histories[Q]).toEqual([]);
    expect(useAutomationsStore.getState().enabledIds).toEqual([A]);
    useAutomationsStore.setState({ editor: { projectId: P, automation: null } });
    useProjectsStore.setState({ projects: [] });
    expect(useAutomationsStore.getState().editor?.projectId).toBe(P);
  });
  it.each([new Error("Read failed"), "Read failed"])(
    "surfaces both project and runner read failures: %s",
    async (error) => {
      const cloud = setup();
      cloud.queries.set("automations:schedules", () => {
        throw error;
      });
      cloud.queries.set("runners:list", () => {
        throw error;
      });
      dispose = bindCloudAutomations(() => null);
      events.listener!(cloud.session);
      useProjectsStore.setState({ projects: [project(P)] });
      await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("Read failed"));
      expect(
        vi.mocked(toastError).mock.calls.filter(([message]) => message === "Read failed"),
      ).toHaveLength(2);
    },
  );
  it("replaces a live client without retaining another account's facts or watches", async () => {
    const cloud = setup(),
      next = setup();
    dispose = bindCloudAutomations(() => null);
    events.listener!(cloud.session);
    useProjectsStore.setState({ projects: [project(P)] });
    await vi.waitFor(() => expect(useAutomationsStore.getState().byProject[P]).toBeDefined());
    events.listener!(next.session);
    await vi.waitFor(() => expect(next.watchers("automations:list", { projectId: P })).toBe(1));
    expect(cloud.watchers("automations:list", { projectId: P })).toBe(0);
  });
});
