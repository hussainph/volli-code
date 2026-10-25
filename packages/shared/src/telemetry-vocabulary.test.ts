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
  CUSTOM_CATALOG_ID,
  FEATURE_IDS,
  MAX_TELEMETRY_ROWS,
  REPORTABLE_ERROR_CODES,
  TELEMETRY_EVENTS,
  UNKNOWN_VERSION,
  catalogModelRef,
  closedWord,
  isoRegionCode,
  reportableErrorCode,
  serializeTelemetryEvent,
  telemetryModelCatalog,
  telemetryVersion,
  type AgentRollupEvent,
  type AppStartedEvent,
  type CatalogModelId,
  type CatalogProviderId,
  type IsoRegionCode,
  type TelemetryEvent,
  type TelemetryModelCatalog,
  type TelemetryVersion,
} from "./telemetry-vocabulary";

// ── Type level ───────────────────────────────────────────────────────────────

type Brand = CatalogProviderId | CatalogModelId | TelemetryVersion;

/** Whether `S` admits keys beyond a finite literal set (`string`, `string & {}`, templates). */
type IsOpen<S> = {} extends Record<S & PropertyKey, never> ? true : false;

/**
 * The paths in `T` that can hold an open string: a leaf that admits text
 * beyond a finite literal set, or an object whose keys do (`{key}`). Catalog
 * brands are the one deliberate exception — they are closed at runtime by the
 * catalog, which the serializer checks.
 */
type OpenPaths<T, P extends string = ""> = T extends readonly (infer R)[]
  ? OpenPaths<R, `${P}[]`>
  : T extends Brand
    ? never
    : T extends string
      ? IsOpen<T> extends true
        ? P
        : never
      : T extends object
        ?
            | ([keyof T] extends [never]
                ? never
                : IsOpen<keyof T> extends true
                  ? `${P}{key}`
                  : never)
            | { [K in keyof T & string]-?: OpenPaths<T[K], `${P}.${K}`> }[keyof T & string]
        : never;

type Rollup = AgentRollupEvent["properties"];

describe("the closed vocabulary, at the type level", () => {
  it("has no leaf or key that can hold an open string", () => {
    expectTypeOf<OpenPaths<TelemetryEvent>>().toEqualTypeOf<never>();
  });

  it("would notice one, so the check above is not vacuous", () => {
    expectTypeOf<OpenPaths<{ a: { b: string } }>>().toEqualTypeOf<".a.b">();
    expectTypeOf<OpenPaths<{ rows: { name?: string }[] }>>().toEqualTypeOf<".rows[].name">();
    expectTypeOf<OpenPaths<{ a: string & {} }>>().toEqualTypeOf<".a">();
    expectTypeOf<OpenPaths<{ a: string & { __brand: "x" } }>>().toEqualTypeOf<".a">();
    expectTypeOf<OpenPaths<{ a: `user-${string}` }>>().toEqualTypeOf<".a">();
    // A tally whose keys widened: open keys carry text as surely as open values.
    expectTypeOf<OpenPaths<{ t: { [k: string]: number } }>>().toEqualTypeOf<".t{key}">();
    expectTypeOf<OpenPaths<{ t: { a?: number; b?: number } }>>().toEqualTypeOf<never>();
    expectTypeOf<OpenPaths<{ id: CatalogModelId | "custom" }>>().toEqualTypeOf<never>();
  });

  it("derives each field's type from its spec", () => {
    type Props = AppStartedEvent["properties"];
    expectTypeOf<Props["launch"]>().toEqualTypeOf<"first-run" | "update" | "normal">();
    expectTypeOf<Props["cold_start_ms"]>().toEqualTypeOf<number>();
    expectTypeOf<Props["signed_in"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Props["app_version"]>().toEqualTypeOf<TelemetryVersion | "unknown">();
    expectTypeOf<Props["os_region"]>().toEqualTypeOf<IsoRegionCode | undefined>();

    type Row = Rollup["models"][number];
    expectTypeOf<Row["gen_ai.provider.name"]>().toEqualTypeOf<CatalogProviderId | "custom">();
    expectTypeOf<Row["gen_ai.request.model"]>().toEqualTypeOf<CatalogModelId | "custom">();
    expectTypeOf<Row["stop_reasons"]["toolUse"]>().toEqualTypeOf<number | undefined>();
    type Tool = Rollup["tools"][number];
    expectTypeOf<Tool["gen_ai.tool.name"]>().toEqualTypeOf<
      (typeof OBSERVED_TOOL_IDS)[number] | undefined
    >();
    expectTypeOf<Tool["gen_ai.request.model"]>().toEqualTypeOf<CatalogModelId | "custom">();
  });

  it("does not accept an unnarrowed string where a catalog id belongs", () => {
    expectTypeOf<string>().not.toMatchTypeOf<CatalogProviderId>();
    expectTypeOf<CatalogProviderId>().not.toMatchTypeOf<CatalogModelId>();
    expectTypeOf<string>().not.toMatchTypeOf<TelemetryVersion>();
  });

  it("tallies the outcomes and drops the VC-119 events already name", () => {
    expectTypeOf<keyof Rollup["turns"]>().toEqualTypeOf<TurnEvent["outcome"]>();
    expectTypeOf<Rollup["compactions"][number]["outcome"]>().toEqualTypeOf<
      CompactionEvent["outcome"]
    >();
    expectTypeOf<DroppedEvent["reason"]>().toMatchTypeOf<keyof Rollup["dropped"]>();
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CATALOG = telemetryModelCatalog([
  ["anthropic", ["claude-sonnet-4-5", "claude-opus-4-1"]],
  ["openrouter", ["anthropic/claude-opus-4.1"]],
]);

const CATALOG_PAIRS: readonly (readonly [string, string])[] = [
  ["anthropic", "claude-sonnet-4-5"],
  ["anthropic", "claude-opus-4-1"],
  ["anthropic", "custom"],
  ["openrouter", "anthropic/claude-opus-4.1"],
  ["custom", "custom"],
];

type FieldSpec = { readonly type: string; readonly optional?: boolean; readonly doc: string } & {
  readonly values?: readonly string[];
  readonly keys?: readonly string[];
  readonly provider?: string;
  readonly fields?: FieldMap;
};
type FieldMap = Readonly<Record<string, FieldSpec>>;

const EVENTS = TELEMETRY_EVENTS as unknown as Readonly<
  Record<string, { readonly doc: string; readonly fields: FieldMap }>
>;
const EVENT_NAMES = Object.keys(EVENTS);
const ISO_REGION_CODES = TELEMETRY_EVENTS.app_started.fields.os_region.values;

function send(value: unknown, catalog: TelemetryModelCatalog = CATALOG): unknown {
  const json = serializeTelemetryEvent(value, catalog);
  return json === undefined ? undefined : JSON.parse(json);
}

function accepts(value: unknown): boolean {
  return serializeTelemetryEvent(value, CATALOG) !== undefined;
}

function appStarted(): AppStartedEvent {
  return {
    event: "app_started",
    properties: {
      cold_start_ms: 812,
      launch: "normal",
      app_version: telemetryVersion("0.3.0"),
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

function toolRow(patch: Record<string, unknown>) {
  return {
    "gen_ai.provider.name": "anthropic",
    "gen_ai.request.model": "claude-sonnet-4-5",
    "gen_ai.tool.name": "bash",
    activity_kind: "run-command",
    completed: 4,
    failed: 1,
    ...patch,
  };
}

/** Every field of a field map, with a `rows` field's own fields under `name[].`. */
function allFields(fields: FieldMap, path = ""): [string, FieldSpec, FieldMap][] {
  const out: [string, FieldSpec, FieldMap][] = [];
  for (const [key, field] of Object.entries(fields)) {
    out.push([`${path}${key}`, field, fields]);
    if (field.fields !== undefined) out.push(...allFields(field.fields, `${path}${key}[].`));
  }
  return out;
}

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

function sampleFields(random: () => number, fields: FieldMap): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.optional === true && random() < 0.5) continue;
    properties[key] = sampleField(random, field, properties);
  }
  return properties;
}

function sampleField(
  random: () => number,
  field: FieldSpec,
  row: Record<string, unknown>,
): unknown {
  switch (field.type) {
    case "word":
      return pick(random, field.values ?? []);
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
    case "version":
      return pick(random, ["0.3.0", "1.2.3-canary.4", UNKNOWN_VERSION]);
    case "provider":
      return pick(random, CATALOG_PAIRS)[0];
    case "model": {
      const provider = row[field.provider ?? ""];
      return pick(
        random,
        CATALOG_PAIRS.filter(([p]) => p === provider),
      )[1];
    }
    case "tally":
      return Object.fromEntries(
        (field.keys ?? [])
          .filter(() => random() < 0.5)
          .map((key) => [key, Math.floor(random() * 50)]),
      );
    case "rows":
      return Array.from({ length: Math.floor(random() * 4) }, () =>
        sampleFields(random, field.fields ?? {}),
      );
    default:
      throw new Error(`no sampler for ${field.type}`);
  }
}

function sampleEvent(random: () => number): {
  event: string;
  properties: Record<string, unknown>;
} {
  const event = pick(random, EVENT_NAMES);
  return { event, properties: sampleFields(random, EVENTS[event]?.fields ?? {}) };
}

/** Every leaf of a value, as a path and a setter that replaces it. */
function leaves(value: unknown, path = ""): { path: string; replace: (next: unknown) => void }[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = `${path}.${key}`;
    if (typeof child === "object" && child !== null) return leaves(child, here);
    return [
      {
        path: here,
        replace: (next: unknown) => ((value as Record<string, unknown>)[key] = next),
      },
    ];
  });
}

describe("random events generated from the schema", () => {
  const random = prng(505);
  const samples = Array.from({ length: 400 }, () => sampleEvent(random));

  it("cover every event", () => {
    expect(new Set(samples.map((sample) => sample.event))).toEqual(new Set(EVENT_NAMES));
  });

  it("serialize to exactly themselves", () => {
    for (const sample of samples) {
      expect(send(sample), JSON.stringify(sample)).toEqual(sample);
    }
  });

  it.each([
    ["free text", "SENSITIVE /Users/someone/secret-project prompt text"],
    ["an id-shaped name", "acme-internal-llm"],
    ["an email", "jane.doe@example.com"],
  ])("stop serializing the moment any leaf becomes %s", (_label, text) => {
    for (const sample of samples.slice(0, 80)) {
      for (const leaf of leaves(sample.properties)) {
        const copy = structuredClone(sample);
        const target = leaves(copy.properties).find((candidate) => candidate.path === leaf.path);
        target?.replace(text);
        expect(accepts(copy), `${sample.event}${leaf.path}`).toBe(false);
      }
    }
  });
});

// ── serializeTelemetryEvent ──────────────────────────────────────────────────

describe("serializeTelemetryEvent", () => {
  it("returns the event's JSON", () => {
    expect(serializeTelemetryEvent(appStarted(), CATALOG)).toBe(JSON.stringify(appStarted()));
  });

  it.each([
    ["a non-object", "app_started"],
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["an extra envelope key", { ...appStarted(), distinct_id: "x" }],
    ["a missing properties key", { event: "app_started" }],
    ["a duplicate-free but wrong pair of keys", { event: "app_started", props: {} }],
    ["an unknown event", { event: "page_view", properties: {} }],
    ["a non-string event", { event: 1, properties: {} }],
    ["an inherited event name", { event: "toString", properties: {} }],
    ["non-object properties", { event: "feature_used", properties: "terminal-open" }],
    ["array properties", { event: "feature_used", properties: ["terminal-open"] }],
    [
      "an undeclared field",
      { event: "feature_used", properties: { feature: "terminal-open", path: "/x" } },
    ],
    ["a missing required field", { event: "feature_used", properties: {} }],
    ["a word off the list", { event: "feature_used", properties: { feature: "secret-feature" } }],
    [
      "a __proto__ key",
      JSON.parse('{"event":"feature_used","properties":{"feature":"ticket-open","__proto__":1}}'),
    ],
  ])("rejects %s", (_label, value) => {
    expect(serializeTelemetryEvent(value, CATALOG)).toBeUndefined();
  });

  it("treats an optional field left undefined as absent", () => {
    expect(send(appStartedWith({ os_region: isoRegionCode("") }))).toEqual(appStarted());
    const tool = toolRow({ "gen_ai.tool.name": undefined });
    expect(send(rollup({ tools: [tool], turns: { completed: undefined } }))).toEqual(
      rollup({ tools: [toolRow({ "gen_ai.tool.name": undefined })], turns: {} }),
    );
  });

  it("checks what is sent, not what the value shows the check", () => {
    const event = appStarted();
    // A toJSON that adds text the object itself does not hold.
    const withToJson = {
      ...event,
      properties: {
        ...event.properties,
        toJSON: () => ({ ...event.properties, leak: "/Users/x" }),
      },
    };
    expect(serializeTelemetryEvent(withToJson, CATALOG)).toBeUndefined();

    // A non-enumerable `properties` plus an enumerable extra key.
    const hidden = { event: "app_started", leak: "/Users/x" };
    Object.defineProperty(hidden, "properties", { value: event.properties, enumerable: false });
    expect(serializeTelemetryEvent(hidden, CATALOG)).toBeUndefined();

    // A getter that answers differently on a second read.
    let reads = 0;
    const flipping = {
      event: "feature_used",
      properties: {
        get feature() {
          reads += 1;
          return reads === 1 ? "ticket-open" : "/Users/x";
        },
      },
    };
    const json = serializeTelemetryEvent(flipping, CATALOG);
    expect(json).toBe('{"event":"feature_used","properties":{"feature":"ticket-open"}}');

    // Sparse rows serialize as null, which is not a row.
    // oxlint-disable-next-line no-sparse-arrays
    expect(serializeTelemetryEvent(rollup({ compactions: [,] }), CATALOG)).toBeUndefined();
  });

  it("returns undefined for a value JSON cannot hold", () => {
    expect(serializeTelemetryEvent(appStartedWith({ cold_start_ms: 1n }), CATALOG)).toBeUndefined();
    const cyclic: Record<string, unknown> = { event: "feature_used" };
    cyclic.properties = cyclic;
    expect(serializeTelemetryEvent(cyclic, CATALOG)).toBeUndefined();
    expect(serializeTelemetryEvent(() => {}, CATALOG)).toBeUndefined();
  });

  it("holds each numeric shape to its own bounds", () => {
    expect(accepts(appStartedWith({ os_version_major: -1 }))).toBe(false);
    expect(accepts(appStartedWith({ os_version_major: 1.5 }))).toBe(false);
    expect(accepts(appStartedWith({ cold_start_ms: -1 }))).toBe(false);
    expect(accepts(appStartedWith({ cold_start_ms: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(accepts(appStartedWith({ cold_start_ms: Number.NaN }))).toBe(false);
    expect(accepts(appStartedWith({ cold_start_ms: "812" }))).toBe(false);
    expect(accepts(appStartedWith({ signed_in: 1 }))).toBe(false);
    expect(accepts(appStartedWith({ app_version: "0.3.0-dev+local" }))).toBe(false);
    expect(accepts(appStartedWith({ app_version: UNKNOWN_VERSION }))).toBe(true);
    expect(accepts(appStartedWith({ os_region: "GB" }))).toBe(true);
    expect(accepts(appStartedWith({ os_region: "XK" }))).toBe(false);

    expect(accepts(rendererGone(-1073741819))).toBe(true);
    expect(accepts(rendererGone(0.5))).toBe(false);

    expect(accepts(turnSampled(0.1))).toBe(true);
    expect(accepts(turnSampled(1))).toBe(true);
    expect(accepts(turnSampled(0))).toBe(false);
    expect(accepts(turnSampled(1.5))).toBe(false);
    expect(accepts(turnSampled("0.1"))).toBe(false);
  });

  it("holds tallies and rows to theirs", () => {
    expect(accepts(rollup({ models: [modelRow({})], tools: [toolRow({})] }))).toBe(true);
    expect(accepts(rollup({ turns: { completed: 4 } }))).toBe(true);
    expect(accepts(rollup({ turns: { completed: 0 } }))).toBe(true);
    expect(accepts(rollup({ turns: { abandoned: 4 } }))).toBe(false);
    expect(accepts(rollup({ turns: { completed: -4 } }))).toBe(false);
    expect(accepts(rollup({ turns: [4] }))).toBe(false);
    expect(accepts(rollup({ turns: null }))).toBe(false);
    expect(accepts(rollup({ models: {} }))).toBe(false);
    expect(accepts(rollup({ models: ["anthropic"] }))).toBe(false);
    const full = Array.from({ length: MAX_TELEMETRY_ROWS }, () => modelRow({}));
    expect(accepts(rollup({ models: full }))).toBe(true);
    expect(accepts(rollup({ models: [...full, modelRow({})] }))).toBe(false);
  });

  it("holds every provider and model to the catalog", () => {
    const models = (provider: unknown, model: unknown) =>
      rollup({
        models: [modelRow({ "gen_ai.provider.name": provider, "gen_ai.request.model": model })],
      });
    const tools = (provider: unknown, model: unknown) =>
      rollup({
        tools: [toolRow({ "gen_ai.provider.name": provider, "gen_ai.request.model": model })],
      });
    for (const build of [models, tools]) {
      expect(accepts(build("anthropic", "claude-opus-4-1"))).toBe(true);
      expect(accepts(build("anthropic", "custom"))).toBe(true);
      expect(accepts(build("custom", "custom"))).toBe(true);
      // Id-shaped, so only the catalog can refuse them.
      expect(accepts(build("acme", "acme-internal-llm"))).toBe(false);
      expect(accepts(build("anthropic", "acme-internal-llm"))).toBe(false);
      expect(accepts(build("anthropic", "jane.doe@example.com"))).toBe(false);
      expect(accepts(build("Users/jane/secret-project", "custom"))).toBe(false);
      // A catalog model spoken under the wrong provider, or a custom one.
      expect(accepts(build("openrouter", "claude-opus-4-1"))).toBe(false);
      expect(accepts(build("custom", "claude-opus-4-1"))).toBe(false);
      expect(accepts(build(7, "custom"))).toBe(false);
    }
    // The same event against a catalog that lacks the model.
    const narrower = telemetryModelCatalog([["anthropic", []]]);
    expect(send(models("anthropic", "claude-opus-4-1"), narrower)).toBeUndefined();
  });
});

// ── Schema ───────────────────────────────────────────────────────────────────

describe("the schema", () => {
  it("documents every event and field, with non-empty unique word lists", () => {
    for (const [name, spec] of Object.entries(EVENTS)) {
      expect(spec.doc.trim(), name).not.toBe("");
      for (const [path, field] of allFields(spec.fields)) {
        expect(field.doc.trim(), `${name}.${path}`).not.toBe("");
        const words = field.values ?? field.keys;
        if (words !== undefined) {
          expect(words.length, `${name}.${path}`).toBeGreaterThan(0);
          expect(new Set(words).size, `${name}.${path}`).toBe(words.length);
        }
      }
    }
  });

  it("pairs every model field with a required sibling provider field", () => {
    let models = 0;
    for (const spec of Object.values(EVENTS)) {
      for (const [path, field, siblings] of allFields(spec.fields)) {
        if (field.type !== "model") continue;
        models += 1;
        const provider = siblings[field.provider ?? ""];
        expect(provider?.type, path).toBe("provider");
        expect(provider?.optional, path).toBeUndefined();
      }
    }
    expect(models).toBe(2);
  });

  it("names events and features in one style", () => {
    for (const name of EVENT_NAMES) expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    for (const feature of FEATURE_IDS) expect(feature).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(new Set(FEATURE_IDS).size).toBe(FEATURE_IDS.length);
  });

  it("is frozen, so a cast cannot widen what the serializer accepts", () => {
    expect(Object.isFrozen(TELEMETRY_EVENTS)).toBe(true);
    expect(Object.isFrozen(TELEMETRY_EVENTS.feature_used.fields.feature.values)).toBe(true);
    expect(Object.isFrozen(REPORTABLE_ERROR_CODES)).toBe(true);
  });

  it("does not carry the retired authority-denial vocabulary", () => {
    expect(JSON.stringify([TELEMETRY_EVENTS, REPORTABLE_ERROR_CODES])).not.toMatch(
      /authority|denial/i,
    );
  });
});

describe("ISO region codes", () => {
  it("are the 249 assigned ISO 3166-1 alpha-2 codes, sorted and unique", () => {
    expect(ISO_REGION_CODES).toHaveLength(249);
    expect(new Set(ISO_REGION_CODES).size).toBe(249);
    expect([...ISO_REGION_CODES]).toEqual([...ISO_REGION_CODES].toSorted());
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (const code of ISO_REGION_CODES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(names.of(code), code).not.toBe(code);
    }
  });

  it("narrow what the OS reports", () => {
    expect(isoRegionCode("CA")).toBe("CA");
    expect(isoRegionCode(" gb ")).toBe("GB");
    expect(isoRegionCode("")).toBeUndefined();
    expect(isoRegionCode("XK")).toBeUndefined();
    expect(isoRegionCode("419")).toBeUndefined();
    expect(isoRegionCode(undefined)).toBeUndefined();
  });
});

// ── Catalog ──────────────────────────────────────────────────────────────────

describe("telemetryModelCatalog", () => {
  it("copies its source, so a later change cannot widen it", () => {
    const source = new Map([["anthropic", new Set(["claude-sonnet-4-5"])]]);
    const catalog = telemetryModelCatalog(source);
    source.get("anthropic")?.add("acme-internal-llm");
    source.set("acme", new Set(["x"]));
    expect(catalogModelRef(catalog, "anthropic", "acme-internal-llm").model).toBe("custom");
    expect(catalogModelRef(catalog, "acme", "x").provider).toBe("custom");
  });

  it("leaves out ids outside the id shape, and any named custom", () => {
    const catalog = telemetryModelCatalog([
      ["has space", ["m"]],
      ["custom", ["m"]],
      ["anthropic", ["has space", "custom", "ok"]],
    ]);
    expect([...catalog.keys()]).toEqual(["anthropic"]);
    expect([...(catalog.get("anthropic") ?? [])]).toEqual(["ok"]);
  });

  it("merges a provider listed twice", () => {
    const catalog = telemetryModelCatalog([
      ["anthropic", ["a"]],
      ["anthropic", ["b"]],
    ]);
    expect([...(catalog.get("anthropic") ?? [])]).toEqual(["a", "b"]);
  });
});

describe("catalogModelRef", () => {
  it("speaks a catalog provider and model", () => {
    expect(catalogModelRef(CATALOG, "anthropic", "claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(catalogModelRef(CATALOG, "openrouter", "anthropic/claude-opus-4.1").model).toBe(
      "anthropic/claude-opus-4.1",
    );
  });

  it("reports a model added under a built-in provider as custom", () => {
    expect(catalogModelRef(CATALOG, "anthropic", "acme-internal-llm")).toEqual({
      provider: "anthropic",
      model: "custom",
    });
  });

  it("reports a custom provider's model as custom, whatever it is called", () => {
    expect(catalogModelRef(CATALOG, "acme", "claude-sonnet-4-5")).toEqual({
      provider: "custom",
      model: "custom",
    });
  });

  it("refuses inputs outside the id shape", () => {
    expect(catalogModelRef(CATALOG, "x".repeat(200), "m").provider).toBe("custom");
    expect(catalogModelRef(CATALOG, undefined, 3)).toEqual({ provider: "custom", model: "custom" });
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

  it("names each value it falls back to once", () => {
    expect(CUSTOM_CATALOG_ID).toBe("custom");
    expect(UNKNOWN_VERSION).toBe("unknown");
  });
});
