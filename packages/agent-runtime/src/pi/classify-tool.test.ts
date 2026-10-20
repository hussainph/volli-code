import {
  codeModeSurfaceFor,
  type DecisionAnswered,
  type RuntimeClassifyOutcome,
  type RuntimeClassifyPort,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { createDecisionService } from "../decision/service";
import { FIXTURE_SECRET, fixtureModels } from "../decision/fixture.test-support";
import { piDecisionClassifier } from "./classifier";
import { createSessionTools } from "./tools";
import { createCodeModeTool } from "../codemode/tool";
import { CodeModeJournal } from "../codemode/journal";
import {
  answerLine,
  CLASSIFY_DESCRIPTION,
  CLASSIFY_OUTPUT_SCHEMA,
  CLASSIFY_PARAMETERS,
  createClassifyTool,
} from "./classify-tool";

const ANSWERED: DecisionAnswered = {
  answers: {
    approved: { type: "bool", value: true, probability: 0.97, confidence: 0.94 },
    category: {
      type: "choice",
      choice: "bug",
      probabilities: { bug: 0.7, feature: 0.2, question: 0.06, chore: 0.04 },
      confidence: 0.6,
    },
    severity: { type: "score", score: 2.25, level: 2, label: "high", confidence: 0.5 },
  },
  model: { where: "cloud", providerId: "typesafe", modelId: "jev-latest" },
  elapsedMs: 312.4,
};

function portAnswering(
  outcome: RuntimeClassifyOutcome,
  seen: Array<{ state: unknown; questions: unknown; signal: AbortSignal }> = [],
): RuntimeClassifyPort {
  return {
    classify: async (input) => {
      seen.push(input);
      return outcome;
    },
  };
}

const ARGS = {
  state: { title: "Crash on save" },
  questions: {
    approved: {
      type: "bool" as const,
      instructions: "Approve?",
      criteria: { true: "yes", false: "no" },
    },
  },
};

describe("classify, as the model meets it", () => {
  it("takes a state and questions, and nothing a credential could ride in", () => {
    // The tool surface's half of "no agent path accepts a key": the only
    // inputs are the state and the questions, and the host rebuilds both from
    // the fields a request has.
    expect(Object.keys(CLASSIFY_PARAMETERS.properties)).toEqual(["state", "questions"]);
    expect(JSON.stringify(CLASSIFY_PARAMETERS)).not.toMatch(/api[_ ]?key|token|secret"/i);
    expect(CLASSIFY_OUTPUT_SCHEMA).toMatchObject({ properties: { answers: expect.anything() } });
  });

  it("says when to use it and when not", () => {
    expect(CLASSIFY_DESCRIPTION).toMatch(/labelling or triaging many items/);
    expect(CLASSIFY_DESCRIPTION).toMatch(/which state a page or element is in/);
    expect(CLASSIFY_DESCRIPTION).toMatch(
      /Do not use it for anything that needs open-ended reasoning/,
    );
    expect(CLASSIFY_DESCRIPTION).toMatch(/decide yourself/);
  });

  it("returns the answers as structured content, a short text for the model, and row details", async () => {
    const seen: Array<{ state: unknown; questions: unknown; signal: AbortSignal }> = [];
    const tool = createClassifyTool(portAnswering({ kind: "answered", answered: ANSWERED }, seen));
    const result = await tool.execute("call-1", ARGS);
    expect(seen[0]).toMatchObject({ state: ARGS.state, questions: ARGS.questions });
    expect(result.structuredContent).toEqual({
      answers: ANSWERED.answers,
      model: ANSWERED.model,
      elapsedMs: 312.4,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text: [
          "approved: yes (p(yes)=0.97, confidence 0.94)",
          "category: bug (bug 0.7, feature 0.2, question 0.06; confidence 0.6)",
          'severity: level 2 "high" (score 2.25, confidence 0.5)',
          "Decided by typesafe/jev-latest in 312 ms.",
        ].join("\n"),
      },
    ]);
    expect(result.details).toEqual({
      questions: 1,
      outcome: "answered",
      model: "typesafe/jev-latest",
      elapsedMs: 312.4,
    });
  });

  it("turns a miss into an error the model recovers from by deciding itself", async () => {
    const tool = createClassifyTool(
      portAnswering({
        kind: "miss",
        miss: {
          status: "unavailable",
          reason: "unset",
          message: "No decision model is configured.",
        },
      }),
    );
    const result = await tool.execute("call-2", ARGS);
    expect(result.isError).toBe(true);
    // An error result carries no structured content: it would not match the
    // declared `outputSchema`, which describes an answer.
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text: "No decision was made: No decision model is configured.\nDecide this yourself, or continue without it.",
      },
    ]);
    expect(result.details).toEqual({
      questions: 1,
      outcome: "unset",
      model: null,
      elapsedMs: null,
    });
  });

  it("tells the model to fix a request that broke a bound", async () => {
    const tool = createClassifyTool(
      portAnswering({
        kind: "miss",
        miss: {
          status: "error",
          reason: "invalid-request",
          message: "Ask between 1 and 16 questions.",
        },
      }),
    );
    const result = await tool.execute("call-3", { state: {}, questions: [] as never });
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/Fix the request/) });
    expect(result.details?.questions).toBeNull();
  });

  it("withdraws the decision when the attachment or the call is cancelled", async () => {
    const attachment = new AbortController();
    attachment.abort();
    const seen: Array<{ signal: AbortSignal }> = [];
    await createClassifyTool(
      portAnswering({ kind: "answered", answered: ANSWERED }, seen as never),
      attachment.signal,
    ).execute("call-4", ARGS);
    expect(seen[0]?.signal.aborted).toBe(true);

    const call = new AbortController();
    let signalled: AbortSignal | null = null;
    const pending = createClassifyTool({
      classify: (input) =>
        new Promise((resolve) => {
          signalled = input.signal;
          input.signal.addEventListener("abort", () =>
            resolve({
              kind: "miss",
              miss: { status: "error", reason: "aborted", message: "Withdrawn." },
            }),
          );
        }),
    }).execute("call-5", ARGS, call.signal);
    call.abort();
    expect((await pending).details?.outcome).toBe("aborted");
    expect(signalled!.aborted).toBe(true);
  });

  it("formats whole and tiny numbers plainly", () => {
    expect(answerLine("ok", { type: "bool", value: false, probability: 0, confidence: 1 })).toBe(
      "ok: no (p(yes)=0, confidence 1)",
    );
  });
});

describe("classify on the Session's surface", () => {
  it("is offered exactly when the decision port is wired", () => {
    const port = portAnswering({ kind: "answered", answered: ANSWERED });
    expect(
      createSessionTools({ tools: { tools: [] }, classify: port }, {} as never).map(
        (tool) => tool.name,
      ),
    ).toEqual(["classify"]);
    expect(createSessionTools({ tools: { tools: [] } }, {} as never)).toEqual([]);
  });
});

function surface(port: RuntimeClassifyPort, route: "both" | "code") {
  return createSessionTools(
    {
      tools: {
        tools: [],
        codeMode: { ...codeModeSurfaceFor({ tools: ["classify"] }), routes: { classify: route } },
      },
      classify: port,
    },
    null as never,
    undefined,
    (codeMode, tools) =>
      createCodeModeTool({
        surface: codeMode,
        tools,
        observe: async () => {},
        journal: new CodeModeJournal(),
      }),
  );
}

describe("classify through Code Mode (VC-471 / VC-478)", () => {
  it("routes the real classify tool on both and code, with typed answers for a loop", async () => {
    for (const route of ["both", "code"] as const) {
      const seen: Array<{ state: unknown; questions: unknown; signal: AbortSignal }> = [];
      const tools = surface(portAnswering({ kind: "answered", answered: ANSWERED }, seen), route);
      expect(tools.map((tool) => tool.name)).toEqual(
        route === "both" ? ["classify", "codemode"] : ["codemode"],
      );
      const code = tools.at(-1)!;
      expect(code.description).toContain("answers:");
      expect(code.description).toContain("elapsedMs: number");
      const result = await code.execute(`classify-${route}`, {
        code: `
        const values = [];
        for (const state of [{ title: "one" }, { title: "two" }]) {
          const result = await tools.classify({ state, questions: ${JSON.stringify(ARGS.questions)} });
          values.push(result.answers.approved.value);
        }
        return values;
      `,
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual({
        type: "text",
        text: expect.stringContaining("Returned: [true,true]"),
      });
      expect(seen.map((call) => call.state)).toEqual([{ title: "one" }, { title: "two" }]);
      expect(seen.every((call) => call.signal instanceof AbortSignal)).toBe(true);
    }
  });

  it("rejects a decision miss explicitly rather than handing a script success-shaped text", async () => {
    const [code] = surface(
      portAnswering({
        kind: "miss",
        miss: { status: "error", reason: "invalid-request", message: "bad question" },
      }),
      "code",
    );
    const result = await code!.execute("classify-miss", {
      code: `
      try { await tools.classify(${JSON.stringify(ARGS)}); }
      catch (error) { return error.message; }
    `,
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("No decision was made: bad question"),
    });
  });
});

describe("classify, end to end through the decision service", () => {
  it("answers a real request from the fixture provider and never shows its key", async () => {
    const decisions = createDecisionService({
      resolveSetting: () => ({
        kind: "cloud",
        providerId: "fixture",
        modelId: "jev-fixture",
        optIn: { acceptedAt: 1, purposes: ["agent.classify"] },
      }),
      classifier: piDecisionClassifier(fixtureModels()),
    });
    const port: RuntimeClassifyPort = {
      classify: ({ state, questions, signal }) =>
        decisions.decide<RuntimeClassifyOutcome>({
          purpose: "agent.classify",
          sessionId: "s",
          state,
          questions,
          signal,
          use: (answered) => ({ kind: "answered", answered }),
          fallback: (miss) => ({ kind: "miss", miss }),
        }),
    };
    const result = await createClassifyTool(port).execute("call-6", ARGS);
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/^approved: yes/) });
    expect(JSON.stringify(result)).not.toContain(FIXTURE_SECRET);
  });
});
