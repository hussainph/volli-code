import type { Automation, AutomationRun, ModelSelection } from "@volli/shared";
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

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "automation-1",
    automationName: "Review",
    ticketId: "t1",
    sessionId: "s1",
    model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
    createdAt: 10,
    ...overrides,
  };
}

/** Stub the preload bridge with canned implementations of the doors used. */
function stubApi(impl: {
  list?: () => Promise<unknown>;
  create?: () => Promise<unknown>;
  update?: () => Promise<unknown>;
  delete?: () => Promise<unknown>;
  runsForProject?: () => Promise<unknown>;
  enablement?: () => Promise<unknown>;
  setEnabled?: () => Promise<unknown>;
}) {
  vi.stubGlobal("window", {
    api: {
      automations: {
        list: vi.fn(impl.list ?? (() => Promise.resolve({ ok: true, automations: [] }))),
        create: vi.fn(impl.create ?? (() => Promise.resolve({ ok: false, error: "unused" }))),
        update: vi.fn(impl.update ?? (() => Promise.resolve({ ok: false, error: "unused" }))),
        delete: vi.fn(impl.delete ?? (() => Promise.resolve({ ok: true, receipt: {} }))),
        runsForProject: vi.fn(
          impl.runsForProject ?? (() => Promise.resolve({ ok: true, runs: [] })),
        ),
        enablement: vi.fn(
          impl.enablement ?? (() => Promise.resolve({ ok: true, disabledAutomationIds: [] })),
        ),
        setEnabled: vi.fn(
          impl.setEnabled ?? (() => Promise.resolve({ ok: true, disabledAutomationIds: [] })),
        ),
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
  it("opens for one project with no record — a create — and closes to null", () => {
    stubApi({});
    const store = createAutomationsStore();

    store.getState().openEditor("p1");
    expect(store.getState().editor).toEqual({ projectId: "p1", automation: null });
    store.getState().closeEditor();
    expect(store.getState().editor).toBeNull();
  });

  it("opens on a record for an edit — the record IS the mode", () => {
    stubApi({});
    const store = createAutomationsStore();
    const existing = automation();

    store.getState().editAutomation("p1", existing);
    expect(store.getState().editor).toEqual({ projectId: "p1", automation: existing });
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

describe("update", () => {
  it("resolves null on success and re-reads the editor's project", async () => {
    const edited = automation({ name: "Review sweep" });
    const list = vi.fn(() => Promise.resolve({ ok: true, automations: [edited] }));
    stubApi({ update: () => Promise.resolve({ ok: true, automation: edited }) });
    (window.api.automations.list as unknown) = list;
    const store = createAutomationsStore();
    store.getState().editAutomation("p1", automation());

    const problem = await store.getState().update({
      automationId: "automation-1",
      name: "Review sweep",
      instructions: "/review go",
      runtime: null,
    });

    expect(problem).toBeNull();
    expect(list).toHaveBeenCalledWith({ projectId: "p1" });
    expect(store.getState().byProject["p1"]).toEqual([edited]);
  });

  it("mints a durable command id when the caller holds none", async () => {
    const update = vi.fn(() => Promise.resolve({ ok: true, automation: automation() }));
    stubApi({ update });
    const store = createAutomationsStore();

    await store
      .getState()
      .update({ automationId: "automation-1", name: "n", instructions: "x", runtime: null });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: expect.stringMatching(/-/) }),
    );
  });

  it("keeps a caller's own command id, so a retry repeats one durable intent", async () => {
    const update = vi.fn(() => Promise.resolve({ ok: true, automation: automation() }));
    stubApi({ update });
    const store = createAutomationsStore();

    await store.getState().update({
      commandId: "11111111-2222-3333-4444-555555555555",
      automationId: "automation-1",
      name: "n",
      instructions: "x",
      runtime: null,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "11111111-2222-3333-4444-555555555555" }),
    );
  });

  it("skips the refresh when nothing names a project to re-read", async () => {
    const list = vi.fn(() => Promise.resolve({ ok: true, automations: [] }));
    stubApi({ update: () => Promise.resolve({ ok: true, automation: automation() }) });
    (window.api.automations.list as unknown) = list;
    const store = createAutomationsStore();

    await store
      .getState()
      .update({ automationId: "automation-1", name: "n", instructions: "x", runtime: null });

    expect(list).not.toHaveBeenCalled();
  });

  it("resolves the refusal inline, and a transport failure the same way", async () => {
    stubApi({ update: () => Promise.resolve({ ok: false, error: "Name this Automation" }) });
    const store = createAutomationsStore();
    expect(
      await store
        .getState()
        .update({ automationId: "a", name: "", instructions: "x", runtime: null }),
    ).toBe("Name this Automation");

    stubApi({ update: () => Promise.reject(new Error("ipc gone")) });
    const other = createAutomationsStore();
    expect(
      await other
        .getState()
        .update({ automationId: "a", name: "n", instructions: "x", runtime: null }),
    ).toBe("ipc gone");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("duplicate", () => {
  it("copies the work under a distinguishable name and opens the copy's form", async () => {
    const source = automation({ name: "Review" });
    const copy = automation({ id: "automation-2", name: "Review (copy)" });
    const create = vi.fn(() => Promise.resolve({ ok: true, automation: copy }));
    stubApi({ create, list: () => Promise.resolve({ ok: true, automations: [source, copy] }) });
    const store = createAutomationsStore();
    store.setState({ byProject: { p1: [source] } });

    await store.getState().duplicate("p1", source);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        name: "Review (copy)",
        instructions: source.instructions,
        runtime: null,
      }),
    );
    // Straight into the copy's own form: the reason to duplicate is to change
    // something, and the Trigger is what VC-112 expects to change.
    expect(store.getState().editor).toEqual({ projectId: "p1", automation: copy });
    expect(store.getState().byProject["p1"]).toEqual([source, copy]);
  });

  it("keeps Ownership, so a global copy is still listed everywhere", async () => {
    const source = automation({ projectId: null, name: "Sweep" });
    const create = vi.fn(() => Promise.resolve({ ok: true, automation: source }));
    stubApi({ create });
    const store = createAutomationsStore();

    await store.getState().duplicate("p1", source);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
  });

  it("copies a valid pin whole, and drops an unreadable stored Runtime to inherit", async () => {
    const pin: ModelSelection = {
      providerId: "anthropic",
      modelId: "claude-opus",
      reasoningLevel: "high",
    };
    const create = vi.fn(() => Promise.resolve({ ok: true, automation: automation() }));
    stubApi({ create });
    const store = createAutomationsStore();

    await store.getState().duplicate("p1", automation({ runtime: pin }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ runtime: pin }));

    await store.getState().duplicate("p1", automation({ runtime: { kind: "invalid", raw: "?" } }));
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ runtime: null }));
  });

  it("toasts a refusal and a transport failure, and opens no editor", async () => {
    stubApi({ create: () => Promise.resolve({ ok: false, error: "Unknown project" }) });
    const store = createAutomationsStore();
    await store.getState().duplicate("p1", automation());
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't duplicate automation: Unknown project",
      expect.anything(),
    );
    expect(store.getState().editor).toBeNull();

    stubApi({ create: () => Promise.reject(new Error("ipc gone")) });
    await store.getState().duplicate("p1", automation());
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't duplicate automation: ipc gone",
      expect.anything(),
    );
  });
});

describe("remove", () => {
  it("deletes the record and re-reads the list — there is no archive", async () => {
    const remove = vi.fn(() => Promise.resolve({ ok: true, receipt: {} }));
    const list = vi.fn(() => Promise.resolve({ ok: true, automations: [] }));
    stubApi({ delete: remove });
    (window.api.automations.list as unknown) = list;
    const store = createAutomationsStore();
    store.setState({ byProject: { p1: [automation()] } });

    await store.getState().remove("p1", automation());

    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ automationId: "automation-1" }));
    expect(store.getState().byProject["p1"]).toEqual([]);
  });

  it("toasts a refusal and a transport failure", async () => {
    stubApi({ delete: () => Promise.resolve({ ok: false, error: "Unknown automation" }) });
    const store = createAutomationsStore();
    await store.getState().remove("p1", automation());
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't delete automation: Unknown automation",
      expect.anything(),
    );

    stubApi({ delete: () => Promise.reject(new Error("ipc gone")) });
    await store.getState().remove("p1", automation());
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't delete automation: ipc gone",
      expect.anything(),
    );
  });
});

describe("run history", () => {
  it("caches a project's Runs in the order main returned them", async () => {
    const listed = [run({ id: "run-2", createdAt: 20 }), run()];
    stubApi({ runsForProject: () => Promise.resolve({ ok: true, runs: listed }) });
    const store = createAutomationsStore();

    await store.getState().refreshRuns("p1");

    expect(store.getState().runsByProject["p1"]).toEqual(listed);
  });

  it("toasts a refusal and keeps the previous cache", async () => {
    stubApi({ runsForProject: () => Promise.resolve({ ok: false, error: "Unknown project" }) });
    const store = createAutomationsStore();

    await store.getState().refreshRuns("p1");

    expect(store.getState().runsByProject["p1"]).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load run history: Unknown project",
      expect.anything(),
    );
  });

  it("toasts a transport failure the same way", async () => {
    stubApi({ runsForProject: () => Promise.reject(new Error("ipc gone")) });
    const store = createAutomationsStore();

    await store.getState().refreshRuns("p1");

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load run history: ipc gone",
      expect.anything(),
    );
  });
});

describe("enablement", () => {
  it("reads the machine-local enabled set, and starts with nothing on", async () => {
    stubApi({
      enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: ["automation-1"] }),
    });
    const store = createAutomationsStore();

    // VC-112: a machine fires nothing until someone turns something on there,
    // so the resting state is the empty set rather than "everything".
    expect(store.getState().enabledIds).toEqual([]);
    await store.getState().refreshEnablement();

    expect(store.getState().enabledIds).toEqual(["automation-1"]);
  });

  it("writes a durable command and adopts the whole set it answers with", async () => {
    stubApi({
      setEnabled: () =>
        Promise.resolve({
          ok: true,
          enabledAutomationIds: ["automation-1", "automation-2"],
          receipt: {},
        }),
    });
    const store = createAutomationsStore();

    await store.getState().setEnabled("automation-2", true);

    expect(store.getState().enabledIds).toEqual(["automation-1", "automation-2"]);
    expect(window.api.automations.setEnabled).toHaveBeenCalledWith({
      // The switch rides the command seam like every other write; only its
      // projection is machine-local (docs/BOUNDARIES.md rule 5).
      commandId: expect.stringMatching(/-/) as unknown as string,
      automationId: "automation-2",
      enabled: true,
    });
  });

  it("toasts a refused read and a refused write, and both transport failures", async () => {
    stubApi({
      enablement: () => Promise.resolve({ ok: false, error: "no db" }),
      setEnabled: () => Promise.resolve({ ok: false, error: "no db" }),
    });
    const store = createAutomationsStore();
    await store.getState().refreshEnablement();
    await store.getState().setEnabled("automation-1", false);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't read which automations are on: no db",
      expect.anything(),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't change that automation: no db",
      expect.anything(),
    );
    expect(store.getState().enabledIds).toEqual([]);

    stubApi({
      enablement: () => Promise.reject(new Error("ipc gone")),
      setEnabled: () => Promise.reject(new Error("ipc gone")),
    });
    await store.getState().refreshEnablement();
    await store.getState().setEnabled("automation-1", false);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't read which automations are on: ipc gone",
      expect.anything(),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't change that automation: ipc gone",
      expect.anything(),
    );
  });
});
