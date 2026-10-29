import { describe, expect, it, vi } from "vite-plus/test";
import type { MoveRow } from "@volli/host-core/cloud-move";
import type { ThisMacRunnerSnapshot } from "@volli/shared";
import { createMoveRearm } from "./rearm";

const row: MoveRow = {
  moveId: "move",
  queueId: "queue",
  projectId: "project",
  userId: "person",
  workspaceId: "workspace",
  runnerId: "runner",
  position: 0,
  state: "confirmed",
  paused: null,
  journal: {},
  failure: null,
  report: { ok: true },
  appVersion: "0.3.0",
  mapperVersion: 1,
  manifestSha256: null,
  supersedes: null,
  createdAt: 1,
  updatedAt: 2,
  committedAt: 2,
  confirmedAt: 2,
  returnedAt: null,
};
const list = {
  projectId: "project",
  columns: [{ automationId: "column", name: "Review", status: "needs_review" }],
  schedules: [{ automationId: "schedule", name: "Nightly" }],
  inertGlobals: [{ id: "global", name: "Personal helper" }],
};
function setup() {
  let owner: string | null = "person";
  let full: Pick<ThisMacRunnerSnapshot, "state" | "runnerId"> | null = {
    state: "online",
    runnerId: "runner",
  };
  let answer: unknown = list;
  let roster: unknown = [
    { id: "runner", kind: "mac", status: "online", capabilities: { tools: ["automation.run"] } },
  ];
  const query = vi.fn(async (path: string, _args: Record<string, unknown>): Promise<unknown> =>
    path === "projectImports:rearmList" ? answer : roster,
  );
  const mutation = vi.fn(async (_path: string, _args: Record<string, unknown>) => null);
  const fullRunner = vi.fn(() => full);
  const port = createMoveRearm({ backend: { query, mutation }, personId: () => owner, fullRunner });
  return {
    port,
    query,
    mutation,
    fullRunner,
    person(value: string | null) {
      owner = value;
    },
    runner(value: typeof full) {
      full = value;
    },
    list(value: unknown) {
      answer = value;
    },
    roster(value: unknown) {
      roster = value;
    },
  };
}

describe("moved Automation result bridge", () => {
  it("reads names and inert globals without ever starting the registration-only runner", async () => {
    const f = setup();
    f.runner(null);
    expect(await f.port.read(row)).toEqual({
      columns: list.columns,
      schedules: list.schedules,
      inertGlobals: list.inertGlobals,
      canRearmOnThisMac: false,
      unavailable: "Open in Volli Cloud to re-arm on this Mac.",
      retryable: false,
    });
    expect(f.query).toHaveBeenCalledTimes(1);
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow("Open in Volli Cloud");
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("requires this Mac online and its real advertised capability, never another available runner", async () => {
    const f = setup();
    f.runner({ state: "offline", runnerId: "runner" });
    expect((await f.port.read(row)).canRearmOnThisMac).toBe(false);
    f.runner({ state: "online", runnerId: "runner" });
    f.roster([
      { id: "another", kind: "mac", status: "online", capabilities: { tools: ["automation.run"] } },
    ]);
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow("connect");
    f.roster([{ id: "runner", kind: "mac", status: "online", capabilities: { tools: [] } }]);
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow("Update Volli");
    f.roster([
      {
        id: "runner",
        kind: "linux",
        status: "online",
        capabilities: { tools: ["automation.run"] },
      },
    ]);
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow("connect");
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("offers an immediate fresh retry when this Mac becomes ready without starting work", async () => {
    const f = setup();
    f.roster([
      { id: "runner", kind: "mac", status: "offline", capabilities: { tools: ["automation.run"] } },
    ]);
    expect(await f.port.read(row)).toMatchObject({ canRearmOnThisMac: false, retryable: true });
    f.roster([
      { id: "runner", kind: "mac", status: "online", capabilities: { tools: ["automation.run"] } },
    ]);
    expect(await f.port.read(row, true)).toMatchObject({
      canRearmOnThisMac: true,
      retryable: false,
    });
    expect(f.query).toHaveBeenCalledTimes(4);
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it.each([
    [
      { kind: "column", automationId: "column", status: "needs_review" } as const,
      "automations:arm",
      { projectId: "project", status: "needs_review" },
    ],
    [{ kind: "schedule", automationId: "schedule" } as const, "automations:armSchedule", {}],
  ])(
    "re-reads and explicitly re-arms %j through the ordinary receipt door",
    async (target, path, extra) => {
      const f = setup();
      expect((await f.port.read(row)).canRearmOnThisMac).toBe(true);
      expect(f.mutation).not.toHaveBeenCalled();
      await f.port.perform(row, target);
      expect(f.query).toHaveBeenCalledWith("projectImports:rearmList", { moveId: "move" });
      expect(f.query).toHaveBeenCalledWith("runners:list", {});
      expect(f.mutation).toHaveBeenCalledOnce();
      expect(f.mutation).toHaveBeenCalledWith(path, {
        commandId: expect.any(String),
        automationId: target.automationId,
        runnerId: "runner",
        ...extra,
      });
      f.list({ ...list, columns: [], schedules: [] });
      expect((await f.port.read(row)).columns).toEqual([]);
    },
  );
  it("admits a live capable Mac whose backend reports degraded, as the ordinary arming rule does", async () => {
    const f = setup();
    f.roster([
      {
        id: "runner",
        kind: "mac",
        status: "degraded",
        capabilities: { tools: ["automation.run"] },
      },
    ]);
    expect((await f.port.read(row)).canRearmOnThisMac).toBe(true);
  });
  it.each([
    ["runner_needs_update", "Update Volli"],
    ["runner_not_live", "Waiting for this Mac"],
    ["runner_not_yours", "person who started"],
    ["forbidden", "Workspace access changed"],
    ["automation_not_found", "Automation changed"],
  ])("maps %s to safe actionable copy", async (code, message) => {
    const f = setup();
    f.mutation.mockRejectedValue({ data: { code, message: "private Automation definition" } });
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow(message);
  });
  it("retains scoped names on a capability-read failure but never enables re-arm", async () => {
    const f = setup();
    f.query.mockImplementation(async (path) => {
      if (path === "projectImports:rearmList") return list;
      throw new Error("private backend prose");
    });
    expect(await f.port.read(row)).toMatchObject({
      columns: list.columns,
      inertGlobals: list.inertGlobals,
      canRearmOnThisMac: false,
      retryable: true,
      unavailable: "Couldn’t read paused Automations.",
    });
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("never offers global definitions or stale column/status pairs as re-arm targets", async () => {
    const f = setup();
    await expect(f.port.perform(row, { kind: "schedule", automationId: "global" })).rejects.toThrow(
      "no longer paused",
    );
    await expect(
      f.port.perform(row, { kind: "column", automationId: "column", status: "doing" }),
    ).rejects.toThrow("no longer paused");
    await f.port.read(row);
    f.list({ ...list, schedules: [] });
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow("no longer paused");
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("does not leak one person's globals through a late answer or re-arm on a changed sign-in", async () => {
    const f = setup();
    f.query.mockImplementationOnce(async () => {
      f.person("someone-else");
      return list;
    });
    const answer = await f.port.read(row);
    expect(answer.inertGlobals).toEqual([]);
    expect(answer.canRearmOnThisMac).toBe(false);
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow("person who started");
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("rechecks the full runner after asynchronous capability reads", async () => {
    const f = setup();
    f.query.mockImplementation(async (path) => {
      if (path === "projectImports:rearmList") return list;
      f.runner({ state: "offline", runnerId: "runner" });
      return [
        {
          id: "runner",
          kind: "mac",
          status: "online",
          capabilities: { tools: ["automation.run"] },
        },
      ];
    });
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow("connect");
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("keeps invalid responses non-retryable and sanitizes mutation refusals", async () => {
    const f = setup();
    f.list({ ...list, projectId: "another" });
    expect(await f.port.read(row)).toMatchObject({
      inertGlobals: [],
      retryable: false,
      unavailable: "These Automation details need a newer Volli build.",
    });
    await f.port.read(row);
    expect(f.query).toHaveBeenCalledOnce();
    f.list(list);
    f.mutation.mockRejectedValue(new Error("private definition and instructions"));
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow("Couldn’t re-arm this Automation. Try again.");
    expect((await f.port.read(row)).canRearmOnThisMac).toBe(true);
  });
  it("retries transient list failures but does not loop on an unavailable backend feature", async () => {
    const f = setup();
    f.query.mockRejectedValueOnce(new Error("private backend details"));
    expect((await f.port.read(row)).retryable).toBe(true);
    expect((await f.port.read(row)).canRearmOnThisMac).toBe(true);
    const old = setup();
    old.query.mockRejectedValue({ data: { code: "feature_unavailable" } });
    expect(await old.port.read(row)).toMatchObject({
      retryable: false,
      unavailable: "Re-arm when Automations are available in Volli Cloud.",
    });
    await old.port.read(row);
    expect(old.query).toHaveBeenCalledOnce();
  });
  it("preserves the sign-in recovery after the person backend loses its token", async () => {
    const f = setup();
    f.query.mockRejectedValue(
      Object.assign(new Error("sanitized sign-in failure"), { code: "move_signed_out" }),
    );
    expect(await f.port.read(row)).toMatchObject({
      retryable: false,
      unavailable: "Sign in as the person who started this move.",
    });
    await expect(
      f.port.perform(row, { kind: "schedule", automationId: "schedule" }),
    ).rejects.toThrow("Sign in as the person");
  });
  it("keeps repeated window reads inexpensive and leaves empty project lists inert", async () => {
    const f = setup();
    await f.port.read(row);
    await f.port.read(row);
    expect(f.query).toHaveBeenCalledTimes(2);
    const globals = setup();
    globals.list({ ...list, columns: [], schedules: [] });
    expect(await globals.port.read(row)).toMatchObject({
      canRearmOnThisMac: false,
      unavailable: null,
      inertGlobals: list.inertGlobals,
    });
    expect(globals.fullRunner).not.toHaveBeenCalled();
  });
});
