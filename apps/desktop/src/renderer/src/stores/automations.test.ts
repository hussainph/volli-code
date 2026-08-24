import type { Automation } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import { createAutomationsStore } from "./automations";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    projectId: "p1",
    name: "Review",
    instructions: "/review go",
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Stub the preload bridge with canned list/create implementations. */
function stubApi(impl: { list?: () => Promise<unknown>; create?: () => Promise<unknown> }) {
  vi.stubGlobal("window", {
    api: {
      automations: {
        list: vi.fn(impl.list ?? (() => Promise.resolve({ ok: true, automations: [] }))),
        create: vi.fn(impl.create ?? (() => Promise.resolve({ ok: false, error: "unused" }))),
      },
    },
  });
}

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
