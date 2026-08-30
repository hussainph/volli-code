import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type {
  Automation,
  AutomationRun,
  AutomationSkippedOccurrence,
  AutomationTrigger,
  ColumnArming,
  ColumnAutomationOrder,
  ModelSelection,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import {
  createAutomationsStore,
  selectArmedAutomation,
  selectArmings,
  selectAutomations,
  selectColumnOrders,
  selectColumnRank,
  selectEffectiveArmedAutomation,
  selectOfferedInDigitOrder,
  selectOfferedInRankOrder,
  selectTicketRuns,
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
  skipsForProject?: () => Promise<unknown>;
  runsForTicket?: () => Promise<unknown>;
  enablement?: () => Promise<unknown>;
  setEnabled?: () => Promise<unknown>;
  armings?: () => Promise<unknown>;
  arm?: () => Promise<unknown>;
  columnOrders?: () => Promise<unknown>;
  setColumnOrder?: () => Promise<unknown>;
}) {
  vi.stubGlobal("window", {
    api: {
      automations: {
        list: vi.fn(impl.list ?? (() => Promise.resolve({ ok: true, automations: [] }))),
        create: vi.fn(impl.create ?? (() => Promise.resolve({ ok: false, error: "unused" }))),
        armings: vi.fn(impl.armings ?? (() => Promise.resolve({ ok: true, armings: [] }))),
        arm: vi.fn(impl.arm ?? (() => Promise.resolve({ ok: false, error: "unused" }))),
        update: vi.fn(impl.update ?? (() => Promise.resolve({ ok: false, error: "unused" }))),
        delete: vi.fn(impl.delete ?? (() => Promise.resolve({ ok: true, receipt: {} }))),
        runsForProject: vi.fn(
          impl.runsForProject ?? (() => Promise.resolve({ ok: true, runs: [] })),
        ),
        skipsForProject: vi.fn(
          impl.skipsForProject ?? (() => Promise.resolve({ ok: true, skips: [] })),
        ),
        runsForTicket: vi.fn(impl.runsForTicket ?? (() => Promise.resolve({ ok: true, runs: [] }))),
        // The stored set is the ENABLED one (`automations/enablement.ts`), so
        // the resting default here is an empty enabled set: nothing on.
        enablement: vi.fn(
          impl.enablement ?? (() => Promise.resolve({ ok: true, enabledAutomationIds: [] })),
        ),
        setEnabled: vi.fn(
          impl.setEnabled ??
            (() => Promise.resolve({ ok: true, enabledAutomationIds: [], receipt: {} })),
        ),
        columnOrders: vi.fn(impl.columnOrders ?? (() => Promise.resolve({ ok: true, orders: [] }))),
        setColumnOrder: vi.fn(
          impl.setColumnOrder ?? (() => Promise.resolve({ ok: false, error: "unused" })),
        ),
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

/** A record that is OFFERED in one column — the Trigger, never the column's arming. */
const COLUMNS_TRIGGER: AutomationTrigger = { kind: "columns", columns: ["doing"] };

/** One column's authored rank (VC-132) — machine-local like the arming above it. */
const ORDER: ColumnAutomationOrder = {
  projectId: "p1",
  status: "doing",
  rankedAutomationIds: ["automation-2", "automation-1"],
  orderedAt: 5,
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

    const problem = await store.getState().save({
      projectId: "p1",
      name: "Review",
      instructions: "/review go",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });

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

    const problem = await store.getState().save({
      projectId: null,
      name: "Global",
      instructions: "x",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });

    expect(problem).toBeNull();
    expect(list).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("skips the refresh when a global save has no editor context to name a project", async () => {
    const saved = automation({ projectId: null });
    const list = vi.fn(() => Promise.resolve({ ok: true, automations: [saved] }));
    stubApi({ create: () => Promise.resolve({ ok: true, automation: saved }) });
    (window.api.automations.list as unknown) = list;
    const store = createAutomationsStore();

    const problem = await store.getState().save({
      projectId: null,
      name: "Global",
      instructions: "x",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });

    expect(problem).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("resolves the refusal message inline — a correction, never a toast", async () => {
    stubApi({ create: () => Promise.resolve({ ok: false, error: "Name this Automation" }) });
    const store = createAutomationsStore();

    const problem = await store.getState().save({
      projectId: "p1",
      name: "",
      instructions: "x",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });

    expect(problem).toBe("Name this Automation");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("resolves a transport failure as the same inline shape", async () => {
    stubApi({ create: () => Promise.reject(new Error("ipc gone")) });
    const store = createAutomationsStore();

    const problem = await store.getState().save({
      projectId: "p1",
      name: "n",
      instructions: "x",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });

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

describe("a planning read's own answer", () => {
  it("says whether the cache now holds THIS read, not merely that it settled", async () => {
    // What a slice cannot say for itself. Each of the three refreshes resolves
    // its landing, so a caller re-reading on arrival (VC-129's rail) can tell a
    // value just confirmed from one that only survived a failed re-read.
    stubApi({
      list: () => Promise.resolve({ ok: true, automations: [automation()] }),
      armings: () => Promise.resolve({ ok: true, armings: [ARMING] }),
      enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: ["automation-1"] }),
    });
    const store = createAutomationsStore();

    expect(await store.getState().refresh("p1")).toBe(true);
    expect(await store.getState().refreshArming("p1")).toBe(true);
    expect(await store.getState().refreshEnablement()).toBe(true);
  });

  it("answers false for a refused or thrown read, and leaves the warm value alone", async () => {
    stubApi({
      list: () => Promise.resolve({ ok: true, automations: [automation()] }),
      armings: () => Promise.resolve({ ok: true, armings: [ARMING] }),
      enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: ["automation-1"] }),
    });
    const store = createAutomationsStore();
    await store.getState().refresh("p1");
    await store.getState().refreshArming("p1");
    await store.getState().refreshEnablement();

    stubApi({
      list: () => Promise.resolve({ ok: false, error: "Unknown project" }),
      armings: () => Promise.reject(new Error("ipc gone")),
      enablement: () => Promise.resolve({ ok: false, error: "no db" }),
    });

    expect(await store.getState().refresh("p1")).toBe(false);
    expect(await store.getState().refreshArming("p1")).toBe(false);
    expect(await store.getState().refreshEnablement()).toBe(false);
    // The stale values are still there, still looking landed — which is exactly
    // why the boolean is the only honest signal a failed re-read leaves.
    expect(store.getState().byProject["p1"]).toEqual([automation()]);
    expect(store.getState().armingByProject["p1"]).toEqual([ARMING]);
    expect(store.getState().enabledIds).toEqual(["automation-1"]);
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

  it("mints a durable command id: the projection is machine-local, the intent is not", async () => {
    const arm = vi.fn(() => Promise.resolve({ ok: true, armings: [ARMING], receipt: {} }));
    stubApi({});
    (window.api.automations.arm as unknown) = arm;
    const store = createAutomationsStore();

    await store.getState().arm({ projectId: "p1", status: "doing", automationId: "automation-1" });

    expect(arm).toHaveBeenCalledWith(
      expect.objectContaining({
        // A UUID the renderer minted, exactly as create/update/delete do
        // (docs/BOUNDARIES.md rule 5) — main refuses anything else.
        commandId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        projectId: "p1",
        status: "doing",
        automationId: "automation-1",
      }),
    );
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
      trigger: NO_AUTOMATION_TRIGGER,
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

    await store.getState().update({
      automationId: "automation-1",
      name: "n",
      instructions: "x",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });

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
      trigger: NO_AUTOMATION_TRIGGER,
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

    await store.getState().update({
      automationId: "automation-1",
      name: "n",
      instructions: "x",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });

    expect(list).not.toHaveBeenCalled();
  });

  it("resolves the refusal inline, and a transport failure the same way", async () => {
    stubApi({ update: () => Promise.resolve({ ok: false, error: "Name this Automation" }) });
    const store = createAutomationsStore();
    expect(
      await store.getState().update({
        automationId: "a",
        name: "",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      }),
    ).toBe("Name this Automation");

    stubApi({ update: () => Promise.reject(new Error("ipc gone")) });
    const other = createAutomationsStore();
    expect(
      await other.getState().update({
        automationId: "a",
        name: "n",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      }),
    ).toBe("ipc gone");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("duplicate", () => {
  it("copies the work under a distinguishable name and opens the copy's form", async () => {
    const source = automation({ name: "Review", trigger: COLUMNS_TRIGGER });
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
        // The Trigger travels with the work. A copy created without one would
        // rewrite a column Trigger to "Nothing else" behind the person's back
        // — and "same work, different Trigger" is the whole point of Duplicate,
        // so the field it exists to let you change is the one it must not
        // silently clear.
        trigger: COLUMNS_TRIGGER,
        runtime: null,
      }),
    );
    // Straight into the copy's own form: the reason to duplicate is to change
    // something, and the Trigger is what VC-112 expects to change.
    expect(store.getState().editor).toEqual({ projectId: "p1", automation: copy });
    expect(store.getState().byProject["p1"]).toEqual([source, copy]);
  });

  it("copies a manual Trigger as the value it is, never as an absent field", async () => {
    const create = vi.fn(() => Promise.resolve({ ok: true, automation: automation() }));
    stubApi({ create });
    const store = createAutomationsStore();

    await store.getState().duplicate("p1", automation({ trigger: NO_AUTOMATION_TRIGGER }));

    // Not `toBeUndefined`: "Nothing else" is a union member the transport can
    // carry, and the create door requires it (docs/BOUNDARIES.md rule 3).
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: NO_AUTOMATION_TRIGGER }),
    );
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

describe("skipped occurrences (VC-130)", () => {
  const SKIP: AutomationSkippedOccurrence = {
    id: "skip-1",
    automationId: "automation-1",
    automationName: "Nightly sweep",
    projectId: "p1",
    dueAt: 500,
    missedCount: 3,
    reason: { kind: "app-closed" },
    recordedAt: 900,
  };

  it("caches a project's Skipped occurrences", async () => {
    stubApi({ skipsForProject: () => Promise.resolve({ ok: true, skips: [SKIP] }) });
    const store = createAutomationsStore();

    await store.getState().refreshSkips("p1");

    expect(store.getState().skipsByProject["p1"]).toEqual([SKIP]);
  });

  it("toasts a refusal and keeps the previous cache", async () => {
    stubApi({ skipsForProject: () => Promise.resolve({ ok: false, error: "Unknown project" }) });
    const store = createAutomationsStore();

    await store.getState().refreshSkips("p1");

    expect(store.getState().skipsByProject["p1"]).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load skipped occurrences: Unknown project",
      expect.anything(),
    );
  });

  it("toasts a transport failure the same way", async () => {
    stubApi({ skipsForProject: () => Promise.reject(new Error("ipc gone")) });
    const store = createAutomationsStore();

    await store.getState().refreshSkips("p1");

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load skipped occurrences: ipc gone",
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

describe("ensureLoaded", () => {
  it("fills all four caches for a project nothing has read yet", async () => {
    // The one caller that cannot answer from an empty cache: an arrival that
    // beat the board's own reads, or a `volli ticket move` into a project no
    // window has opened.
    stubApi({
      list: () => Promise.resolve({ ok: true, automations: [automation()] }),
      armings: () => Promise.resolve({ ok: true, armings: [ARMING] }),
      enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: ["automation-1"] }),
      columnOrders: () => Promise.resolve({ ok: true, orders: [ORDER] }),
    });
    const store = createAutomationsStore();

    await store.getState().ensureLoaded("p1");

    expect(store.getState().byProject["p1"]).toHaveLength(1);
    expect(store.getState().armingByProject["p1"]).toEqual([ARMING]);
    // The rank belongs in the cold-cache door too: a drop whose pick names a
    // digit would otherwise be classified against an order that never landed.
    expect(store.getState().orderByProject["p1"]).toEqual([ORDER]);
    expect(store.getState().enabledIds).toEqual(["automation-1"]);
    expect(store.getState().enablementRead).toBe(true);
  });

  it("reads nothing when every cache has already landed", async () => {
    stubApi({});
    const store = createAutomationsStore();
    store.setState({
      byProject: { p1: [automation()] },
      armingByProject: { p1: [ARMING] },
      orderByProject: { p1: [ORDER] },
      enabledIds: [],
      // An EMPTY enabled set that has been read is not a cache that hasn't:
      // "nothing on here" is an answer, and this flag is what says so.
      enablementRead: true,
    });

    await store.getState().ensureLoaded("p1");

    expect(window.api.automations.list).not.toHaveBeenCalled();
    expect(window.api.automations.armings).not.toHaveBeenCalled();
    expect(window.api.automations.columnOrders).not.toHaveBeenCalled();
    expect(window.api.automations.enablement).not.toHaveBeenCalled();
  });

  it("fills only what is missing", async () => {
    stubApi({});
    const store = createAutomationsStore();
    store.setState({ byProject: { p1: [automation()] } });

    await store.getState().ensureLoaded("p1");

    expect(window.api.automations.list).not.toHaveBeenCalled();
    expect(window.api.automations.armings).toHaveBeenCalledTimes(1);
    expect(window.api.automations.columnOrders).toHaveBeenCalledTimes(1);
    expect(window.api.automations.enablement).toHaveBeenCalledTimes(1);
  });

  it("shares one read across simultaneous callers", async () => {
    stubApi({});
    const store = createAutomationsStore();

    await Promise.all([
      store.getState().ensureLoaded("p1"),
      store.getState().ensureLoaded("p1"),
      store.getState().ensureLoaded("p1"),
    ]);

    expect(window.api.automations.list).toHaveBeenCalledTimes(1);
    expect(window.api.automations.armings).toHaveBeenCalledTimes(1);
    expect(window.api.automations.columnOrders).toHaveBeenCalledTimes(1);
    expect(window.api.automations.enablement).toHaveBeenCalledTimes(1);
  });

  it("lets a later caller try again after a failed read", async () => {
    // The read toasted its own failure and left the cache empty, so the next
    // arrival must not inherit a refusal nobody can see any more.
    stubApi({ list: () => Promise.resolve({ ok: false, error: "Unknown project" }) });
    const store = createAutomationsStore();

    await store.getState().ensureLoaded("p1");
    await store.getState().ensureLoaded("p1");

    expect(window.api.automations.list).toHaveBeenCalledTimes(2);
  });
});

describe("refreshOrder", () => {
  it("caches one project's column ranks, apart from its Automations and its armings", async () => {
    stubApi({ columnOrders: () => Promise.resolve({ ok: true, orders: [ORDER] }) });
    const store = createAutomationsStore();

    await store.getState().refreshOrder("p1");

    expect(store.getState().orderByProject["p1"]).toEqual([ORDER]);
    expect(store.getState().byProject["p1"]).toBeUndefined();
    expect(store.getState().armingByProject["p1"]).toBeUndefined();
  });

  it("toasts a refused read rather than showing an unarranged board as arranged", async () => {
    stubApi({ columnOrders: () => Promise.resolve({ ok: false, error: "Unknown project" }) });
    const store = createAutomationsStore();

    await store.getState().refreshOrder("p1");

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown project"),
      expect.anything(),
    );
    expect(store.getState().orderByProject["p1"]).toBeUndefined();
  });

  it("toasts a transport throw rather than swallowing it", async () => {
    stubApi({ columnOrders: () => Promise.reject(new Error("ipc gone")) });
    const store = createAutomationsStore();

    await store.getState().refreshOrder("p1");

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("ipc gone"),
      expect.anything(),
    );
  });
});

describe("setColumnOrder", () => {
  it("replaces the project's order slice from the door's own answer, with no re-read", async () => {
    stubApi({ setColumnOrder: () => Promise.resolve({ ok: true, orders: [ORDER], receipt: {} }) });
    const store = createAutomationsStore();

    const refusal = await store.getState().setColumnOrder({
      projectId: "p1",
      status: "doing",
      rankedAutomationIds: ["automation-2", "automation-1"],
    });

    expect(refusal).toBeNull();
    expect(store.getState().orderByProject["p1"]).toEqual([ORDER]);
    expect(window.api.automations.columnOrders).not.toHaveBeenCalled();
  });

  it("mints a durable command id: the projection is machine-local, the intent is not", async () => {
    stubApi({ setColumnOrder: () => Promise.resolve({ ok: true, orders: [], receipt: {} }) });
    const store = createAutomationsStore();

    await store
      .getState()
      .setColumnOrder({ projectId: "p1", status: "doing", rankedAutomationIds: ["a1"] });

    expect(window.api.automations.setColumnOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        projectId: "p1",
        status: "doing",
        rankedAutomationIds: ["a1"],
      }),
    );
  });

  it("resolves a refusal, and a transport throw, for the caller to report", async () => {
    stubApi({ setColumnOrder: () => Promise.resolve({ ok: false, error: "Unknown project" }) });
    const store = createAutomationsStore();
    expect(
      await store
        .getState()
        .setColumnOrder({ projectId: "p1", status: "doing", rankedAutomationIds: [] }),
    ).toBe("Unknown project");

    stubApi({ setColumnOrder: () => Promise.reject(new Error("ipc gone")) });
    const other = createAutomationsStore();
    expect(
      await other
        .getState()
        .setColumnOrder({ projectId: "p1", status: "doing", rankedAutomationIds: [] }),
    ).toBe("ipc gone");
  });
});

describe("the digit order (VC-132)", () => {
  const first = automation({ id: "automation-1", trigger: COLUMNS_TRIGGER });
  const second = automation({ id: "automation-2", trigger: COLUMNS_TRIGGER });

  async function loaded(seed: { armings?: ColumnArming[]; enabled?: string[] }) {
    stubApi({
      list: () => Promise.resolve({ ok: true, automations: [first, second] }),
      armings: () => Promise.resolve({ ok: true, armings: seed.armings ?? [] }),
      columnOrders: () => Promise.resolve({ ok: true, orders: [ORDER] }),
      enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: seed.enabled ?? [] }),
    });
    const store = createAutomationsStore();
    await store.getState().ensureLoaded("p1");
    return store;
  }

  it("hands back frozen empties for a project nothing has read yet", () => {
    const store = createAutomationsStore();
    const state = store.getState();
    expect(selectColumnOrders(state, "p1")).toEqual([]);
    expect(selectColumnRank(state, "p1", "doing")).toEqual([]);
    expect(selectColumnOrders(state, "p1")).toBe(selectColumnOrders(state, "p2"));
    expect(selectColumnRank(state, "p1", "doing")).toBe(selectColumnRank(state, "p2", "todo"));
  });

  it("reads the authored rank, uncapped and unpinned, for the surfaces that choose a record", async () => {
    const store = await loaded({ armings: [ARMING], enabled: ["automation-1"] });
    expect(selectOfferedInRankOrder(store.getState(), "p1", "doing").map((row) => row.id)).toEqual([
      "automation-2",
      "automation-1",
    ]);
  });

  it("pins the effective armed Automation to digit 1 for the drag", async () => {
    const store = await loaded({ armings: [ARMING], enabled: ["automation-1"] });
    expect(selectEffectiveArmedAutomation(store.getState(), "p1", "doing")).toEqual(first);
    expect(selectOfferedInDigitOrder(store.getState(), "p1", "doing").map((row) => row.id)).toEqual(
      ["automation-1", "automation-2"],
    );
  });

  it("lets the pin go when the armed Automation is switched off here", async () => {
    // A plain drop then runs nothing, so pinning it to `1` would make the safe
    // digit promise a Run that never comes — and the digits do not renumber.
    const store = await loaded({ armings: [ARMING], enabled: [] });
    expect(selectEffectiveArmedAutomation(store.getState(), "p1", "doing")).toBeNull();
    expect(selectOfferedInDigitOrder(store.getState(), "p1", "doing").map((row) => row.id)).toEqual(
      ["automation-2", "automation-1"],
    );
  });

  it("offers nothing for a column no Trigger names", async () => {
    const store = await loaded({});
    expect(selectOfferedInDigitOrder(store.getState(), "p1", "todo")).toEqual([]);
  });
});

describe("refreshTicketRuns", () => {
  it("caches one Ticket's Runs under that Ticket, beside the project's own history", async () => {
    const listed = [run(), run({ id: "run-2", automationId: null, automationName: null })];
    stubApi({ runsForTicket: () => Promise.resolve({ ok: true, runs: listed }) });
    const store = createAutomationsStore();

    // The rail's read and the page's read are separate slices on purpose: a
    // Ticket's rail must not depend on a project history nobody opened.
    await store.getState().refreshTicketRuns("t1");

    expect(store.getState().runsByTicket["t1"]).toEqual(listed);
    expect(store.getState().runsByProject["p1"]).toBeUndefined();
    expect(selectTicketRuns(store.getState(), "t1")).toEqual(listed);
  });

  it("toasts a refusal and leaves the cache empty", async () => {
    stubApi({ runsForTicket: () => Promise.resolve({ ok: false, error: "Unknown ticket" }) });
    const store = createAutomationsStore();

    await store.getState().refreshTicketRuns("t1");

    expect(store.getState().runsByTicket["t1"]).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load this ticket's runs: Unknown ticket",
      expect.anything(),
    );
  });

  it("toasts a transport failure the same way", async () => {
    stubApi({ runsForTicket: () => Promise.reject(new Error("ipc gone")) });
    const store = createAutomationsStore();

    await store.getState().refreshTicketRuns("t1");

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load this ticket's runs: ipc gone",
      expect.anything(),
    );
  });

  it("answers one frozen empty list before the first read", () => {
    const store = createAutomationsStore();

    const first = selectTicketRuns(store.getState(), "t1");

    expect(first).toEqual([]);
    // The same reference, so a rail subscribing to it does not re-render on
    // every unrelated store update while the cache is cold.
    expect(selectTicketRuns(store.getState(), "t2")).toBe(first);
  });
});
