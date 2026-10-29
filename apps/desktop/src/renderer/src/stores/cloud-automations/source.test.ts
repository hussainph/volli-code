import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH, NO_AUTOMATION_TRIGGER } from "@volli/shared";
import { fakeCloud, refusal } from "../cloud-board/fake-cloud.test-support";
import { adoptLaunch } from "../launch";
import {
  automationSource,
  automationSourceIsCloud,
  installCloudAutomationSource,
} from "../automation-source";
import { useAutomationsStore, automationHistoryKey } from "../automations";
import { useCloudPlacesStore } from "@renderer/lib/cloud-places";
import { clearCloudAutomations, useCloudAutomationsStore } from "./state";
import { ConvexAutomationSource } from "./source";
import { P, A, R, U, T, automation, arming, schedule, runner, run } from "./fixtures.test-support";

let source: ConvexAutomationSource;
function setup() {
  const cloud = fakeCloud();
  const answers: Record<string, unknown> = {
    list: [automation],
    armings: [arming],
    columnOrders: [{ projectId: P, status: "doing", rankedIds: [A], orderedAt: 1 }],
    schedules: [schedule],
    pendingArrivals: { pending: [], failures: [] },
  };
  for (const name of Object.keys(answers))
    cloud.queries.set(`automations:${name}`, () => answers[name]);
  cloud.queries.set("runners:list", () => [runner()]);
  for (const name of ["runsForProject", "runsForAutomation"])
    cloud.queries.set(`automations:${name}`, () => ({
      page: [run()],
      isDone: true,
      continueCursor: "end",
    }));
  source = new ConvexAutomationSource(cloud.session);
  source.onError = vi.fn();
  installCloudAutomationSource(source);
  return { cloud, answers };
}
beforeEach(() => {
  adoptLaunch({ store: "cloud", userId: U, backendUrl: "http://127.0.0.1:1" });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    orderByProject: {},
    runsByProject: {},
    skipsByProject: {},
    runsByAutomation: {},
    skipsByAutomation: {},
    enabledIds: [],
    enablementRead: false,
  });
  useCloudPlacesStore.setState({ thisRunnerId: R });
  clearCloudAutomations();
});
afterEach(() => {
  source?.close();
  installCloudAutomationSource(null);
  adoptLaunch(LOCAL_LAUNCH);
  vi.unstubAllGlobals();
});

describe("Automation source seam", () => {
  it("selects the launch source, not the experiments flag; a missing cloud source never reads local IPC", () => {
    const local = { list: vi.fn() };
    vi.stubGlobal("window", { api: { automations: local } });
    adoptLaunch(LOCAL_LAUNCH);
    expect(automationSourceIsCloud()).toBe(false);
    expect(automationSource()).toBe(local);
    adoptLaunch({ store: "cloud", userId: U, backendUrl: "http://127.0.0.1:1" });
    expect(() => automationSource()).toThrow("isn’t connected");
    expect(local.list).not.toHaveBeenCalled();
    setup();
    expect(automationSource()).toBe(source);
  });
  it("maps live definitions, active armings, shared order and schedule enablement without a machine switch", async () => {
    const { cloud } = setup();
    await source.list({ projectId: P });
    await source.armings({ projectId: P });
    await source.columnOrders({ projectId: P });
    await source.schedules(P);
    await source.runners();
    await source.pending(P);
    expect(useAutomationsStore.getState().byProject[P]).toEqual([automation]);
    expect(useAutomationsStore.getState().orderByProject[P]?.[0]?.rankedAutomationIds).toEqual([A]);
    expect(await source.enablement()).toEqual({ ok: true, enabledAutomationIds: [A] });
    cloud.answer("automations:armings", { projectId: P }, [
      { ...arming, pausedAt: 20, pausedReason: "moved" },
    ]);
    cloud.answer("automations:schedules", { projectId: P }, [
      { ...schedule, pausedAt: 20, pausedReason: "runner_removed" },
    ]);
    expect(useAutomationsStore.getState().armingByProject[P]).toEqual([]);
    expect(useAutomationsStore.getState().enabledIds).toEqual([]);
    expect(useCloudAutomationsStore.getState().armings[P]?.[0]?.armedByDisplayName).toBe("Ada");
    cloud.answer("automations:list", { projectId: P }, [
      { ...automation, name: "Changed elsewhere" },
    ]);
    expect(useAutomationsStore.getState().byProject[P]?.[0]?.name).toBe("Changed elsewhere");
    expect(cloud.watchers("automations:list", { projectId: P })).toBe(1);
    source.closeProject(P);
    expect(cloud.watchers("automations:list", { projectId: P })).toBe(0);
  });
  it("maps CRUD to Convex with stable caller ids and no global definitions", async () => {
    const { cloud, answers } = setup();
    await source.list({ projectId: P });
    const draft = {
      commandId: A,
      projectId: P,
      name: "New",
      instructions: "Work",
      runtime: null,
      trigger: NO_AUTOMATION_TRIGGER,
    };
    const creating = source.create(draft);
    expect(cloud.mutations[0]).toMatchObject({
      name: "automations:create",
      args: { ...draft, automationId: A },
    });
    answers.list = [{ ...automation, name: "New" }];
    cloud.mutations[0]!.resolve({ automationId: A });
    expect(await creating).toMatchObject({ ok: true, automation: { name: "New" } });
    const { projectId: _project, ...update } = draft;
    const updating = source.update({ ...update, automationId: A });
    cloud.mutations[1]!.resolve({ automationId: A });
    await updating;
    expect(cloud.mutations[1]?.name).toBe("automations:update");
    const deleting = source.delete({ commandId: A, automationId: A });
    cloud.mutations[2]!.resolve({ automationId: A });
    await deleting;
    expect(cloud.mutations[2]?.name).toBe("automations:remove");
    await expect(source.create({ ...draft, projectId: null })).rejects.toThrow("Choose a project");
  });
  it("arms on this Mac or a chosen own runner, maps ranking and schedule on/off to arm/disarm", async () => {
    const { cloud } = setup();
    await source.list({ projectId: P });
    let write = source.arm({ commandId: A, projectId: P, status: "doing", automationId: A });
    expect(cloud.mutations[0]?.args.runnerId).toBe(R);
    cloud.mutations[0]!.resolve({});
    await write;
    write = source.arm({
      commandId: A,
      projectId: P,
      status: "doing",
      automationId: A,
      runnerId: "another",
    });
    expect(cloud.mutations[1]?.args.runnerId).toBe("another");
    cloud.mutations[1]!.resolve({});
    await write;
    const order = source.setColumnOrder({
      commandId: A,
      projectId: P,
      status: "doing",
      rankedAutomationIds: [A],
    });
    expect(cloud.mutations[2]?.args.rankedIds).toEqual([A]);
    expect(cloud.mutations[2]?.args).not.toHaveProperty("rankedAutomationIds");
    cloud.mutations[2]!.resolve({});
    await order;
    const on = source.setEnabled({ commandId: A, automationId: A, enabled: true });
    expect(cloud.mutations[3]).toMatchObject({
      name: "automations:armSchedule",
      args: { runnerId: R },
    });
    cloud.mutations[3]!.resolve({});
    await on;
    const off = source.setEnabled({ commandId: A, automationId: A, enabled: false });
    expect(cloud.mutations[4]?.name).toBe("automations:disarmSchedule");
    cloud.mutations[4]!.resolve({});
    await off;
  });
  it("queues ticket, unbound and Board runs on the caller's runner; the backend owns Place fallback", async () => {
    const { cloud } = setup();
    const ticket = source.queueRun({
      commandId: A,
      ticketId: T,
      target: { kind: "automation", automationId: A },
      modelOverride: null,
    });
    expect(cloud.mutations[0]?.args).toEqual({
      commandId: A,
      ticketId: T,
      automationId: A,
      runnerId: R,
      modelOverride: null,
    });
    cloud.mutations[0]!.resolve({});
    await ticket;
    const unbound = source.queueRun({
      commandId: A,
      ticketId: T,
      target: { kind: "unbound", instructions: "Test" },
      modelOverride: null,
    });
    expect(cloud.mutations[1]?.args.instructions).toBe("Test");
    cloud.mutations[1]!.resolve({});
    await unbound;
    const board = source.queueProjectRun({ commandId: A, automationId: A, projectId: P });
    expect(cloud.mutations[2]?.args).toEqual({ commandId: A, automationId: A, runnerId: R });
    cloud.mutations[2]!.resolve({});
    await board;
  });
  it("keeps all Run states live and loads additional history pages without duplicate rows", async () => {
    const { cloud } = setup();
    cloud.queries.set("automations:runsForProject", (args) => ({
      page: [
        (args as { paginationOpts: { cursor: string | null } }).paginationOpts.cursor === null
          ? run()
          : run({ id: "older", status: "skipped", dueAt: 0, missedCount: 3 }),
      ],
      isDone:
        (args as { paginationOpts: { cursor: string | null } }).paginationOpts.cursor !== null,
      continueCursor: "next",
    }));
    await source.runsForProject({ projectId: P });
    expect(useCloudAutomationsStore.getState().histories[P]).toHaveLength(1);
    expect(source.hasMore(P)).toBe(true);
    await source.loadMore(P);
    expect(useCloudAutomationsStore.getState().histories[P]).toHaveLength(2);
    expect(source.hasMore(P)).toBe(false);
    await source.runsForAutomation({ projectId: P, automationId: A });
    expect(useCloudAutomationsStore.getState().histories[automationHistoryKey(P, A)]).toHaveLength(
      1,
    );
    const started = run({
      status: "started",
      model: { providerId: "p", modelId: "m", reasoningLevel: "high" },
      sessionAccess: "ready",
    });
    cloud.answer(
      "automations:runsForProject",
      { projectId: P, paginationOpts: { numItems: 50, cursor: null, endCursor: "next" } },
      { page: [started], isDone: false, continueCursor: "next" },
    );
    expect(useAutomationsStore.getState().runsByProject[P]?.[0]?.model.modelId).toBe("m");
  });
  it("maps cancel and failed-arrival Retry to their exact jobs and retained intent", async () => {
    const { cloud, answers } = setup();
    answers.pendingArrivals = { pending: [], failures: [{ runId: A, retryCommandId: T }] };
    await source.pending(P);
    const cancel = source.cancel(T);
    expect(cloud.mutations[0]).toMatchObject({
      name: "automations:cancelPendingArrival",
      args: { jobId: T },
    });
    cloud.mutations[0]!.resolve({});
    await cancel;
    const retry = source.retry(A);
    expect(cloud.mutations[1]).toMatchObject({
      name: "automations:retryArrival",
      args: { commandId: T, runId: A, runnerId: R },
    });
    cloud.mutations[1]!.resolve({});
    await retry;
    await expect(source.retry("gone")).rejects.toThrow("no longer available");
  });
  it("optimistically paints a shared-rule edit and rolls it back on refusal", async () => {
    const { cloud, answers } = setup();
    const row = {
      ...automation,
      deletedAt: null,
      createdBy: { kind: "person", userId: U },
      triggerSpec: automation.trigger,
    };
    answers.list = [row];
    cloud.answer("automations:list", { projectId: P }, [row]);
    await source.list({ projectId: P });
    const editing = source.update({
      commandId: T,
      automationId: A,
      name: "Changed",
      instructions: "Work",
      runtime: null,
      trigger: NO_AUTOMATION_TRIGGER,
    });
    expect(useAutomationsStore.getState().byProject[P]?.[0]?.name).toBe("Changed");
    cloud.mutations[0]!.reject(refusal("name_taken", "That name is taken"));
    await expect(editing).rejects.toThrow("That name is taken");
    expect(useAutomationsStore.getState().byProject[P]?.[0]?.name).toBe("Review");
  });
  it("reports a watched read failure once until recovery", async () => {
    const { cloud } = setup();
    await source.list({ projectId: P });
    cloud.fail("automations:list", { projectId: P }, new Error("Read failed"));
    cloud.fail("automations:list", { projectId: P }, new Error("Read failed again"));
    expect(source.onError).toHaveBeenCalledTimes(1);
    cloud.answer("automations:list", { projectId: P }, []);
    cloud.fail("automations:list", { projectId: P }, new Error("Read failed"));
    expect(source.onError).toHaveBeenCalledTimes(2);
  });
  it("refuses offline writes, surfaces backend refusals, and ignores a late read after close", async () => {
    const { cloud } = setup();
    cloud.connected = false;
    await expect(
      source.arm({ commandId: A, projectId: P, status: "doing", automationId: A }),
    ).rejects.toThrow("Read-only");
    expect(cloud.mutations).toHaveLength(0);
    cloud.connected = true;
    const write = source.arm({ commandId: A, projectId: P, status: "doing", automationId: A });
    cloud.mutations[0]!.reject(refusal("runner_needs_update", "Update Volli on Ada’s Mac"));
    await expect(write).rejects.toThrow("Update Volli");
    let finish!: (rows: unknown) => void;
    cloud.queries.set(
      "automations:list",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = source.list({ projectId: P });
    source.close();
    finish([automation]);
    await expect(reading).rejects.toThrow("Workspace changed");
    expect(useAutomationsStore.getState().byProject[P]).toBeUndefined();
  });
});
