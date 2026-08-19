import { describe, expect, it, vi } from "vite-plus/test";

import {
  AUTO_TITLE_MAX_SUBJECT_CHARS,
  AUTO_TITLE_SYSTEM_PROMPT,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
  type ModelSelection,
} from "@volli/shared";

import { createAutoTitler, type AutoTitleSession, type AutoTitlerOptions } from "./auto-title";

const SESSION_ID = "session-1";

const UTILITY: ModelSelection = { providerId: "openai", modelId: "luna", reasoningLevel: "low" };
const SESSION_MODEL: ModelSelection = {
  providerId: "anthropic",
  modelId: "opus",
  reasoningLevel: "high",
};
const TICKET_DEFAULT: ModelSelection = {
  providerId: "anthropic",
  modelId: "ticket-model",
  reasoningLevel: "medium",
};
const GLOBAL_DEFAULT: ModelSelection = {
  providerId: "anthropic",
  modelId: "global-model",
  reasoningLevel: "medium",
};

function session(overrides: Partial<AutoTitleSession> = {}): AutoTitleSession {
  return {
    title: "Fix the login flow",
    ticketId: "ticket-1",
    model: SESSION_MODEL,
    ...overrides,
  };
}

/** A catalog entry with the given availability and reasoning levels. */
function catalogEntry(
  selection: ModelSelection,
  overrides: { state?: ModelAccessSnapshot["models"][number]["state"]; off?: boolean } = {},
): ModelAccessSnapshot["models"][number] {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    label: selection.modelId,
    state: overrides.state ?? "available",
    reasoningLevels: overrides.off === false ? ["low"] : ["off", "low"],
    acceptsImageInput: true,
  };
}

interface Harness {
  readSession: ReturnType<typeof vi.fn<AutoTitlerOptions["readSession"]>>;
  completeUtility: ReturnType<typeof vi.fn<AutoTitlerOptions["completeUtility"]>>;
  retitle: ReturnType<typeof vi.fn<AutoTitlerOptions["retitle"]>>;
  inspectModelAccess: ReturnType<typeof vi.fn<AutoTitlerOptions["inspectModelAccess"]>>;
  refine(input: { firstMessage?: string; heuristicTitle?: string }): Promise<void>;
}

function harness(
  overrides: Partial<AutoTitlerOptions> = {},
  initial: AutoTitleSession | null = session(),
): Harness {
  const sessions = new Map<string, AutoTitleSession | null>([[SESSION_ID, initial]]);
  const readSession = vi.fn<AutoTitlerOptions["readSession"]>(async (sessionId) => {
    return sessions.get(sessionId) ?? null;
  });
  const completeUtility = vi.fn<AutoTitlerOptions["completeUtility"]>(async (input) => {
    const custom = overrides.completeUtility;
    return custom === undefined ? "Fix the login flow" : custom(input);
  });
  const retitle = vi.fn<AutoTitlerOptions["retitle"]>(async (sessionId, title) => {
    const current = sessions.get(sessionId);
    if (current !== null && current !== undefined) {
      sessions.set(sessionId, { ...current, title });
    }
  });
  const inspectModelAccess = vi.fn<AutoTitlerOptions["inspectModelAccess"]>(async () => ({
    observedAt: 0,
    providers: [],
    models: [
      catalogEntry(UTILITY),
      catalogEntry(SESSION_MODEL),
      catalogEntry(TICKET_DEFAULT),
      catalogEntry(GLOBAL_DEFAULT),
    ],
  }));
  const titler = createAutoTitler({
    ...overrides,
    readSession: overrides.readSession ?? readSession,
    readModelDefaults:
      overrides.readModelDefaults ?? (() => ({ ...EMPTY_MODEL_ACCESS_DEFAULTS, utility: UTILITY })),
    inspectModelAccess: overrides.inspectModelAccess ?? inspectModelAccess,
    completeUtility,
    retitle: overrides.retitle ?? retitle,
  });
  return {
    readSession,
    completeUtility,
    retitle,
    inspectModelAccess,
    refine: (input) =>
      titler.refine({
        sessionId: SESSION_ID,
        firstMessage: "The login button is broken",
        heuristicTitle: "Fix the login flow",
        ...input,
      }),
  };
}

/** Defaults with no explicit utility choice, so the ladder falls past rung one. */
const NO_UTILITY: ModelAccessDefaults = {
  global: GLOBAL_DEFAULT,
  ticket: TICKET_DEFAULT,
  utility: null,
};

describe("createAutoTitler().refine", () => {
  it("retitles with the sanitized model answer once it lands", async () => {
    const h = harness({ completeUtility: async () => '"Fix the login flow."' });
    await h.refine({});
    expect(h.completeUtility).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { providerId: UTILITY.providerId, modelId: UTILITY.modelId, reasoningLevel: "off" },
        systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
        user: "The login button is broken",
      }),
    );
    expect(h.retitle.mock.calls).toEqual([[SESSION_ID, "Fix the login flow"]]);
  });

  it("gives the whole refinement one deadline, shared by the probe and the call", async () => {
    const h = harness({});
    await h.refine({});
    const probeSignal = h.inspectModelAccess.mock.calls[0]?.[0].signal;
    expect(probeSignal).toBeInstanceOf(AbortSignal);
    expect(h.completeUtility.mock.calls[0]?.[0].signal).toBe(probeSignal);
  });

  it("caps the message it sends, so a pasted wall of text is not billed in full", async () => {
    const h = harness({});
    await h.refine({ firstMessage: "x".repeat(AUTO_TITLE_MAX_SUBJECT_CHARS + 4000) });
    expect(h.completeUtility.mock.calls[0]?.[0].user).toHaveLength(AUTO_TITLE_MAX_SUBJECT_CHARS);
  });

  it("walks the ladder: utility, then the session's own model, then the role default", async () => {
    const sessionOwn = harness({ readModelDefaults: () => NO_UTILITY });
    await sessionOwn.refine({});
    expect(sessionOwn.completeUtility).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { providerId: "anthropic", modelId: "opus", reasoningLevel: "off" },
      }),
    );

    const roleDefault = harness({
      readModelDefaults: () => NO_UTILITY,
      readSession: async () => session({ model: null }),
    });
    await roleDefault.refine({});
    expect(roleDefault.completeUtility).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { providerId: "anthropic", modelId: "ticket-model", reasoningLevel: "off" },
      }),
    );

    const projectSession = harness({
      readModelDefaults: () => NO_UTILITY,
      readSession: async () => session({ model: null, ticketId: null }),
    });
    await projectSession.refine({});
    expect(projectSession.completeUtility).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { providerId: "anthropic", modelId: "global-model", reasoningLevel: "off" },
      }),
    );
  });

  it("reads the configured defaults once per refinement, not once per rung", async () => {
    const readModelDefaults = vi.fn(() => NO_UTILITY);
    const h = harness({ readModelDefaults });
    await h.refine({});
    expect(readModelDefaults).toHaveBeenCalledTimes(1);
  });

  it("makes no call when nothing on the ladder resolves, leaving the heuristic", async () => {
    const h = harness({
      readModelDefaults: () => EMPTY_MODEL_ACCESS_DEFAULTS,
      readSession: async () => session({ model: null }),
    });
    await h.refine({});
    expect(h.completeUtility).not.toHaveBeenCalled();
    expect(h.inspectModelAccess).not.toHaveBeenCalled();
    expect(h.retitle).not.toHaveBeenCalled();
  });

  it("makes no call when the durable title was already user-set or CLI-provided", async () => {
    const h = harness({
      readSession: async () => session({ title: "My own name" }),
    });
    await h.refine({});
    expect(h.completeUtility).not.toHaveBeenCalled();
    expect(h.inspectModelAccess).not.toHaveBeenCalled();
    expect(h.retitle).not.toHaveBeenCalled();
  });

  it("records the heuristic first when the title is still null", async () => {
    const h = harness(
      { completeUtility: async () => "Login button fix" },
      session({ title: null }),
    );
    await h.refine({});
    expect(h.retitle.mock.calls).toEqual([
      [SESSION_ID, "Fix the login flow"],
      [SESSION_ID, "Login button fix"],
    ]);
    expect(h.completeUtility).toHaveBeenCalledTimes(1);
  });

  it("keeps the heuristic when the chosen model is unavailable", async () => {
    const h = harness({
      inspectModelAccess: async () => ({
        observedAt: 0,
        providers: [],
        models: [catalogEntry(UTILITY, { state: "authentication-required" })],
      }),
    });
    await h.refine({});
    expect(h.completeUtility).not.toHaveBeenCalled();
    expect(h.retitle).not.toHaveBeenCalled();
  });

  it("keeps the heuristic when the chosen model cannot run reasoning off", async () => {
    const h = harness({
      inspectModelAccess: async () => ({
        observedAt: 0,
        providers: [],
        models: [catalogEntry(UTILITY, { off: false })],
      }),
    });
    await h.refine({});
    expect(h.completeUtility).not.toHaveBeenCalled();
    expect(h.retitle).not.toHaveBeenCalled();
  });

  it("keeps the heuristic when the call fails, without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({
        completeUtility: async () => {
          throw new Error("provider down");
        },
      });
      await expect(h.refine({})).resolves.toBeUndefined();
      expect(h.retitle).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider down"));
    } finally {
      warn.mockRestore();
    }
  });

  it("drops the answer when the title changed while the call was in flight", async () => {
    let firstRead = true;
    const h = harness({
      readSession: async () => {
        if (firstRead) {
          firstRead = false;
          return session();
        }
        return session({ title: "Renamed while it ran" });
      },
    });
    await h.refine({});
    expect(h.retitle).not.toHaveBeenCalled();
  });

  it("does nothing when the session no longer exists", async () => {
    const h = harness({ readSession: async () => null });
    await h.refine({});
    expect(h.retitle).not.toHaveBeenCalled();
    expect(h.completeUtility).not.toHaveBeenCalled();
  });

  it("keeps the heuristic when the sanitized answer is empty", async () => {
    const h = harness({ completeUtility: async () => "." });
    await h.refine({});
    expect(h.retitle).not.toHaveBeenCalled();
  });

  it("keeps the heuristic when the retitle write fails, logging without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness({
        retitle: async () => {
          throw new Error("ledger refused");
        },
      });
      await expect(h.refine({})).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("ledger refused"));
    } finally {
      error.mockRestore();
    }
  });
});
