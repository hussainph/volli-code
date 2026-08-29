import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { Automation, ColumnArming } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import {
  createAutomationsStore,
  selectArmedAutomation,
  selectArmings,
  selectAutomations,
} from "./automations";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    projectId: "p1",
    name: "Review",
    instructions: "/review go",
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Stub the preload bridge with canned list/create/arming implementations. */
function stubApi(impl: {
  list?: () => Promise<unknown>;
  create?: () => Promise<unknown>;
  armings?: () => Promise<unknown>;
  arm?: () => Promise<unknown>;
}) {
  vi.stubGlobal("window", {
    api: {
      automations: {
        list: vi.fn(impl.list ?? (() => Promise.resolve({ ok: true, automations: [] }))),
        create: vi.fn(impl.create ?? (() => Promise.resolve({ ok: false, error: "unused" }))),
        armings: vi.fn(impl.armings ?? (() => Promise.resolve({ ok: true, armings: [] }))),
        arm: vi.fn(impl.arm ?? (() => Promise.resolve({ ok: false, error: "unused" }))),
      },
    },
  });
}

const ARMING: ColumnArming = {
  projectId: "p1",
  status: "doing",
  automationId: "automation-1",
  armedAt: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refresh", () => {
  it("caches the fetched list under its project id", async () => {
    const listed = [automation(), automation({ id: "automation-2", projectId: null })];
    stubApi({ list: () => Promise.resolve({ ok: true, automations: listed }) });
    const store = createAutomationsStore();

    await store.getState().refresh("p1");

    expect(store.getState().byProject["p1"]).toEqual(listed);
  });

  it("toasts a refused read and keeps the previous cache", async () => {
    stubApi({ list: () => Promise.resolve({ ok: false, error: "Unknown project" }) });
    const store = createAutomationsStore();

    await store.getState().refresh("p1");

    expect(store.getState().byProject["p1"]).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load automations: Unknown project",
      expect.anything(),
    );
  });

  it("toasts a transport failure the same way", async () => {
    stubApi({ list: () => Promise.reject(new Error("ipc gone")) });
    const store = createAutomationsStore();

    await store.getState().refresh("p1");

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load automations: ipc gone",
      expect.anything(),
    );
  });
});

describe("editor state", () => {
  it("opens for one project and closes to null", () => {
    stubApi({});
    const store = createAutomationsStore();

    store.getState().openEditor("p1");
    expect(store.getState().editor).toEqual({ projectId: "p1" });
    store.getState().closeEditor();
    expect(store.getState().editor).toBeNull();
  });
});

describe("save", () => {
  it("resolves null on success and refreshes the automation's own project", async () => {
    const saved = automation();
    const list = vi.fn(() => Promise.resolve({ ok: true, automations: [saved] }));
    stubApi({ create: () => Promise.resolve({ ok: true, automation: saved }) });
    (window.api.automations.list as unknown) = list;
    const store = createAutomationsStore();

    const problem = await store
      .getState()
      .save({ projectId: "p1", name: "Review", instructions: "/review go", runtime: null });

    expect(problem).toBeNull();
    expect(list).toHaveBeenCalledWith({ projectId: "p1" });
    expect(store.getState().byProject["p1"]).toEqual([saved]);
  });

  it("refreshes the editor's own project for a GLOBAL save, which lists everywhere", async () => {
    const saved = automation({ projectId: null });
    const list = vi.fn(() => Promise.resolve({ ok: true, automations: [saved] }));
    stubApi({ create: () => Promise.resolve({ ok: true, automation: saved }) });
    (window.api.automations.list as unknown) = list;
    const store = createAutomationsStore();
    store.getState().openEditor("p1");

    const problem = await store
      .getState()
      .save({ projectId: null, name: "Global", instructions: "x", runtime: null });

    expect(problem).toBeNull();
    expect(list).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("skips the refresh when a global save has no editor context to name a project", async () => {
    const saved = automation({ projectId: null });
    const list = vi.fn(() => Promise.resolve({ ok: true, automations: [saved] }));
    stubApi({ create: () => Promise.resolve({ ok: true, automation: saved }) });
    (window.api.automations.list as unknown) = list;
    const store = createAutomationsStore();

    const problem = await store
      .getState()
      .save({ projectId: null, name: "Global", instructions: "x", runtime: null });

    expect(problem).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("resolves the refusal message inline — a correction, never a toast", async () => {
    stubApi({ create: () => Promise.resolve({ ok: false, error: "Name this Automation" }) });
    const store = createAutomationsStore();

    const problem = await store
      .getState()
      .save({ projectId: "p1", name: "", instructions: "x", runtime: null });

    expect(problem).toBe("Name this Automation");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("resolves a transport failure as the same inline shape", async () => {
    stubApi({ create: () => Promise.reject(new Error("ipc gone")) });
    const store = createAutomationsStore();

    const problem = await store
      .getState()
      .save({ projectId: "p1", name: "n", instructions: "x", runtime: null });

    expect(problem).toBe("ipc gone");
  });
});

/* ------------------------------------------------ column arming (VC-128) --- */

describe("refreshArming", () => {
  it("caches one project's armed columns, apart from its Automations", async () => {
    stubApi({ armings: () => Promise.resolve({ ok: true, armings: [ARMING] }) });
    const store = createAutomationsStore();

    await store.getState().refreshArming("p1");

    expect(store.getState().armingByProject["p1"]).toEqual([ARMING]);
    expect(store.getState().byProject["p1"]).toBeUndefined();
  });

  it("toasts a refused read — a person asked for this surface and did not get it", async () => {
    stubApi({ armings: () => Promise.resolve({ ok: false, error: "Unknown project" }) });
    const store = createAutomationsStore();

    await store.getState().refreshArming("p1");

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown project"),
      expect.anything(),
    );
    expect(store.getState().armingByProject["p1"]).toBeUndefined();
  });

  it("toasts a transport throw rather than swallowing it", async () => {
    stubApi({ armings: () => Promise.reject(new Error("ipc gone")) });
    const store = createAutomationsStore();

    await store.getState().refreshArming("p1");

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("ipc gone"),
      expect.anything(),
    );
  });
});

describe("arm", () => {
  it("replaces the project's arming slice from the door's own answer, with no re-read", async () => {
    const armings = vi.fn(() => Promise.resolve({ ok: true, armings: [] }));
    stubApi({ arm: () => Promise.resolve({ ok: true, armings: [ARMING] }) });
    (window.api.automations.armings as unknown) = armings;
    const store = createAutomationsStore();

    const refusal = await store
      .getState()
      .arm({ projectId: "p1", status: "doing", automationId: "automation-1" });

    expect(refusal).toBeNull();
    expect(store.getState().armingByProject["p1"]).toEqual([ARMING]);
    expect(armings).not.toHaveBeenCalled();
  });

  it("resolves a refusal for the caller rather than toasting behind it", async () => {
    stubApi({ arm: () => Promise.resolve({ ok: false, error: "not offered here" }) });
    const store = createAutomationsStore();

    expect(
      await store.getState().arm({ projectId: "p1", status: "doing", automationId: "a9" }),
    ).toBe("not offered here");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("resolves a transport throw as the same shape", async () => {
    stubApi({ arm: () => Promise.reject(new Error("ipc gone")) });
    const store = createAutomationsStore();

    expect(
      await store.getState().arm({ projectId: "p1", status: "doing", automationId: null }),
    ).toBe("ipc gone");
  });
});

describe("selectors", () => {
  it("hand back frozen empties for a project nothing has read yet", () => {
    const store = createAutomationsStore();
    const state = store.getState();

    expect(selectAutomations(state, "p1")).toEqual([]);
    expect(selectArmings(state, "p1")).toEqual([]);
    // Same reference twice: a fresh [] per call would defeat every memo reading it.
    expect(selectAutomations(state, "p1")).toBe(selectAutomations(state, "p2"));
    expect(selectArmings(state, "p1")).toBe(selectArmings(state, "p2"));
  });

  it("resolves the armed Automation through the shared rule, not the raw row", async () => {
    const offered = automation({ trigger: { kind: "columns", columns: ["doing"] } });
    stubApi({
      list: () => Promise.resolve({ ok: true, automations: [offered] }),
      armings: () => Promise.resolve({ ok: true, armings: [ARMING] }),
    });
    const store = createAutomationsStore();
    await store.getState().refresh("p1");
    await store.getState().refreshArming("p1");

    expect(selectArmedAutomation(store.getState(), "p1", "doing")).toEqual(offered);
    expect(selectArmedAutomation(store.getState(), "p1", "todo")).toBeNull();
  });

  it("reads an arming whose Automation no longer offers the column as unarmed", async () => {
    stubApi({
      list: () => Promise.resolve({ ok: true, automations: [automation()] }),
      armings: () => Promise.resolve({ ok: true, armings: [ARMING] }),
    });
    const store = createAutomationsStore();
    await store.getState().refresh("p1");
    await store.getState().refreshArming("p1");

    expect(selectArmedAutomation(store.getState(), "p1", "doing")).toBeNull();
  });
});
