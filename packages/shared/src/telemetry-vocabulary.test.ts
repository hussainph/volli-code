import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  OBSERVED_TOOL_IDS,
  type CompactionEvent,
  type DroppedEvent,
  type TurnEvent,
} from "./agent-observability";
import {
  RUNTIME_ATTENTION_REASONS,
  RUNTIME_FAILURE_REASONS,
  type AttentionObservation,
  type RuntimeFailure,
} from "./agent-runtime";
import {
  COMPACTION_OUTCOMES,
  CUSTOM_CATALOG_ID,
  FEATURE_IDS,
  ISO_REGION_CODES,
  MAX_TELEMETRY_ROWS,
  REPORTABLE_ERROR_CODES,
  TELEMETRY_DROP_REASONS,
  TELEMETRY_EVENTS,
  TURN_OUTCOMES,
  UNKNOWN_VERSION,
  catalogModelRef,
  closedWord,
  isTelemetryEvent,
  isoRegionCode,
  reportableErrorCode,
  telemetryVersion,
  type AgentRollupEvent,
  type AppStartedEvent,
  type CatalogModelId,
  type CatalogProviderId,
  type TelemetryEvent,
  type TelemetryEventName,
  type TelemetryFieldSpec,
  type TelemetryModelCatalog,
  type TelemetryProperties,
  type TelemetryVersion,
} from "./telemetry-vocabulary";

/**
 * The dotted paths of every leaf in `T` that can hold an arbitrary string.
 *
 * `string extends Leaf` is true for `string` itself (and any union holding
 * it) and false for a literal union or a branded catalog id — which is
 * exactly the line between an open string and a closed one.
 */
type OpenStringPaths<T, Path extends string = ""> = T extends readonly (infer Row)[]
  ? OpenStringPaths<Row, `${Path}[]`>
  : T extends object
    ? { [K in keyof T & string]-?: OpenStringPaths<T[K], `${Path}.${K}`> }[keyof T & string]
    : string extends T
      ? Path
      : never;

describe("the closed vocabulary, at the type level", () => {
  it("has no leaf that can hold an open string", () => {
    expectTypeOf<OpenStringPaths<TelemetryEvent>>().toEqualTypeOf<never>();
  });

  it("would notice one, so the check above is not vacuous", () => {
    expectTypeOf<OpenStringPaths<{ a: { b: string } }>>().toEqualTypeOf<".a.b">();
    expectTypeOf<OpenStringPaths<{ rows: { name?: string }[] }>>().toEqualTypeOf<".rows[].name">();
    expectTypeOf<OpenStringPaths<{ id: CatalogModelId | "custom" }>>().toEqualTypeOf<never>();
    // The realistic regression: a word field fed a widened `string[]`.
    type Widened = TelemetryProperties<{
      x: { readonly type: "word"; readonly values: readonly string[]; readonly doc: "" };
    }>;
    expectTypeOf<OpenStringPaths<Widened>>().toEqualTypeOf<".x">();
  });

  it("derives each field's type from its spec", () => {
    type Props = AppStartedEvent["properties"];
    expectTypeOf<Props["launch"]>().toEqualTypeOf<"first-run" | "update" | "normal">();
    expectTypeOf<Props["cold_start_ms"]>().toEqualTypeOf<number>();
    expectTypeOf<Props["signed_in"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Props["app_version"]>().toEqualTypeOf<TelemetryVersion | "unknown">();
    expectTypeOf<Props["os_region"]>().toEqualTypeOf<
      (typeof ISO_REGION_CODES)[number] | undefined
    >();

    type Row = AgentRollupEvent["properties"]["models"][number];
    expectTypeOf<Row["gen_ai.provider.name"]>().toEqualTypeOf<CatalogProviderId | "custom">();
    expectTypeOf<Row["stop_reasons"]["toolUse"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<
      AgentRollupEvent["properties"]["tools"][number]["gen_ai.tool.name"]
    >().toEqualTypeOf<(typeof OBSERVED_TOOL_IDS)[number] | undefined>();
  });

  it("does not accept an unnarrowed string where a catalog id belongs", () => {
    expectTypeOf<string>().not.toMatchTypeOf<CatalogProviderId>();
    expectTypeOf<CatalogProviderId>().not.toMatchTypeOf<CatalogModelId>();
  });

  it("tallies the outcomes and drops the VC-119 events already name", () => {
    expectTypeOf<(typeof TURN_OUTCOMES)[number]>().toEqualTypeOf<TurnEvent["outcome"]>();
    expectTypeOf<(typeof COMPACTION_OUTCOMES)[number]>().toEqualTypeOf<
      CompactionEvent["outcome"]
    >();
    expectTypeOf<DroppedEvent["reason"]>().toMatchTypeOf<(typeof TELEMETRY_DROP_REASONS)[number]>();
  });

  it("keeps the runtime reason lists equal to the unions they tally", () => {
    expectTypeOf<(typeof RUNTIME_FAILURE_REASONS)[number]>().toEqualTypeOf<
      RuntimeFailure["reason"]
    >();
    expectTypeOf<(typeof RUNTIME_ATTENTION_REASONS)[number]>().toEqualTypeOf<
      AttentionObservation["reason"]
    >();
  });
});

// ── Random conforming events, generated from the schema itself ──────────────

/** mulberry32: small, seedable, good enough to walk a schema. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function sampleField(random: () => number, field: TelemetryFieldSpec): unknown {
  switch (field.type) {
    case "word":
      return pick(random, field.values);
    case "count":
      return Math.floor(random() * 1e6);
    case "integer":
      return Math.floor(random() * 2e6) - 1e6;
    case "duration":
      return random() * 1e5;
    case "rate":
      return 1 - random() * 0.99;
    case "flag":
      return random() < 0.5;
    case "catalog":
      return field.catalog === "version"
        ? pick(random, ["0.3.0", "1.2.3-canary.4", UNKNOWN_VERSION])
        : pick(random, ["anthropic", "claude-sonnet-4-5", "anthropic/claude-opus-4.1", "custom"]);
    case "tally":
      return Object.fromEntries(
        field.keys.filter(() => random() < 0.5).map((key) => [key, Math.floor(random() * 50)]),
      );
    case "rows":
      return Array.from({ length: Math.floor(random() * 4) }, () =>
        sampleFields(random, field.fields),
      );
  }
}

function sampleFields(
  random: () => number,
  fields: Readonly<Record<string, TelemetryFieldSpec>>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.optional === true && random() < 0.5) continue;
    properties[key] = sampleField(random, field);
  }
  return properties;
}

const EVENT_NAMES = Object.keys(TELEMETRY_EVENTS) as TelemetryEventName[];

function sampleEvent(random: () => number): {
  event: TelemetryEventName;
  properties: Record<string, unknown>;
} {
  const event = pick(random, EVENT_NAMES);
  return { event, properties: sampleFields(random, TELEMETRY_EVENTS[event].fields) };
}

/** Every leaf of a value, as a path and a setter that replaces it. */
function leaves(value: unknown, path = ""): { path: string; replace: (next: unknown) => void }[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = `${path}.${key}`;
    if (typeof child === "object" && child !== null) return leaves(child, here);
    return [
      { path: here, replace: (next: unknown) => ((value as Record<string, unknown>)[key] = next) },
    ];
  });
}

describe("random events generated from the schema", () => {
  const random = prng(505);
  const samples = Array.from({ length: 400 }, () => sampleEvent(random));

  it("cover every event", () => {
    expect(new Set(samples.map((sample) => sample.event))).toEqual(new Set(EVENT_NAMES));
  });

  it("conform, and survive a JSON round trip unchanged", () => {
    for (const sample of samples) {
      expect(isTelemetryEvent(sample), JSON.stringify(sample)).toBe(true);
      expect(isTelemetryEvent(JSON.parse(JSON.stringify(sample)))).toBe(true);
    }
  });

  it("stop conforming the moment any leaf becomes free text", () => {
    for (const sample of samples.slice(0, 60)) {
      for (const leaf of leaves(sample.properties)) {
        const copy = structuredClone(sample);
        const target = leaves(copy.properties).find((candidate) => candidate.path === leaf.path);
        target?.replace("SENSITIVE /Users/someone/secret-project prompt text");
        expect(isTelemetryEvent(copy), `${sample.event}${leaf.path}`).toBe(false);
      }
    }
  });
});

function appStarted(): AppStartedEvent {
  return {
    event: "app_started",
    properties: {
      cold_start_ms: 812,
      launch: "normal",
      app_version: telemetryVersion("0.3.0") as TelemetryVersion,
      channel: "release",
      os: "darwin",
      os_version_major: 26,
      arch: "arm64",
      signed_in: false,
    },
  };
}

function appStartedWith(patch: Record<string, unknown>) {
  const base = appStarted();
  return { ...base, properties: { ...base.properties, ...patch } };
}

function rendererGone(exitCode: unknown) {
  return { event: "renderer_gone", properties: { reason: "crashed", exit_code: exitCode } };
}

function turnSampled(sampleRate: unknown) {
  return {
    event: "turn_sampled",
    properties: {
      duration_ms: 1,
      attempts: 1,
      tool_calls: 0,
      outcome: "completed",
      sample_rate: sampleRate,
    },
  };
}

function rollup(patch: Record<string, unknown>) {
  return {
    event: "agent_rollup",
    properties: {
      window_ms: 3_600_000,
      models: [],
      tools: [],
      turns: {},
      compactions: [],
      attachment_failures: {},
      attention_raised: {},
      dropped: {},
      ...patch,
    },
  };
}

function modelRow(patch: Record<string, unknown>) {
  return {
    "gen_ai.provider.name": "anthropic",
    "gen_ai.request.model": "claude-sonnet-4-5",
    attempts: 3,
    stop_reasons: { stop: 2, error: 1 },
    provider_error_classes: { "rate-limit": 1 },
    "gen_ai.usage.input_tokens": 10,
    "gen_ai.usage.output_tokens": 10,
    "gen_ai.usage.cache_read.input_tokens": 100,
    "gen_ai.usage.cache_creation.input_tokens": 0,
    "gen_ai.usage.reasoning.output_tokens": 0,
    ...patch,
  };
}

/** Every field of a field map, with a `rows` field's own fields under `name[].`. */
function allFields(
  fields: Readonly<Record<string, TelemetryFieldSpec>>,
  path = "",
): [string, TelemetryFieldSpec][] {
  const out: [string, TelemetryFieldSpec][] = [];
  for (const [key, field] of Object.entries(fields)) {
    out.push([`${path}${key}`, field]);
    if (field.type === "rows") out.push(...allFields(field.fields, `${path}${key}[].`));
  }
  return out;
}

describe("isTelemetryEvent", () => {
  it("accepts a well-formed event", () => {
    expect(isTelemetryEvent(appStarted())).toBe(true);
  });

  it.each([
    ["a non-object", "app_started"],
    ["null", null],
    ["an array", []],
    ["a class instance", new Map()],
    ["an extra envelope key", { ...appStarted(), distinct_id: "x" }],
    ["a missing properties key", { event: "app_started" }],
    ["an unknown event", { event: "page_view", properties: {} }],
    ["a non-string event", { event: 1, properties: {} }],
    ["an inherited event name", { event: "toString", properties: {} }],
    ["non-object properties", { event: "feature_used", properties: "terminal-open" }],
    [
      "an undeclared field",
      { event: "feature_used", properties: { feature: "terminal-open", path: "/x" } },
    ],
    ["a missing required field", { event: "feature_used", properties: {} }],
    ["a word off the list", { event: "feature_used", properties: { feature: "secret-feature" } }],
  ])("rejects %s", (_label, value) => {
    expect(isTelemetryEvent(value)).toBe(false);
  });

  it("holds each numeric shape to its own bounds", () => {
    expect(isTelemetryEvent(appStartedWith({ os_version_major: -1 }))).toBe(false);
    expect(isTelemetryEvent(appStartedWith({ os_version_major: 1.5 }))).toBe(false);
    expect(isTelemetryEvent(appStartedWith({ cold_start_ms: -1 }))).toBe(false);
    expect(isTelemetryEvent(appStartedWith({ cold_start_ms: Number.POSITIVE_INFINITY }))).toBe(
      false,
    );
    expect(isTelemetryEvent(appStartedWith({ cold_start_ms: "812" }))).toBe(false);
    expect(isTelemetryEvent(appStartedWith({ signed_in: 1 }))).toBe(false);
    expect(isTelemetryEvent(appStartedWith({ app_version: "0.3.0-dev+local" }))).toBe(false);
    expect(isTelemetryEvent(appStartedWith({ app_version: UNKNOWN_VERSION }))).toBe(true);
    expect(isTelemetryEvent(appStartedWith({ os_region: "GB" }))).toBe(true);
    expect(isTelemetryEvent(appStartedWith({ os_region: "XK" }))).toBe(false);

    expect(isTelemetryEvent(rendererGone(-1073741819))).toBe(true);
    expect(isTelemetryEvent(rendererGone(0.5))).toBe(false);

    expect(isTelemetryEvent(turnSampled(0.1))).toBe(true);
    expect(isTelemetryEvent(turnSampled(1))).toBe(true);
    expect(isTelemetryEvent(turnSampled(0))).toBe(false);
    expect(isTelemetryEvent(turnSampled(1.5))).toBe(false);
    expect(isTelemetryEvent(turnSampled("0.1"))).toBe(false);
  });

  it("holds tallies, rows and catalog ids to theirs", () => {
    expect(isTelemetryEvent(rollup({ models: [modelRow({})] }))).toBe(true);
    expect(isTelemetryEvent(rollup({ turns: { completed: 4 } }))).toBe(true);
    expect(isTelemetryEvent(rollup({ turns: { abandoned: 4 } }))).toBe(false);
    expect(isTelemetryEvent(rollup({ turns: { completed: -4 } }))).toBe(false);
    expect(isTelemetryEvent(rollup({ turns: [4] }))).toBe(false);
    expect(isTelemetryEvent(rollup({ models: {} }))).toBe(false);
    expect(isTelemetryEvent(rollup({ models: ["anthropic"] }))).toBe(false);
    expect(
      isTelemetryEvent(
        rollup({ models: Array.from({ length: MAX_TELEMETRY_ROWS + 1 }, () => modelRow({})) }),
      ),
    ).toBe(false);
    expect(
      isTelemetryEvent(
        rollup({ models: [modelRow({ "gen_ai.provider.name": CUSTOM_CATALOG_ID })] }),
      ),
    ).toBe(true);
    expect(
      isTelemetryEvent(
        rollup({ models: [modelRow({ "gen_ai.request.model": "my model with spaces" })] }),
      ),
    ).toBe(false);
    expect(isTelemetryEvent(rollup({ models: [modelRow({ "gen_ai.provider.name": 7 })] }))).toBe(
      false,
    );
  });
});

describe("the schema", () => {
  it("documents every event and field, with non-empty unique word lists", () => {
    for (const [name, spec] of Object.entries(TELEMETRY_EVENTS)) {
      expect(spec.doc.trim(), name).not.toBe("");
      for (const [path, field] of allFields(spec.fields)) {
        expect(field.doc.trim(), `${name}.${path}`).not.toBe("");
        const words =
          field.type === "word" ? field.values : field.type === "tally" ? field.keys : null;
        if (words !== null) {
          expect(words.length, `${name}.${path}`).toBeGreaterThan(0);
          expect(new Set(words).size, `${name}.${path}`).toBe(words.length);
        }
      }
    }
  });

  it("names events and features in one style", () => {
    for (const name of EVENT_NAMES) expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    for (const feature of FEATURE_IDS) expect(feature).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(new Set(FEATURE_IDS).size).toBe(FEATURE_IDS.length);
  });

  it("does not carry the retired authority-denial vocabulary", () => {
    expect(JSON.stringify(TELEMETRY_EVENTS)).not.toMatch(/authority|denial/i);
  });
});

describe("ISO_REGION_CODES", () => {
  it("is the 249 assigned ISO 3166-1 alpha-2 codes, sorted and unique", () => {
    expect(ISO_REGION_CODES).toHaveLength(249);
    expect(new Set(ISO_REGION_CODES).size).toBe(249);
    expect([...ISO_REGION_CODES]).toEqual([...ISO_REGION_CODES].toSorted());
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (const code of ISO_REGION_CODES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(names.of(code), code).not.toBe(code);
    }
  });

  it("narrows what the OS reports", () => {
    expect(isoRegionCode("CA")).toBe("CA");
    expect(isoRegionCode(" gb ")).toBe("GB");
    expect(isoRegionCode("")).toBeUndefined();
    expect(isoRegionCode("XK")).toBeUndefined();
    expect(isoRegionCode("419")).toBeUndefined();
    expect(isoRegionCode(undefined)).toBeUndefined();
  });
});

describe("catalogModelRef", () => {
  const catalog: TelemetryModelCatalog = new Map([
    ["anthropic", new Set(["claude-sonnet-4-5"])],
    ["openrouter", new Set(["anthropic/claude-opus-4.1"])],
    ["weird", new Set(["has space"])],
  ]);

  it("speaks a catalog provider and model", () => {
    expect(catalogModelRef(catalog, "anthropic", "claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(catalogModelRef(catalog, "openrouter", "anthropic/claude-opus-4.1").model).toBe(
      "anthropic/claude-opus-4.1",
    );
  });

  it("reports a model added under a built-in provider as custom", () => {
    expect(catalogModelRef(catalog, "anthropic", "acme-internal-llm")).toEqual({
      provider: "anthropic",
      model: "custom",
    });
  });

  it("reports a custom provider's model as custom, whatever it is called", () => {
    expect(catalogModelRef(catalog, "acme", "claude-sonnet-4-5")).toEqual({
      provider: "custom",
      model: "custom",
    });
  });

  it("holds even a catalog entry to the id shape", () => {
    expect(catalogModelRef(catalog, "weird", "has space").model).toBe("custom");
    expect(catalogModelRef(catalog, "x".repeat(200), "m").provider).toBe("custom");
    expect(catalogModelRef(catalog, undefined, 3)).toEqual({ provider: "custom", model: "custom" });
  });
});

describe("narrowing helpers", () => {
  it("telemetryVersion keeps release version strings only", () => {
    expect(telemetryVersion("0.3.0")).toBe("0.3.0");
    expect(telemetryVersion("0.3.0-canary.12")).toBe("0.3.0-canary.12");
    expect(telemetryVersion("0.3.0-dev")).toBe(UNKNOWN_VERSION);
    expect(telemetryVersion("0.3.0+sha.abc")).toBe(UNKNOWN_VERSION);
    expect(telemetryVersion(3)).toBe(UNKNOWN_VERSION);
  });

  it("closedWord passes a listed word and nothing else", () => {
    expect(closedWord(["arm64", "x64"] as const, "x64")).toBe("x64");
    expect(closedWord(["arm64", "x64"] as const, "riscv64")).toBeUndefined();
    expect(closedWord(["arm64", "x64"] as const, null)).toBeUndefined();
  });

  it("reportableErrorCode reads a listed code and never the message", () => {
    expect(reportableErrorCode({ code: "trash-unavailable", message: "/Users/x" })).toBe(
      "trash-unavailable",
    );
    expect(
      reportableErrorCode(Object.assign(new Error("ENOENT /Users/x"), { code: "ENOENT" })),
    ).toBeUndefined();
    expect(reportableErrorCode(new Error("trash-unavailable"))).toBeUndefined();
    expect(reportableErrorCode("trash-unavailable")).toBeUndefined();
    expect(reportableErrorCode(null)).toBeUndefined();
  });

  it("lists reportable codes once, in one of the two code styles Volli uses", () => {
    expect(new Set(REPORTABLE_ERROR_CODES).size).toBe(REPORTABLE_ERROR_CODES.length);
    for (const code of REPORTABLE_ERROR_CODES) expect(code).toMatch(/^[a-z]+(?:[-_][a-z]+)*$/);
  });
});
