import type { DecisionClassifier, PiModelAccess } from "@volli/agent-runtime";
import type {
  DecisionModelCatalogEntry,
  DecisionModelSetting,
  DecisionTarget,
  SessionUsage,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { createDesktopDecisions, type HostDecisionsOptions } from "./desktop";
import {
  DECISION_MODEL_APP_STATE_KEY,
  readGlobalDecisionModel,
  resolveScopedDecisionModel,
} from "./settings";

/** The secret a signed-in fixture provider resolves; no answer here may carry it. */
const SECRET = "sk-desktop-fixture-SECRET";

const JEV = {
  type: "classifier",
  id: "jev-latest",
  name: "Jev",
  provider: "typesafe",
  api: "typesafe-system-one",
  baseUrl: "https://api.typesafe.ai/v1/",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
};

/**
 * Just enough of Pi's collection for the desktop's own logic: one classifier
 * on one provider, signed in or not. The classification itself goes through
 * the injected fixture classifier, so nothing here reaches a network.
 */
function fakeModels(signedIn: boolean): PiModelAccess["models"] {
  return {
    getModelOfType: (_type: string, provider: string, id: string) =>
      provider === JEV.provider && id === JEV.id ? JEV : undefined,
    getModelsOfType: () => [JEV],
    getAvailableOfType: async () => (signedIn ? [JEV] : []),
    getProvider: () => ({ name: "TypeSafe" }),
    checkAuth: async () => (signedIn ? { type: "api_key" as const } : undefined),
    classify: async () => ({
      api: JEV.api,
      provider: JEV.provider,
      model: JEV.id,
      answers: { approves: { type: "bool", probability: 0.96 } },
      stopReason: "stop",
      timestamp: 0,
    }),
  } as unknown as PiModelAccess["models"];
}

const answering: DecisionClassifier = {
  async classify(target: DecisionTarget, request) {
    return {
      ok: true,
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, { type: "bool", probability: 0.9 }]),
      ),
      usage: {
        cause: "decision",
        providerId: target.where === "cloud" ? target.providerId : "local-llama-cpp",
        modelId: target.modelId,
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0000042,
        costBasis: "catalog-estimate",
      },
    };
  },
};

const CLOUD: DecisionModelSetting = {
  kind: "cloud",
  providerId: "typesafe",
  modelId: "jev-latest",
  optIn: { acceptedAt: 1, purposes: ["agent.classify"] },
};
const LOCAL: DecisionModelSetting = {
  kind: "local",
  server: "llama-cpp",
  baseUrl: "http://127.0.0.1:8080",
  modelId: "default",
};
const QUESTIONS = {
  approved: {
    type: "bool",
    instructions: "Does the reviewer approve?",
    criteria: { true: "Approves", false: "Does not" },
  },
};

let fixture: TestDb;
const PROJECT = "proj-decision";

beforeEach(() => {
  fixture = openTestDb();
  insertProject(fixture.db, testProject({ id: PROJECT }));
  fixture.db
    .prepare(
      `INSERT INTO sessions (id, project_id, ticket_id, role, parent_session_id, title, created_at)
       VALUES ('session-1', ?, NULL, 'project', NULL, 'Chat', 0)`,
    )
    .run(PROJECT);
});

afterEach(() => fixture.cleanup());

function decisions(overrides: Partial<HostDecisionsOptions> = {}) {
  const billed: Array<{ sessionId: string; usage: SessionUsage; purpose: string }> = [];
  const built = createDesktopDecisions({
    db: fixture.db,
    models: fakeModels(true),
    catalogReady: Promise.resolve(),
    recordUsage: async (sessionId, usage, purpose) => {
      billed.push({ sessionId, usage, purpose });
    },
    classifier: answering,
    now: () => 5_000,
    log: () => undefined,
    ...overrides,
  });
  return { built, billed };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("the decision model setting", () => {
  it("is none until a person chooses one, and reads a damaged row as none", () => {
    expect(readGlobalDecisionModel(fixture.db)).toEqual({ kind: "none" });
    fixture.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 0)")
      .run(DECISION_MODEL_APP_STATE_KEY, "{not json");
    expect(readGlobalDecisionModel(fixture.db)).toEqual({ kind: "none" });
  });

  it("stores the app-wide choice, stamping a cloud opt-in with main's clock", async () => {
    const { built } = decisions();
    const saved = await built.set(
      { scope: "global" },
      { ...CLOUD, optIn: { acceptedAt: 1, purposes: ["agent.classify"] } },
    );
    expect(saved.settings.global).toEqual({
      ...CLOUD,
      optIn: { acceptedAt: 5_000, purposes: ["agent.classify"] },
    });
    expect(readGlobalDecisionModel(fixture.db)).toEqual(saved.settings.global);
  });

  it("refuses a cloud choice without its opt-in, a local server off this Mac, and an unknown model", async () => {
    const { built } = decisions();
    await expect(
      built.set({ scope: "global" }, { ...CLOUD, optIn: { acceptedAt: 1, purposes: [] } }),
    ).rejects.toThrow(/needs your opt-in/);
    await expect(
      built.set({ scope: "global" }, { ...LOCAL, baseUrl: "http://192.168.1.9:8080" }),
    ).rejects.toThrow(/on this Mac/);
    await expect(built.set({ scope: "global" }, { ...LOCAL, modelId: " " })).rejects.toThrow(
      /model the server should load/,
    );
    await expect(
      built.set({ scope: "global" }, { ...CLOUD, modelId: "retired" } as DecisionModelSetting),
    ).rejects.toThrow(/not in the model catalog/);
    await expect(built.set({ scope: "global" }, null)).rejects.toThrow(/cannot inherit/);
    await expect(
      built.set({ scope: "global" }, { kind: "mystery" } as unknown as DecisionModelSetting),
    ).rejects.toThrow(/not a decision model setting/);
  });

  it("stores only a setting's own fields — never a key someone attached", async () => {
    const { built } = decisions();
    await built.set({ scope: "global" }, { ...LOCAL, apiKey: SECRET } as DecisionModelSetting);
    const raw = fixture.db
      .prepare("SELECT value FROM app_state WHERE key = ?")
      .get(DECISION_MODEL_APP_STATE_KEY) as { value: string };
    expect(raw.value).not.toContain(SECRET);
    expect(JSON.parse(raw.value)).toEqual(LOCAL);
  });

  it("lets a project override and then inherit again, and returns the row it left", async () => {
    const { built } = decisions();
    await built.set({ scope: "global" }, LOCAL);
    const overridden = await built.set({ scope: "project", projectId: PROJECT }, { kind: "none" });
    expect(overridden.settings.project).toEqual({ kind: "none" });
    expect(overridden.project?.decisionModel).toEqual({ kind: "none" });
    expect(
      resolveScopedDecisionModel(fixture.db, { sessionId: "session-1", projectId: null }),
    ).toEqual({
      kind: "none",
    });
    const inherited = await built.set({ scope: "project", projectId: PROJECT }, null);
    expect(inherited.settings.project).toBeNull();
    expect(
      resolveScopedDecisionModel(fixture.db, { sessionId: "session-1", projectId: null }),
    ).toEqual(LOCAL);
    await expect(
      built.set({ scope: "project", projectId: "gone" }, { kind: "none" }),
    ).rejects.toThrow(/no longer exists/);
  });

  it("resolves the app-wide setting for a call with no project or Session", () => {
    expect(resolveScopedDecisionModel(fixture.db, { sessionId: null, projectId: null })).toEqual({
      kind: "none",
    });
    expect(
      resolveScopedDecisionModel(fixture.db, { sessionId: "unknown-session", projectId: null }),
    ).toEqual({ kind: "none" });
  });

  it("lists the cloud catalog with each provider's sign-in state, never a key", async () => {
    const signedOut = decisions({ models: fakeModels(false) });
    const view = await signedOut.built.view(PROJECT);
    expect(view.catalog).toEqual<DecisionModelCatalogEntry[]>([
      {
        providerId: "typesafe",
        providerLabel: "TypeSafe",
        modelId: "jev-latest",
        label: "Jev",
        state: "needs-setup",
        inputUsdPerMillion: 0,
        contextWindow: 64_000,
      },
    ]);
    expect(view.project).toBeNull();
    expect((await decisions().built.view(PROJECT)).catalog[0]?.state).toBe("available");
  });
});

describe("the classify offer at Session birth", () => {
  it("is offered only with a usable decision model configured for the project", async () => {
    const { built } = decisions();
    expect(await built.offersClassify(PROJECT)).toBe(false);
    await built.set({ scope: "global" }, LOCAL);
    expect(await built.offersClassify(PROJECT)).toBe(true);
    await built.set({ scope: "project", projectId: PROJECT }, { kind: "none" });
    expect(await built.offersClassify(PROJECT)).toBe(false);
  });

  it("is offered for an opted-in cloud model before its provider is signed in", async () => {
    // A key added later reaches the Session that was waiting for it; until
    // then its calls answer "needs setup" and the agent decides itself.
    const signedOut = decisions({ models: fakeModels(false) });
    await signedOut.built.set({ scope: "global" }, CLOUD);
    expect(await signedOut.built.offersClassify(PROJECT)).toBe(true);
  });

  it("does not wait on the model catalog, and decides locally when it never came back", async () => {
    const { built, billed } = decisions({
      catalogReady: Promise.reject(new Error("restore failed")),
    });
    fixture.db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 0)")
      .run(DECISION_MODEL_APP_STATE_KEY, JSON.stringify(LOCAL));
    expect(await built.offersClassify(PROJECT)).toBe(true);
    const outcome = await built
      .classifyPort({ sessionId: "session-1", projectId: PROJECT })
      .classify({
        state: { review: "LGTM" },
        questions: QUESTIONS,
        signal: new AbortController().signal,
      });
    expect(outcome.kind).toBe("answered");
    await flush();
    expect(billed).toHaveLength(1);
  });

  it("asks a cloud model after a failed catalog restore, on Pi's built-in catalog", async () => {
    const { built } = decisions({ catalogReady: Promise.reject(new Error("restore failed")) });
    await built.set({ scope: "global" }, CLOUD);
    const outcome = await built
      .classifyPort({ sessionId: "session-1", projectId: PROJECT })
      .classify({
        state: { review: "LGTM" },
        questions: QUESTIONS,
        signal: new AbortController().signal,
      });
    expect(outcome.kind).toBe("answered");
  });
});

describe("a project row that no longer reads", () => {
  it("turns decision models off for that project rather than inheriting a cloud model", async () => {
    const { built } = decisions();
    await built.set({ scope: "global" }, CLOUD);
    // A later build's local server kind, read by this one.
    fixture.db
      .prepare("UPDATE projects SET decision_model = ? WHERE id = ?")
      .run(
        JSON.stringify({ kind: "local", server: "ollama", baseUrl: "http://127.0.0.1:11434" }),
        PROJECT,
      );
    expect(
      resolveScopedDecisionModel(fixture.db, { sessionId: "session-1", projectId: null }),
    ).toEqual({
      kind: "none",
    });
    expect(await built.offersClassify(PROJECT)).toBe(false);
  });
});

describe("the classify port", () => {
  it("answers through the service, bills the Session, and names the purpose", async () => {
    const { built, billed } = decisions();
    await built.set({ scope: "global" }, LOCAL);
    const port = built.classifyPort({ sessionId: "session-1", projectId: PROJECT });
    const outcome = await port.classify({
      state: { review: "LGTM" },
      questions: QUESTIONS,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      kind: "answered",
      answered: { answers: { approved: { type: "bool", value: true } } },
    });
    await flush();
    expect(billed).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        purpose: "agent.classify",
        usage: expect.objectContaining({ cause: "decision", modelId: "default" }),
      }),
    ]);
  });

  it("answers a miss, sending nothing, once the person turns the model off", async () => {
    const { built, billed } = decisions();
    const port = built.classifyPort({ sessionId: "session-1", projectId: PROJECT });
    const outcome = await port.classify({
      state: { review: "LGTM" },
      questions: QUESTIONS,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ kind: "miss", miss: { reason: "unset" } });
    await flush();
    expect(billed).toEqual([]);
  });
});

describe("the connection test", () => {
  it("asks the model one fixed question and reports how long it took", async () => {
    let clock = 1_000;
    const { built } = decisions({ now: () => (clock += 30) });
    expect(await built.test(CLOUD)).toEqual({ ok: true, elapsedMs: 30, probability: 0.96 });
  });

  it("says what is missing instead of asking", async () => {
    const { built } = decisions({ models: fakeModels(false) });
    expect(await built.test({ kind: "none" })).toMatchObject({ ok: false });
    expect(await built.test({ ...LOCAL, baseUrl: "http://10.1.1.1:8080" })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/on this Mac/),
    });
    expect(await built.test(CLOUD)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/signed in/),
    });
  });

  it("reads a test request through the setting parser, so a probe needs no opt-in and nothing else rides along", async () => {
    let clock = 0;
    const { built } = decisions({ now: () => (clock += 10) });
    expect(
      await built.test({ kind: "cloud", providerId: "typesafe", modelId: "jev-latest" } as never),
    ).toMatchObject({ ok: true, probability: 0.96 });
    expect(await built.test({ kind: "mystery" } as never)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Choose a decision model/),
    });
    expect(await built.test({ kind: "cloud", providerId: 3 } as never)).toMatchObject({
      ok: false,
    });
  });

  it("says a test that threw could not run, rather than that the model was slow", async () => {
    const throwing = {
      ...fakeModels(true),
      getModelOfType: () => {
        throw new Error(SECRET);
      },
    } as unknown as PiModelAccess["models"];
    const logged: unknown[] = [];
    const { built } = decisions({ models: throwing, log: (_message, error) => logged.push(error) });
    const result = await built.test(CLOUD);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/could not run/) });
    expect(result.ok === false && result.message).not.toMatch(/in time/);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
