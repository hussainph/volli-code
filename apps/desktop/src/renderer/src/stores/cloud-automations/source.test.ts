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
import { ConvexAutomationSource, resolvedRunModel } from "./source";
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
    const fromStore = useAutomationsStore.getState().setEnabled(A, true, R);
    expect(cloud.mutations[5]?.args.runnerId).toBe(R);
    cloud.mutations[5]!.resolve({});
    await fromStore;
  });
  it("queues ticket, unbound and Board runs on the caller's runner; the backend owns Place fallback", async () => {
    const { cloud } = setup();
    const ticket = source.queueRun({
      projectId: P,
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
      projectId: P,
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
    const cancel = source.cancel(P, T);
    expect(cloud.mutations[0]).toMatchObject({
      name: "automations:cancelPendingArrival",
      args: { jobId: T },
    });
    cloud.mutations[0]!.resolve({});
    await cancel;
    const retry = source.retry({ projectId: P, runId: A, retryCommandId: T });
    expect(cloud.mutations[1]).toMatchObject({
      name: "automations:retryArrival",
      args: { commandId: T, runId: A, runnerId: R },
    });
    cloud.mutations[1]!.resolve({});
    await retry;
    // Historical failures remain retryable even outside pendingArrivals' bounded window.
    const old = source.retry({ projectId: P, runId: "old-run", retryCommandId: T });
    expect(cloud.mutations[2]?.args.runId).toBe("old-run");
    cloud.mutations[2]!.resolve({});
    await old;
  });
  it("checks the project's read-only fence for manual, cancel and retry writes", async () => {
    const { cloud } = setup();
    source.close();
    const check = vi.fn((projectId: string) => (projectId === P ? "Project is read-only" : null));
    source = new ConvexAutomationSource(cloud.session, check);
    await expect(source.cancel(P, T)).rejects.toThrow("Project is read-only");
    await expect(source.retry({ projectId: P, runId: A, retryCommandId: T })).rejects.toThrow(
      "Project is read-only",
    );
    await expect(
      source.queueRun({
        projectId: P,
        commandId: A,
        ticketId: T,
        target: { kind: "automation", automationId: A },
        modelOverride: null,
      }),
    ).rejects.toThrow("Project is read-only");
    expect(cloud.mutations).toHaveLength(0);
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
    await expect(editing).rejects.toThrow("An Automation with that name already exists");
    expect(useAutomationsStore.getState().byProject[P]?.[0]?.name).toBe("Review");
  });
  it("follows an accepted Run until its Session is ready, then releases the watch", () => {
    const { cloud } = setup();
    const settled = vi.fn();
    source.followRun(P, A, settled);
    cloud.answer("automations:runState", { runId: A }, run());
    cloud.answer(
      "automations:runState",
      { runId: A },
      run({ status: "started", sessionAccess: "starting" }),
    );
    expect(settled).not.toHaveBeenCalled();
    cloud.answer(
      "automations:runState",
      { runId: A },
      run({ status: "started", sessionAccess: "ready" }),
    );
    expect(settled).toHaveBeenCalledOnce();
    expect(cloud.watchers("automations:runState", { runId: A })).toBe(0);
    source.followRun(P, T, settled);
    source.closeProject(P);
    cloud.answer("automations:runState", { runId: T }, run({ status: "failed" }));
    expect(settled).toHaveBeenCalledOnce();
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
  it("reads legacy projections without inventing models or skipping unknown evidence", async () => {
    const { cloud } = setup();
    for (const value of [
      undefined,
      null,
      "model",
      {},
      { providerId: "p" },
      { providerId: "p", modelId: "m" },
    ])
      expect(resolvedRunModel(value)).toBeNull();
    const model = { providerId: "p", modelId: "m", reasoningLevel: "high" };
    const rows = [
      run({ id: "attended", status: "started", model }),
      run({ id: "auto", status: "started", model, attendance: "unattended" }),
      run({ id: "no-session", status: "started", sessionId: null, model }),
      run({ id: "no-model", status: "started" }),
      run({ id: "skip", status: "skipped", automationName: null, dueAt: null, missedCount: null }),
      run({ id: "unbound-skip", status: "skipped", automationId: null }),
    ];
    for (const name of ["runsForProject", "runsForAutomation"])
      cloud.queries.set(`automations:${name}`, () => ({
        page: rows,
        isDone: true,
        continueCursor: "end",
      }));
    expect(await source.runsForProject({ projectId: P })).toMatchObject({
      runs: [{ attendance: "attended" }, { attendance: "unattended" }],
    });
    expect(await source.skipsForProject({ projectId: P })).toMatchObject({
      skips: [{ automationName: "Automation", dueAt: 1, missedCount: 1 }],
    });
    await source.runsForAutomation({ projectId: P, automationId: A });
    expect(await source.skipsForAutomation({ projectId: P, automationId: A })).toMatchObject({
      skips: [{ id: "skip" }],
    });
    expect(source.hasMore("missing")).toBe(false);
    await source.loadMore("missing");
    await source.loadMore(P);
    source.closeProject("other");
    source.closeProject(P);
  });
  it("refuses edits of missing records and handles deletion racing a create reply", async () => {
    const { cloud, answers } = setup();
    await expect(
      source.update({
        commandId: T,
        automationId: A,
        name: "Review",
        instructions: "Work",
        runtime: null,
        trigger: NO_AUTOMATION_TRIGGER,
      }),
    ).rejects.toThrow("Open this Automation");
    answers.list = [];
    const creating = source.create({
      commandId: T,
      projectId: P,
      name: "Review",
      instructions: "Work",
      runtime: null,
      trigger: NO_AUTOMATION_TRIGGER,
    });
    cloud.mutations[0]!.resolve({ automationId: A });
    await expect(creating).rejects.toThrow("no longer available");
  });
  it("keeps transport usable without an optimistic identity and surfaces untyped or new refusals", async () => {
    const { cloud } = setup();
    adoptLaunch(LOCAL_LAUNCH);
    const draft = {
      commandId: A,
      projectId: P,
      name: "Review",
      instructions: "Work",
      runtime: null,
      trigger: NO_AUTOMATION_TRIGGER,
    };
    const creating = source.create(draft);
    cloud.mutations[0]!.resolve({ automationId: A });
    await creating;
    const updating = source.update({ ...draft, automationId: A });
    cloud.mutations[1]!.resolve({});
    await updating;
    const armingWrite = source.arm({
      commandId: A,
      projectId: P,
      status: "doing",
      automationId: null,
    });
    cloud.mutations[2]!.resolve({});
    await armingWrite;
    await source.runners();
    const old = source.arm({ commandId: A, projectId: P, status: "doing", automationId: A });
    cloud.mutations[3]!.reject(refusal("runner_needs_update", "raw code"));
    await expect(old).rejects.toThrow("Update Volli on Ada’s Mac");
    const newer = source.cancel(P, T);
    cloud.mutations[4]!.reject(refusal("new_code", "New recovery"));
    await expect(newer).rejects.toThrow("New recovery");
    const plain = source.cancel(P, T);
    cloud.mutations[5]!.reject(new Error("Connection broke"));
    await expect(plain).rejects.toThrow("Connection broke");
    const finishing = source.cancel(P, T);
    source.close();
    cloud.mutations[6]!.resolve({});
    await expect(finishing).rejects.toThrow("Workspace changed");
  });
  it("fences a removed project's in-flight read and stale callbacks, including a reopened id", async () => {
    const { cloud } = setup();
    const callbacks: (() => void)[] = [];
    const original = cloud.session.client.watchQuery.bind(cloud.session.client);
    vi.spyOn(cloud.session.client, "watchQuery").mockImplementation(
      (...args: Parameters<typeof original>) => {
        const [reference, queryArgs, options] = args;
        const watch = original(reference, queryArgs, options);
        return {
          ...watch,
          onUpdate: (callback) => {
            callbacks.push(callback);
            return watch.onUpdate(callback);
          },
        };
      },
    );
    await source.list({ projectId: P });
    source.closeProject(P);
    await source.list({ projectId: P });
    const old = callbacks[0]!;
    old();
    expect(useAutomationsStore.getState().byProject[P]?.[0]?.name).toBe("Review");
    let finish!: (value: unknown) => void;
    cloud.queries.set(
      "automations:list",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = source.list({ projectId: P });
    source.closeProject(P);
    finish([]);
    await expect(reading).rejects.toThrow("project is no longer");
    source.close();
    old();
  });
  it.each(["project", "client"] as const)(
    "retires a query closed synchronously during %s subscription",
    async (kind) => {
      const { cloud } = setup();
      const stop = vi.fn();
      const original = cloud.session.client.watchQuery.bind(cloud.session.client);
      vi.spyOn(cloud.session.client, "watchQuery").mockImplementation(
        (...args: Parameters<typeof original>) => {
          const [reference, queryArgs, options] = args;
          const watch = original(reference, queryArgs, options);
          return {
            ...watch,
            onUpdate: (callback) => {
              callback();
              if (kind === "client") source.close();
              else source.closeProject(P);
              return stop;
            },
          };
        },
      );
      await expect(source.list({ projectId: P })).rejects.toThrow("project is no longer");
      expect(stop).toHaveBeenCalledOnce();
    },
  );
  it("retires synchronous Run settlement and surfaces subscription failure", () => {
    const { cloud } = setup();
    const callbacks: (() => void)[] = [];
    const original = cloud.session.client.watchQuery.bind(cloud.session.client);
    vi.spyOn(cloud.session.client, "watchQuery").mockImplementation(
      (...args: Parameters<typeof original>) => {
        const [reference, queryArgs, options] = args;
        const watch = original(reference, queryArgs, options);
        return {
          ...watch,
          onUpdate: (callback) => {
            callbacks.push(callback);
            const stop = watch.onUpdate(callback);
            callback();
            return stop;
          },
        };
      },
    );
    cloud.answer(
      "automations:runState",
      { runId: A },
      run({ status: "started", sessionAccess: "ready" }),
    );
    const settled = vi.fn();
    source.followRun(P, A, settled);
    expect(settled).toHaveBeenCalledOnce();
    source.followRun(P, T, settled);
    source.followRun(P, T, settled);
    callbacks[1]!();
    cloud.fail("automations:runState", { runId: T }, new Error("Read failed"));
    expect(source.onError).toHaveBeenCalledOnce();
    source.close();
    callbacks.at(-1)!();
  });
  it.each([false, true])(
    "pins three history pages and retries an interrupted page (scoped=%s)",
    async (scoped) => {
      const { cloud } = setup();
      const name = scoped ? "automations:runsForAutomation" : "automations:runsForProject";
      const key = scoped ? automationHistoryKey(P, A) : P;
      let failNext = false;
      cloud.queries.set(name, (args) => {
        const opts = (args as { paginationOpts: { cursor: string | null; endCursor?: string } })
          .paginationOpts;
        if (failNext && opts.cursor === "c1" && opts.endCursor === undefined) {
          failNext = false;
          throw new Error("Page unavailable");
        }
        return {
          page: [
            run({
              id: opts.cursor ?? "first",
              createdAt: opts.cursor === null ? 3 : opts.cursor === "c1" ? 2 : 1,
            }),
          ],
          isDone: opts.cursor === "c2",
          continueCursor: opts.cursor === null ? "c1" : opts.cursor === "c1" ? "c2" : "end",
        };
      });
      const read = () =>
        scoped
          ? source.runsForAutomation({ projectId: P, automationId: A })
          : source.runsForProject({ projectId: P });
      await read();
      failNext = true;
      await expect(source.loadMore(key)).rejects.toThrow("Page unavailable");
      const loading = source.loadMore(key);
      await source.loadMore(key);
      await loading;
      await read();
      await source.loadMore(key);
      await source.loadMore(key);
      expect(useCloudAutomationsStore.getState().histories[key]?.map((row) => row.id)).toEqual([
        "first",
        "c1",
        "c2",
      ]);
      expect(source.hasMore(key)).toBe(false);
      source.closeProject("other");
      source.closeProject(P);
    },
  );
});
