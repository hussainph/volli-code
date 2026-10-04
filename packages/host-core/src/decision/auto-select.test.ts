import type { DecisionClassifier, PiModelAccess } from "@volli/agent-runtime";
import {
  autoSelectCandidates,
  decisionMiss,
  type DecisionModelSetting,
  type ModelSelection,
  type SessionUsage,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "@volli/host-core/db/projects-repo";
import { openTestDb, testProject, type TestDb } from "@volli/host-core/db/test-helpers";
import { createModelAutoSelect } from "./auto-select";
import { createDesktopDecisions } from "./desktop";
import { DECISION_MODEL_APP_STATE_KEY } from "./settings";

const PROJECT = "proj-auto";
const FAST: ModelSelection = { providerId: "anthropic", modelId: "haiku", reasoningLevel: "low" };
const DEEP: ModelSelection = { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" };
const CANDIDATES = autoSelectCandidates(DEEP, { fast: FAST });

const CLOUD_ON: DecisionModelSetting = {
  kind: "cloud",
  providerId: "typesafe",
  modelId: "jev-latest",
  optIn: { acceptedAt: 1, purposes: ["agent.classify", "model.select"] },
};

let fixture: TestDb;

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

function store(setting: DecisionModelSetting): void {
  fixture.db
    .prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, 0)")
    .run(DECISION_MODEL_APP_STATE_KEY, JSON.stringify(setting));
}

/** A classifier that answers the one choice question, and records what it was asked. */
function classifier(answer: { choice: string; confidence: number } | "fail") {
  const asked: unknown[] = [];
  const built: DecisionClassifier = {
    async classify(_target, request) {
      asked.push(request);
      if (answer === "fail") {
        return { ok: false, usage: null, miss: decisionMiss("provider-error", "down") };
      }
      return {
        ok: true,
        answers: {
          model: {
            type: "choice",
            choice: answer.choice,
            probabilities: { option_1: 0.1, option_2: 0.9 },
            confidence: answer.confidence,
          },
        },
        usage: {
          cause: "decision",
          providerId: "typesafe",
          modelId: "jev-latest",
          inputTokens: 10,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.000001,
          costBasis: "catalog-estimate",
        },
      };
    },
  };
  return { asked, built };
}

function port(built: DecisionClassifier) {
  const billed: Array<{ purpose: string; usage: SessionUsage }> = [];
  const decisions = createDesktopDecisions({
    db: fixture.db,
    models: {
      getModelOfType: () => ({}),
      getModelsOfType: () => [],
      getAvailableOfType: async () => [],
      getProvider: () => ({ name: "TypeSafe" }),
      checkAuth: async () => undefined,
    } as unknown as PiModelAccess["models"],
    catalogReady: Promise.resolve(),
    recordUsage: async (_sessionId, usage, purpose) => {
      billed.push({ purpose, usage });
    },
    classifier: built,
    log: () => undefined,
  });
  return { select: createModelAutoSelect({ db: fixture.db, port: decisions.port }), billed };
}

const input = {
  sessionId: "session-1",
  projectId: PROJECT,
  request: "rename a variable",
  tierHint: null,
  candidates: CANDIDATES,
};

describe("the model.select port", () => {
  it("is available only for a cloud model opted into this purpose", () => {
    const { select } = port(classifier("fail").built);
    expect(select.available(PROJECT)).toBe(false);
    store({ kind: "none" });
    expect(select.available(PROJECT)).toBe(false);
    store({
      kind: "local",
      server: "llama-cpp",
      baseUrl: "http://127.0.0.1:8080",
      modelId: "default",
    });
    expect(select.available(PROJECT)).toBe(false);
    store({ ...CLOUD_ON, optIn: { acceptedAt: 1, purposes: ["agent.classify"] } });
    expect(select.available(PROJECT)).toBe(false);
    store(CLOUD_ON);
    expect(select.available(PROJECT)).toBe(true);
  });

  it("answers with the chosen pair and bills the Session, as a decision", async () => {
    store(CLOUD_ON);
    const fake = classifier({ choice: "option_2", confidence: 0.8 });
    const { select, billed } = port(fake.built);
    const pick = await select.decide(input);
    expect(pick?.selection).toEqual(FAST);
    expect(pick?.auto.confidence).toBe(0.8);
    expect(pick?.auto.alternatives).toEqual([{ selection: DEEP, probability: 0.1 }]);
    expect(fake.asked).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(billed.map((entry) => entry.purpose)).toEqual(["model.select"]);
  });

  it("answers null when unsure, when the model fails, and when nothing is set", async () => {
    store(CLOUD_ON);
    expect(
      await port(classifier({ choice: "option_2", confidence: 0.1 }).built).select.decide(input),
    ).toBeNull();
    expect(await port(classifier("fail").built).select.decide(input)).toBeNull();
    store({ kind: "none" });
    const idle = classifier({ choice: "option_2", confidence: 0.9 });
    expect(await port(idle.built).select.decide(input)).toBeNull();
    expect(idle.asked).toEqual([]);
  });

  it("falls back if Settings switches to local after birth's availability check", async () => {
    store(CLOUD_ON);
    const fake = classifier({ choice: "option_2", confidence: 0.8 });
    const { select } = port(fake.built);
    expect(select.available(PROJECT)).toBe(true);
    store({
      kind: "local",
      server: "llama-cpp",
      baseUrl: "http://127.0.0.1:8080",
      modelId: "default",
    });
    expect(await select.decide(input)).toBeNull();
    expect(fake.asked).toEqual([]);
  });

  it("forwards withdrawal to the decision service without asking a classifier", async () => {
    store(CLOUD_ON);
    const fake = classifier({ choice: "option_2", confidence: 0.8 });
    const controller = new AbortController();
    controller.abort();
    expect(
      await port(fake.built).select.decide({ ...input, signal: controller.signal }),
    ).toBeNull();
    expect(fake.asked).toEqual([]);
  });

  it("sends nothing when there is only one pair to choose", async () => {
    store(CLOUD_ON);
    const fake = classifier({ choice: "option_1", confidence: 1 });
    const only = autoSelectCandidates(DEEP, {});
    expect(await port(fake.built).select.decide({ ...input, candidates: only })).toBeNull();
    expect(fake.asked).toEqual([]);
  });
});
