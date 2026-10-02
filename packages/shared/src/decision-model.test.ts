import { describe, expect, it } from "vite-plus/test";

import { VERB_REGISTRY, type VerbEntry, type VerbToolField } from "./verb-registry";

import {
  checkDecisionRequest,
  decisionCloudDisclosure,
  decisionMiss,
  decisionTargetFor,
  DECISION_LIMITS,
  DECISION_PURPOSE_POLICY,
  DECISION_PURPOSES,
  DECISION_BASE_PURPOSES,
  isDecisionPurpose,
  localDecisionUrlProblem,
  NO_DECISION_MODEL,
  normalizeLocalDecisionUrl,
  offersClassifyTool,
  parseDecisionModelSetting,
  readDecisionAnswers,
  resolveDecisionModelSetting,
  withDecisionPurpose,
  type DecisionModelSetting,
  type DecisionQuestion,
} from "./decision-model";

const CLOUD: DecisionModelSetting = {
  kind: "cloud",
  providerId: "typesafe",
  modelId: "jev-latest",
  optIn: { acceptedAt: 1_000, purposes: ["agent.classify"] },
};

const LOCAL: DecisionModelSetting = {
  kind: "local",
  server: "llama-cpp",
  baseUrl: "http://127.0.0.1:8080",
  modelId: "qwen3-4b",
};

describe("purposes", () => {
  it("names every caller, and only those", () => {
    expect(DECISION_PURPOSES).toEqual(["agent.classify", "model.select"]);
    expect(isDecisionPurpose("agent.classify")).toBe(true);
    expect(isDecisionPurpose("authority.judge")).toBe(false);
    expect(isDecisionPurpose("model.select")).toBe(true);
    expect(isDecisionPurpose(7)).toBe(false);
  });

  it("gives every purpose a timeout, an audit rule and what it sends", () => {
    for (const purpose of DECISION_PURPOSES) {
      const policy = DECISION_PURPOSE_POLICY[purpose];
      expect(policy.timeoutMs).toBeGreaterThan(0);
      expect(policy.sends.length).toBeGreaterThan(0);
    }
    // Routine agent calls leave usage, never a per-call audit fact.
    expect(DECISION_PURPOSE_POLICY["agent.classify"].audit).toBe(false);
    // A new Session waits on a model choice, so it gets seconds, not the tool's half minute.
    expect(DECISION_PURPOSE_POLICY["model.select"].audit).toBe(false);
    expect(DECISION_PURPOSE_POLICY["model.select"].timeoutMs).toBeLessThan(
      DECISION_PURPOSE_POLICY["agent.classify"].timeoutMs,
    );
  });

  it("keeps a purpose with its own switch out of the first opt-in", () => {
    expect(DECISION_BASE_PURPOSES).toEqual(["agent.classify"]);
    expect(decisionCloudDisclosure("Jev")).not.toMatch(/models you have set up/);
  });
});

describe("local server URLs", () => {
  it("admits loopback only", () => {
    for (const url of [
      "http://127.0.0.1:8080",
      "http://localhost:8080/v1",
      "https://[::1]:8443",
      "http://127.4.5.6",
    ]) {
      expect(localDecisionUrlProblem(url)).toBeNull();
    }
  });

  it("refuses what would leave this Mac, and what is not a URL", () => {
    expect(localDecisionUrlProblem("http://192.168.1.4:8080")).toMatch(/on this Mac/);
    expect(localDecisionUrlProblem("http://llama.lan:8080")).toMatch(/on this Mac/);
    expect(localDecisionUrlProblem("https://api.typesafe.ai")).toMatch(/on this Mac/);
    expect(localDecisionUrlProblem("ftp://127.0.0.1")).toMatch(/http/);
    expect(localDecisionUrlProblem("http://user:pw@127.0.0.1")).toMatch(/user name/);
    expect(localDecisionUrlProblem("not a url")).toMatch(/Enter a URL/);
  });

  it("stores the URL without a trailing slash or a query", () => {
    expect(normalizeLocalDecisionUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    expect(normalizeLocalDecisionUrl("http://localhost:8080/v1/?x=1")).toBe(
      "http://localhost:8080/v1",
    );
  });
});

describe("stored settings", () => {
  it("reads each kind back", () => {
    expect(parseDecisionModelSetting({ kind: "none" })).toBe(NO_DECISION_MODEL);
    expect(parseDecisionModelSetting({ ...LOCAL, baseUrl: "http://127.0.0.1:8080/" })).toEqual(
      LOCAL,
    );
    expect(parseDecisionModelSetting(CLOUD)).toEqual(CLOUD);
  });

  it("drops every field a setting does not have — a key included", () => {
    expect(parseDecisionModelSetting({ ...CLOUD, apiKey: "sk-secret" })).toEqual(CLOUD);
    expect(parseDecisionModelSetting({ ...LOCAL, apiKey: "sk-secret" })).toEqual(LOCAL);
  });

  it("refuses a cloud setting nobody opted into", () => {
    const { optIn: _optIn, ...withoutOptIn } = CLOUD as Extract<
      DecisionModelSetting,
      { kind: "cloud" }
    >;
    expect(parseDecisionModelSetting(withoutOptIn)).toBeNull();
    expect(parseDecisionModelSetting({ ...CLOUD, optIn: { acceptedAt: 1, purposes: [] } })).toBe(
      null,
    );
    expect(
      parseDecisionModelSetting({ ...CLOUD, optIn: { acceptedAt: 1, purposes: ["x.later"] } }),
    ).toBeNull();
    expect(parseDecisionModelSetting({ ...CLOUD, optIn: { acceptedAt: -1, purposes: [] } })).toBe(
      null,
    );
    expect(parseDecisionModelSetting({ ...CLOUD, optIn: { acceptedAt: 1, purposes: "x" } })).toBe(
      null,
    );
    expect(parseDecisionModelSetting({ ...CLOUD, optIn: "yes" })).toBeNull();
  });

  it("keeps the purposes this build knows, in vocabulary order", () => {
    expect(
      parseDecisionModelSetting({
        ...CLOUD,
        optIn: { acceptedAt: 5, purposes: ["later.purpose", "agent.classify"] },
      }),
    ).toEqual({ ...CLOUD, optIn: { acceptedAt: 5, purposes: ["agent.classify"] } });
  });

  it("refuses a local server off this Mac and malformed rows", () => {
    expect(parseDecisionModelSetting({ ...LOCAL, baseUrl: "http://10.0.0.2:8080" })).toBeNull();
    expect(parseDecisionModelSetting({ ...LOCAL, baseUrl: 8080 })).toBeNull();
    expect(parseDecisionModelSetting({ ...LOCAL, server: "ollama" })).toBeNull();
    expect(parseDecisionModelSetting({ ...LOCAL, modelId: "" })).toBeNull();
    expect(parseDecisionModelSetting({ ...LOCAL, modelId: " padded" })).toBeNull();
    expect(parseDecisionModelSetting({ ...CLOUD, providerId: 3 })).toBeNull();
    expect(parseDecisionModelSetting({ ...CLOUD, modelId: "x".repeat(513) })).toBeNull();
    expect(parseDecisionModelSetting({ kind: "magic" })).toBeNull();
    expect(parseDecisionModelSetting(null)).toBeNull();
    expect(parseDecisionModelSetting([])).toBeNull();
  });

  it("lets a project override or inherit", () => {
    expect(resolveDecisionModelSetting(CLOUD, null)).toBe(CLOUD);
    expect(resolveDecisionModelSetting(CLOUD, NO_DECISION_MODEL)).toBe(NO_DECISION_MODEL);
    expect(resolveDecisionModelSetting(NO_DECISION_MODEL, LOCAL)).toBe(LOCAL);
  });
});

describe("the cloud disclosure", () => {
  it("says what leaves the machine, per purpose", () => {
    expect(decisionCloudDisclosure("Jev · TypeSafe")).toBe(
      `Jev · TypeSafe runs off this Mac. Using it sends ${DECISION_PURPOSE_POLICY["agent.classify"].sends}.`,
    );
    expect(decisionCloudDisclosure("Jev", ["agent.classify"])).toMatch(/page content/);
  });
});

describe("switching one purpose on or off", () => {
  const cloud = CLOUD as Extract<DecisionModelSetting, { kind: "cloud" }>;

  it("extends the opt-in, re-stamped, in vocabulary order", () => {
    const on = withDecisionPurpose(cloud, "model.select", true, 5_000);
    expect(on?.optIn).toEqual({ acceptedAt: 5_000, purposes: ["agent.classify", "model.select"] });
    expect(on === null ? null : parseDecisionModelSetting(on)).toEqual(on);
    // The target is the same once it is on.
    expect(decisionTargetFor(on!, "model.select").ok).toBe(true);
    expect(decisionTargetFor(cloud, "model.select")).toMatchObject({
      ok: false,
      miss: { reason: "not-opted-in" },
    });
  });

  it("withdraws one purpose and keeps the rest and the original agreement time", () => {
    const both = withDecisionPurpose(cloud, "model.select", true, 5_000)!;
    const off = withDecisionPurpose(both, "model.select", false, 9_000);
    expect(off?.optIn).toEqual({ acceptedAt: 5_000, purposes: ["agent.classify"] });
  });

  it("refuses to leave an opt-in that covers nothing", () => {
    expect(withDecisionPurpose(cloud, "agent.classify", false, 1)).toBeNull();
  });
});

describe("where a call goes", () => {
  it("goes nowhere when nothing is configured", () => {
    const resolved = decisionTargetFor(NO_DECISION_MODEL, "agent.classify");
    expect(resolved).toEqual({
      ok: false,
      miss: { status: "unavailable", reason: "unset", message: expect.any(String) },
    });
    expect(offersClassifyTool(NO_DECISION_MODEL)).toBe(false);
  });

  it("goes to the local server", () => {
    expect(decisionTargetFor(LOCAL, "agent.classify")).toEqual({
      ok: true,
      target: {
        where: "local",
        server: "llama-cpp",
        baseUrl: "http://127.0.0.1:8080",
        modelId: "qwen3-4b",
      },
    });
    expect(offersClassifyTool(LOCAL)).toBe(true);
  });

  it("never routes automatic model choice to a local server", () => {
    expect(decisionTargetFor(LOCAL, "model.select")).toMatchObject({
      ok: false,
      miss: { reason: "unset" },
    });
  });

  it("goes to the cloud only for a purpose the opt-in names", () => {
    expect(decisionTargetFor(CLOUD, "agent.classify")).toEqual({
      ok: true,
      target: { where: "cloud", providerId: "typesafe", modelId: "jev-latest" },
    });
    expect(offersClassifyTool(CLOUD)).toBe(true);
    // A setting whose opt-in names nothing this purpose needs — a later
    // purpose's opt-in, read by this build — reaches no model.
    const elsewhere = {
      ...CLOUD,
      optIn: { acceptedAt: 1, purposes: [] },
    } as DecisionModelSetting;
    const resolved = decisionTargetFor(elsewhere, "agent.classify");
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? null : resolved.miss.reason).toBe("not-opted-in");
    expect(offersClassifyTool(elsewhere)).toBe(false);
  });

  it("derives a miss's status from its reason", () => {
    expect(decisionMiss("needs-setup", "x").status).toBe("unavailable");
    expect(decisionMiss("unaudited", "x").status).toBe("unavailable");
    expect(decisionMiss("timeout", "x").status).toBe("error");
    expect(decisionMiss("malformed-answer", "x").status).toBe("error");
  });
});

const QUESTIONS = {
  category: {
    type: "choice",
    instructions: "Classify the message.",
    criteria: { approval: "Approves", correction: "Asks for a correction" },
  },
  satisfaction: {
    type: "score",
    instructions: "Score satisfaction.",
    criteria: ["dissatisfied", "neutral", "satisfied"],
  },
  approved: {
    type: "bool",
    instructions: "Does the user approve?",
    criteria: { true: "Approval", false: "No approval" },
  },
} satisfies Record<string, DecisionQuestion>;

function problem(input: unknown): string {
  const checked = checkDecisionRequest(input);
  return checked.ok ? "" : checked.problem;
}

function ask(question: unknown, state: unknown = { x: 1 }): string {
  return problem({ state, questions: { q: question } });
}

describe("requests", () => {
  it("accepts every question type and rebuilds only the fields a request has", () => {
    const checked = checkDecisionRequest({
      state: { message: "Works, thanks.", nested: { list: [1, true, null, "x"] } },
      questions: {
        ...QUESTIONS,
        approved: { ...QUESTIONS.approved, apiKey: "sk-secret" },
      },
      apiKey: "sk-secret",
    });
    expect(checked).toEqual({
      ok: true,
      value: {
        state: { message: "Works, thanks.", nested: { list: [1, true, null, "x"] } },
        questions: QUESTIONS,
      },
    });
    expect(JSON.stringify(checked)).not.toContain("sk-secret");
  });

  it("holds the state to JSON, depth and size", () => {
    expect(problem(null)).toMatch(/must be an object/);
    expect(problem({ state: [1], questions: QUESTIONS })).toMatch(/JSON object/);
    expect(problem({ state: { n: Number.NaN }, questions: QUESTIONS })).toMatch(/number/);
    expect(problem({ state: { f: () => 1 }, questions: QUESTIONS })).toMatch(/plain JSON/);
    let deep: unknown = 1;
    for (let depth = 0; depth < DECISION_LIMITS.stateMaxDepth + 1; depth++) deep = { deep };
    expect(problem({ state: deep, questions: QUESTIONS })).toMatch(/nested/);
    const big = { text: "x".repeat(DECISION_LIMITS.stateMaxBytes) };
    expect(problem({ state: big, questions: QUESTIONS })).toMatch(/bytes as JSON/);
  });

  it("holds the questions to their count and names", () => {
    expect(problem({ state: {}, questions: [] })).toMatch(/question name to question/);
    expect(problem({ state: {}, questions: {} })).toMatch(/between 1 and/);
    const many = Object.fromEntries(
      Array.from({ length: DECISION_LIMITS.questionsMax + 1 }, (_, i) => [
        `q${i}`,
        QUESTIONS.approved,
      ]),
    );
    expect(problem({ state: {}, questions: many })).toMatch(/between 1 and/);
    expect(problem({ state: {}, questions: { "has space": QUESTIONS.approved } })).toMatch(
      /identifier/,
    );
    expect(problem({ state: {}, questions: { ["a".repeat(65)]: QUESTIONS.approved } })).toMatch(
      /identifier/,
    );
  });

  it("refuses names that would not stay a question or an option", () => {
    // JSON.parse makes `__proto__` an own key; assigning it would have swapped
    // a prototype and sent the state with no question at all.
    const parsed = JSON.parse(
      '{"state":{"x":1},"questions":{"__proto__":{"type":"bool","instructions":"q","criteria":{"true":"y","false":"n"}}}}',
    ) as unknown;
    expect(problem(parsed)).toMatch(/identifier/);
    expect(problem({ state: {}, questions: { constructor: QUESTIONS.approved } })).toMatch(
      /identifier/,
    );
    const option = JSON.parse(
      '{"type":"choice","instructions":"q","criteria":{"__proto__":"x","b":"B"}}',
    ) as unknown;
    expect(ask(option)).toMatch(/cannot have an option named __proto__/);
  });

  it("holds each question to its shape", () => {
    expect(ask("yes?")).toMatch(/must be an object/);
    expect(ask({ ...QUESTIONS.approved, instructions: "" })).toMatch(/instructions must be text/);
    expect(ask({ ...QUESTIONS.approved, instructions: "x".repeat(2_001) })).toMatch(/over 2000/);
    expect(ask({ ...QUESTIONS.approved, type: "free-text" })).toMatch(/choice, score or bool/);
  });

  it("holds choices to their option count, keys and meanings", () => {
    expect(ask({ ...QUESTIONS.category, criteria: ["a", "b"] })).toMatch(/option key to meaning/);
    expect(ask({ ...QUESTIONS.category, criteria: { only: "One" } })).toMatch(/2 to 32 options/);
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`o${i}`, "x"]));
    expect(ask({ ...QUESTIONS.category, criteria: tooMany })).toMatch(/not 33/);
    expect(ask({ ...QUESTIONS.category, criteria: { " ": "blank", b: "B" } })).toMatch(/empty/);
    expect(ask({ ...QUESTIONS.category, criteria: { ["k".repeat(65)]: "x", b: "B" } })).toMatch(
      /over 64/,
    );
    expect(ask({ ...QUESTIONS.category, criteria: { a: "A", b: 2 } })).toMatch(/option b/);
  });

  it("holds scores to their levels", () => {
    expect(ask({ ...QUESTIONS.satisfaction, criteria: { a: "x" } })).toMatch(/2 to 10 levels/);
    expect(ask({ ...QUESTIONS.satisfaction, criteria: ["only"] })).toMatch(/2 to 10 levels/);
    expect(
      ask({ ...QUESTIONS.satisfaction, criteria: Array.from({ length: 11 }, () => "x") }),
    ).toMatch(/2 to 10 levels/);
    expect(ask({ ...QUESTIONS.satisfaction, criteria: ["low", ""] })).toMatch(/level 1/);
  });

  it("holds bools to both criteria", () => {
    expect(ask({ ...QUESTIONS.approved, criteria: "yes" })).toMatch(/true and false/);
    expect(ask({ ...QUESTIONS.approved, criteria: { true: "Yes" } })).toMatch(/false criterion/);
    expect(
      ask({ ...QUESTIONS.approved, criteria: { true: "x".repeat(501), false: "No" } }),
    ).toMatch(/true criterion is over 500/);
  });
});

describe("answers", () => {
  const PI_ANSWERS = {
    category: {
      type: "choice",
      choice: "approval",
      probabilities: { approval: 0.9, correction: 0.1 },
      confidence: 0.8,
    },
    satisfaction: { type: "score", score: 1.6, confidence: 0.5 },
    approved: { type: "bool", probability: 0.2 },
  };

  it("reads every type into one thresholdable shape", () => {
    expect(readDecisionAnswers(QUESTIONS, PI_ANSWERS)).toEqual({
      category: {
        type: "choice",
        choice: "approval",
        probabilities: { approval: 0.9, correction: 0.1 },
        confidence: 0.8,
      },
      satisfaction: { type: "score", score: 1.6, level: 2, label: "satisfied", confidence: 0.5 },
      approved: { type: "bool", value: false, probability: 0.2, confidence: 0.6 },
    });
  });

  it("reads a missing option probability as zero", () => {
    const answers = readDecisionAnswers(
      { category: QUESTIONS.category },
      {
        category: {
          type: "choice",
          choice: "approval",
          probabilities: { approval: 1 },
          confidence: 1,
        },
      },
    );
    expect(answers?.category).toMatchObject({ probabilities: { approval: 1, correction: 0 } });
  });

  it("is all or nothing", () => {
    const { approved: _approved, ...partial } = PI_ANSWERS;
    expect(readDecisionAnswers(QUESTIONS, partial)).toBeNull();
    expect(readDecisionAnswers(QUESTIONS, null)).toBeNull();
  });

  it("refuses every answer of the wrong shape", () => {
    const wrong = (patch: Record<string, unknown>) =>
      readDecisionAnswers(QUESTIONS, { ...PI_ANSWERS, ...patch });
    expect(wrong({ approved: { type: "choice", probability: 0.5 } })).toBeNull();
    expect(wrong({ approved: { type: "bool", probability: 1.5 } })).toBeNull();
    expect(wrong({ approved: "yes" })).toBeNull();
    expect(wrong({ category: { ...PI_ANSWERS.category, choice: "other" } })).toBeNull();
    // An inherited name is not one of the options.
    expect(wrong({ category: { ...PI_ANSWERS.category, choice: "toString" } })).toBeNull();
    expect(wrong({ category: { ...PI_ANSWERS.category, probabilities: null } })).toBeNull();
    expect(wrong({ category: { ...PI_ANSWERS.category, confidence: Number.NaN } })).toBeNull();
    expect(
      wrong({ category: { ...PI_ANSWERS.category, probabilities: { approval: -1 } } }),
    ).toBeNull();
    expect(wrong({ satisfaction: { type: "score", score: 3, confidence: 1 } })).toBeNull();
    expect(wrong({ satisfaction: { type: "score", score: -0.1, confidence: 1 } })).toBeNull();
    expect(wrong({ satisfaction: { type: "score", score: "1", confidence: 1 } })).toBeNull();
    expect(wrong({ satisfaction: { type: "score", score: 1, confidence: 2 } })).toBeNull();
  });

  it("marks a sure yes as sure", () => {
    expect(
      readDecisionAnswers(
        { approved: QUESTIONS.approved },
        { approved: { type: "bool", probability: 1 } },
      ),
    ).toEqual({ approved: { type: "bool", value: true, probability: 1, confidence: 1 } });
  });
});

function fieldNames(fields: readonly VerbToolField[], prefix: string): string[] {
  return fields.flatMap((field) => [
    `${prefix}.${field.name}`,
    ...(field.type === "object" ? fieldNames(field.fields, `${prefix}.${field.name}`) : []),
  ]);
}

describe("credentials are routed to the person", () => {
  // The ticket's rule (VC-470's, carried here): no agent verb or tool accepts,
  // sees or stores a key. The classify tool's own inputs are pinned in
  // `classify-tool.test.ts`; this pins the Verb Registry — every door an agent
  // can reach a product operation through — and the setting itself.
  const SECRETISH = /api.?key|token|secret|credential|password/i;

  it("offers no agent verb that configures a decision model or carries a key", () => {
    for (const verb of VERB_REGISTRY as readonly VerbEntry[]) {
      expect(verb.key).not.toMatch(/decision|classif/i);
      const names = [
        ...fieldNames(verb.tool?.input ?? [], verb.key),
        ...verb.options.map((option) => `${verb.key} ${option.name}`),
      ];
      for (const name of names) expect(name).not.toMatch(SECRETISH);
    }
  });

  it("has no setting field a key could occupy", () => {
    for (const setting of [NO_DECISION_MODEL, LOCAL, CLOUD]) {
      expect(JSON.stringify(Object.keys(setting))).not.toMatch(SECRETISH);
    }
  });
});
