import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getUntypedClient } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import {
  expectHostError,
  ipcContractLink,
  recordSubscription,
  webSocketContractLink,
} from "@volli/host-protocol/testing";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  captureCanaryRecording,
  checkNextHost,
  DEFAULT_CANARY_PEER,
  createRecordedPeerRouter,
  loadCanaryPeer,
  replayCanaryPeer,
  recordingExchanges,
  peerInput,
  validateExchange,
  validateFrozen,
  type CanaryPeerBundle,
} from "./canary-peer.test-support";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const provenance = { tag: "v0.3.0-canary.1", commit: "a".repeat(40), distributed: true };
function testBundle(): CanaryPeerBundle {
  const output = {
    type: "object",
    properties: { releasedField: { type: "string" } },
    required: ["releasedField"],
    additionalProperties: false,
  };
  return {
    format: "volli-canary-peer-v1",
    provenance: { ...provenance },
    schema: {
      protocolVersion: 1,
      tiers: {
        public: {
          "session.projection": {
            kind: "query",
            input: {
              type: "object",
              properties: { sessionId: { type: "string" } },
              required: ["sessionId"],
              additionalProperties: false,
            },
            output,
            noInput: false,
            voidOutput: false,
          },
        },
      },
    },
    recordings: Object.fromEntries(
      ["ipc", "websocket"].map((transport) => [
        `session-${transport}`,
        {
          provenance: { ...provenance, how: "test-bundle distinct released field" },
          transport: transport as "ipc" | "websocket",
          recording: [
            {
              procedure: "session.projection",
              input: { sessionId: "recorded" },
              output: { releasedField: "from-the-tag" },
            },
          ],
          exchanges: [
            {
              procedure: "session.projection",
              input: { sessionId: "recorded" },
              output: { releasedField: "from-the-tag" },
            },
          ],
        },
      ]),
    ),
    followups: [],
  };
}

describe("recorded release peer selection", () => {
  it("selects the env bundle rather than the reconstructed peer; missing or malformed explicit bundles fail", () => {
    const directory = mkdtempSync(join(process.cwd(), ".canary-peer-test-"));
    const before = process.env.VOLLI_CANARY_PEER_BUNDLE;
    try {
      const path = join(directory, "peer.json");
      process.env.VOLLI_CANARY_PEER_BUNDLE = path;
      expect(() => loadCanaryPeer()).toThrow();
      writeFileSync(path, "{");
      expect(() => loadCanaryPeer()).toThrow();
      writeFileSync(path, JSON.stringify(testBundle()));
      expect(loadCanaryPeer()).toEqual(testBundle());
      const bad = testBundle();
      bad.recordings["session-ipc"].provenance.commit = "b".repeat(40);
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadCanaryPeer()).toThrow(/provenance/);
      const privateTier = {
        ...testBundle(),
        schema: { ...testBundle().schema, tiers: { ...testBundle().schema.tiers, desktop: {} } },
      };
      writeFileSync(path, JSON.stringify(privateTier));
      expect(() => loadCanaryPeer()).toThrow(/Malformed/);
    } finally {
      if (before === undefined) delete process.env.VOLLI_CANARY_PEER_BUNDLE;
      else process.env.VOLLI_CANARY_PEER_BUNDLE = before;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts recorded beta and RC peers as well as canaries", () => {
    withFile((path) => {
      for (const tag of ["v0.3.0-beta.1", "v0.3.0-rc.2"]) {
        const bundle = testBundle();
        bundle.provenance = { ...bundle.provenance, tag };
        for (const recording of Object.values(bundle.recordings)) recording.provenance.tag = tag;
        writeFileSync(path, JSON.stringify(bundle));
        expect(loadCanaryPeer(path)).toEqual(bundle);
      }
    });
  });

  for (const transport of ["ipc", "websocket"] as const) {
    it(`both skew directions over real ${transport}, with independent release output validation`, async () => {
      const bundle = testBundle();
      const rpc = initTRPC.create();
      // The next host has its own implementation; no recording feeds its answer.
      const nextRouter = rpc.router({
        session: rpc.router({
          projection: rpc.procedure
            .input({ parse: (value: unknown) => value })
            .query(() => ({ releasedField: "from-the-tag", newField: true })),
        }),
      });
      const link =
        transport === "ipc"
          ? ipcContractLink({ router: nextRouter, createContext: () => ({}) })
          : webSocketContractLink({ router: nextRouter, createContext: () => ({}) });
      const connection = await link.open(null);
      const name = `session-${transport}`;
      try {
        const output = await getUntypedClient(connection.client).query("session.projection", {
          sessionId: "recorded",
        });
        checkNextHost(bundle, name, [
          { procedure: "session.projection", input: { sessionId: "recorded" }, output },
        ]);
        expect(() =>
          validateFrozen(bundle.schema.tiers.public["session.projection"].output, {
            currentField: "not a released field",
          }),
        ).toThrow();
      } finally {
        await connection.close();
      }
      await replayCanaryPeer(bundle, name, {
        "session.projection": {
          output: {
            parse(value) {
              expect(value).toEqual({ releasedField: "from-the-tag" });
              return value;
            },
          },
        },
      });
      // Proof the old host is independently built, not today's live router.
      const frozen = createRecordedPeerRouter(bundle, bundle.recordings[name]);
      expect(frozen).not.toBe(nextRouter);
    });
  }

  it("matches recorded requests independent of a new input parser's property order", async () => {
    const bundle = testBundle();
    bundle.schema.tiers.public["session.projection"].input.properties = {
      sessionId: { type: "string" },
      afterSequence: { type: "integer" },
    };
    for (const transport of ["ipc", "websocket"] as const) {
      const name = `session-${transport}`;
      bundle.recordings[name].exchanges[0].input = { sessionId: "recorded", afterSequence: 4 };
      await replayCanaryPeer(bundle, name, {
        "session.projection": {
          input: { parse: () => ({ afterSequence: 4, sessionId: "recorded" }) },
          output: { parse: (value) => value },
        },
      });
    }
  });

  it("frozen validators resolve refs and reject removed fields, narrowed types and unknown assertion keywords", () => {
    const schema = {
      type: "object",
      properties: { value: { $ref: "#/$defs/value" } },
      required: ["value"],
      $defs: { value: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] } },
    };
    expect(() => validateFrozen(schema, { value: 2, newField: true })).not.toThrow();
    for (const value of [{}, { value: -1 }, { value: "2" }])
      expect(() => validateFrozen(schema, value)).toThrow();
    expect(() => validateFrozen({ unsupportedConstraint: true }, 1)).toThrow(/Unsupported/);
  });
});

function withFile(run: (path: string) => void) {
  const directory = mkdtempSync(join(process.cwd(), ".canary-peer-test-"));
  try {
    run(join(directory, "peer.json"));
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
}

const variant = (tag: string | string[]) => ({
  type: "object",
  properties: {
    kind: Array.isArray(tag) ? { enum: tag, type: "string" } : { const: tag, type: "string" },
    severity: { enum: ["low", "high"], type: "string" },
  },
  required: ["kind", "severity"],
  additionalProperties: false,
});

describe("frozen consumer grammar", () => {
  for (const union of ["oneOf", "anyOf"]) {
    it(`${union}: only output unknown open discriminators are tolerated`, () => {
      const branches = [variant("known"), variant(["other", "alias"])];
      const schema = { [union]: branches, "x-volli-open-union": "kind" };
      validateFrozen(schema, { kind: "future", arbitrary: {} });
      validateFrozen(schema, { kind: "known", severity: "low", extra: true });
      validateFrozen(schema, { kind: "alias", severity: "high" });
      for (const value of [
        null,
        [],
        {},
        { kind: 1 },
        { kind: {} },
        { kind: "known" },
        { kind: "known", severity: "future" },
      ])
        expect(() => validateFrozen(schema, value)).toThrow();
      expect(() => validateFrozen(schema, { kind: "future" }, schema, false)).toThrow();
      expect(() => validateFrozen({ [union]: branches }, { kind: "future" })).toThrow();
      expect(() =>
        validateFrozen(schema, { kind: "known", severity: "low", extra: true }, schema, false),
      ).toThrow();
    });
  }
  it("open scalar enums retain their types, bounds, reference-local metadata and input strictness", () => {
    for (const [values, future, wrong] of [
      [["a"], "b", 1],
      [[1], 2, "2"],
      [[true], false, "false"],
    ] as const) {
      const schema = { enum: values, "x-volli-open-enum": true };
      validateFrozen(schema, values[0]);
      validateFrozen(schema, future);
      const singleton = { const: values[0], "x-volli-open-enum": true };
      validateFrozen(singleton, future);
      expect(() => validateFrozen({ const: values[0] }, future)).toThrow();
      expect(() => validateFrozen(singleton, future, singleton, false)).toThrow();
      for (const value of [wrong, null, {}, []])
        expect(() => validateFrozen(schema, value)).toThrow();
      expect(() => validateFrozen(schema, future, schema, false)).toThrow();
      expect(() => validateFrozen({ enum: values }, future)).toThrow();
    }
    const root = { $defs: { e: { type: "string", enum: ["a"], maxLength: 1 } } };
    validateFrozen({ $ref: "#/$defs/e", "x-volli-open-enum": true }, "b", root);
    expect(() => validateFrozen({ $ref: "#/$defs/e" }, "b", root)).toThrow();
    expect(() => validateFrozen({ $ref: "#/$defs/e", maxLength: 10 }, "aa", root)).toThrow();
    expect(() => validateFrozen({ enum: [null], "x-volli-open-enum": true }, "b")).toThrow();
    expect(() => validateFrozen({ const: null, "x-volli-open-enum": true }, {})).toThrow();
    expect(() =>
      validateFrozen({ $ref: "#/$defs/e", "x-volli-open-enum": true }, "long", root),
    ).toThrow();
    expect(() =>
      validateFrozen(
        { anyOf: [{ enum: ["a"] }, { type: "null" }], "x-volli-open-enum": true },
        "b",
      ),
    ).toThrow();
    expect(() =>
      validateFrozen({ oneOf: [{ type: "string" }, { type: "string" }] }, "a"),
    ).toThrow();
  });
  it("covers the generator's closed assertions and ignored annotations", () => {
    validateFrozen(
      { readOnly: true, $schema: "test", title: "T", description: "D", default: 1, examples: [1] },
      1,
    );
    validateFrozen({ $ref: "#/$defs/a~1b~0c", $defs: { "a/b~c": { type: "integer" } } }, 1);
    for (const ref of [1, "remote", "#/missing", "#/missing/child", "#/$defs/scalar"])
      expect(() => validateFrozen({ $ref: ref, $defs: { scalar: 1 } }, 1)).toThrow();
    validateFrozen({ type: ["string", "null"] }, null);
    validateFrozen({ type: "array", items: { type: "number" }, minItems: 1, maxItems: 2 }, [1]);
    validateFrozen({ type: "array" }, []);
    for (const value of [[], [1, 2, 3], ["a"]])
      expect(() =>
        validateFrozen(
          { type: "array", items: { type: "number" }, minItems: 1, maxItems: 2 },
          value,
        ),
      ).toThrow();
    for (const [schema, valid, invalid] of [
      [{ type: "number", maximum: 2 }, 2, 3],
      [{ type: "number", exclusiveMinimum: 0 }, 1, 0],
      [{ type: "number", exclusiveMaximum: 2 }, 1, 2],
      [{ type: "string", minLength: 2 }, "ab", "a"],
      [{ type: "string", maxLength: 2 }, "ab", "abc"],
      [{ type: "string", pattern: "^a$" }, "a", "b"],
      [{ type: "string", format: "uuid" }, "0f8fad5b-d9cb-469f-a165-70867728950e", "no"],
      [{ type: "boolean" }, true, 1],
    ] as const) {
      validateFrozen(schema, valid);
      expect(() => validateFrozen(schema, invalid)).toThrow();
    }
    expect(() => validateFrozen({}, Infinity)).toThrow();
    expect(() => validateFrozen({ format: "date" }, "x")).toThrow(/Unsupported frozen format/);
    validateFrozen(
      {
        type: "object",
        propertyNames: { pattern: "^a" },
        additionalProperties: { type: "number" },
      },
      { a: 1 },
    );
    expect(() => validateFrozen({ propertyNames: { pattern: "^a" } }, { b: 1 })).toThrow();
    expect(() =>
      validateFrozen({ additionalProperties: { type: "number" } }, { a: "x" }),
    ).toThrow();
    validateFrozen({ additionalProperties: true }, { a: 1 }, undefined, false);
  });
});

describe("recording normalization and fresh response checks", () => {
  it("splits board initial/resumed frames exactly as the observer receives them", () => {
    const first = { id: "one", data: { kind: "created" } };
    const second = { id: "two", data: { kind: "updated" } };
    expect(
      recordingExchanges({
        subscription: {
          procedure: "board.changes",
          input: { lastEventId: "zero" },
          resumedInput: { lastEventId: "one" },
          frames: [first, second],
          write: { procedure: "board.write", input: {}, output: null },
        },
      }),
    ).toEqual([
      { procedure: "board.changes", input: { lastEventId: "zero" }, frames: [first] },
      { procedure: "board.changes", input: { lastEventId: "one" }, frames: [second] },
      { procedure: "board.write", input: {}, output: null },
    ]);
  });
  it("normalizes errors, retries, sign-in streams and skips non-exchanges", () => {
    const error = { code: "NOT_FOUND", message: "gone" };
    expect(
      recordingExchanges([
        null,
        1,
        {
          procedure: "write",
          input: [1, { a: true }],
          output: 1,
          retryOutput: 2,
        },
        { procedure: "read", input: null, error },
        {
          start: { procedure: "signIns.start", input: {}, output: { flowId: "flow" } },
          frames: [1],
        },
        { start: { procedure: "other", output: {} }, frames: [] },
        {
          start: { procedure: "signIns.start", output: {} },
          frames: [],
        },
        { procedure: "stream", input: {}, frames: [2] },
      ]),
    ).toEqual([
      { procedure: "write", input: [1, { a: true }], output: 1 },
      { procedure: "write", input: [1, { a: true }], output: 2 },
      { procedure: "read", input: null, error },
      { procedure: "signIns.start", input: {}, output: { flowId: "flow" } },
      { procedure: "signIns.subscribe", input: { flowId: "flow" }, frames: [1] },
      { procedure: "stream", input: {}, frames: [2] },
    ]);
  });
  it("ignores only added output fields, not changed requests, known values, frame IDs/counts or missing outputs", () => {
    const bundle = testBundle();
    const name = "session-ipc";
    const exchange = bundle.recordings[name].exchanges[0];
    exchange.output = { releasedField: "from-the-tag", nested: [{ a: 1 }, null] };
    const fresh = structuredClone(exchange);
    fresh.output = {
      releasedField: "from-the-tag",
      nested: [{ a: 1, extra: true }, null],
      added: true,
    };
    checkNextHost(bundle, name, [fresh]);
    for (const patch of [
      { input: { sessionId: "different" } },
      { input: { sessionId: "recorded", extra: true } },
      { procedure: "other" },
      { output: { releasedField: 1 } },
      { output: { releasedField: "changed" } },
      { output: { releasedField: "from-the-tag", nested: [{ a: 2 }, null] } },
      { output: { releasedField: "from-the-tag", nested: [] } },
      { output: { releasedField: "from-the-tag", nested: {} } },
      { output: { releasedField: "from-the-tag", nested: [null, null] } },
      { output: { releasedField: "from-the-tag", nested: [{}, null] } },
      { error: { code: "NOT_FOUND", message: "oops" } },
    ])
      expect(() => checkNextHost(bundle, name, [{ ...fresh, ...patch }])).toThrow();
    expect(() => checkNextHost(bundle, name, [])).toThrow();
    expect(() =>
      checkNextHost(bundle, name, [{ procedure: fresh.procedure, input: fresh.input, frames: [] }]),
    ).toThrow();
    expect(() => checkNextHost(bundle, "missing", [])).toThrow(/lacks required recording/);
    bundle.schema.tiers.public[exchange.procedure].kind = "subscription";
    delete exchange.output;
    exchange.frames = [{ id: "1", data: { releasedField: "from-the-tag" } }];
    checkNextHost(bundle, name, [
      {
        ...exchange,
        frames: [{ id: "1", data: { releasedField: "from-the-tag", newField: true } }],
      },
    ]);
    expect(() =>
      checkNextHost(bundle, name, [
        { ...exchange, frames: [{ id: "2", data: { releasedField: "from-the-tag" } }] },
      ]),
    ).toThrow();
    expect(() => checkNextHost(bundle, name, [{ ...exchange, frames: [] }])).toThrow();
  });
  it("validates exchange errors, untracked frames, void outputs and no-input calls", () => {
    const bundle = testBundle();
    const exchange = bundle.recordings["session-ipc"].exchanges[0];
    expect(() => validateExchange(bundle, { ...exchange, procedure: "unknown" })).toThrow(
      /Missing frozen schema/,
    );
    for (const error of [
      { code: "", message: "x" },
      { code: "X", message: "" },
    ])
      expect(() => validateExchange(bundle, { ...exchange, error })).toThrow(
        /Malformed recorded error/,
      );
    validateExchange(bundle, { ...exchange, error: { code: "X", message: "x" } });
    const schema = bundle.schema.tiers.public[exchange.procedure];
    schema.kind = "subscription";
    expect(() => validateExchange(bundle, exchange)).toThrow(
      /Missing recorded subscription frames/,
    );
    validateExchange(bundle, { ...exchange, frames: [{ releasedField: "plain" }] });
    schema.kind = "mutation";
    schema.noInput = true;
    schema.voidOutput = true;
    validateExchange(bundle, { procedure: exchange.procedure, input: undefined });
  });
});

describe("bundle persistence and frozen request selection", () => {
  it("bootstraps only an absent default, and fails on present malformed defaults", () =>
    withFile((path) => {
      vi.stubEnv("VOLLI_CANARY_PEER_BUNDLE", "");
      // Mock only filesystem reads; never touch the shared default artifact.
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      expect(loadCanaryPeer("")).toBeNull();
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const read = vi.spyOn(fs, "readFileSync");
      read.mockImplementationOnce((target) => {
        expect(target).toBe(DEFAULT_CANARY_PEER);
        return "{";
      });
      expect(() => loadCanaryPeer("")).toThrow();
      read.mockReturnValueOnce(JSON.stringify({ format: "bad" }));
      expect(() => loadCanaryPeer("")).toThrow(/Malformed/);
      read.mockReturnValueOnce(JSON.stringify(testBundle()));
      expect(loadCanaryPeer("")).toEqual(testBundle());
      writeFileSync(path, JSON.stringify(testBundle()));
      expect(loadCanaryPeer(path)).toEqual(testBundle());
    }));
  it("rejects invalid bundle and recording metadata without silently bootstrapping", () =>
    withFile((path) => {
      const checks: Array<(b: CanaryPeerBundle) => void> = [
        (b) => {
          b.format = "bad" as CanaryPeerBundle["format"];
        },
        (b) => {
          b.provenance.tag = "";
        },
        (b) => {
          b.provenance.commit = "bad";
        },
        (b) => {
          b.provenance.distributed = null as unknown as boolean;
        },
        (b) => {
          b.schema = null as unknown as CanaryPeerBundle["schema"];
        },
        (b) => {
          b.schema.protocolVersion = 2;
        },
        (b) => {
          b.provenance.tag = "not-canary";
        },
        (b) => {
          b.provenance.distributed = false;
        },
        (b) => {
          b.recordings = null as unknown as CanaryPeerBundle["recordings"];
        },
        (b) => {
          b.followups = null as unknown as string[];
        },
        (b) => {
          b.recordings["session-ipc"].provenance.how = "";
        },
        (b) => {
          b.recordings["session-ipc"].provenance.tag = "other";
        },
        (b) => {
          b.recordings["session-ipc"].provenance.distributed = false;
        },
        (b) => {
          b.recordings["session-ipc"].transport = "other" as "ipc";
        },
        (b) => {
          b.recordings["session-ipc"].exchanges = null as unknown as [];
        },
        (b) => {
          b.recordings["session-ipc"].exchanges = [];
        },
        (b) => {
          b.recordings["session-ipc"].exchanges[0].procedure = "unknown";
        },
        (b) => {
          b.schema.tiers.public["session.projection"].kind = "bad" as "query";
        },
        (b) => {
          b.schema.tiers.public["session.projection"].input = null as unknown as {};
        },
        (b) => {
          b.schema.tiers.public["session.projection"].output = null as unknown as {};
        },
        (b) => {
          b.schema.tiers.public["session.projection"].noInput = null as unknown as boolean;
        },
        (b) => {
          b.schema.tiers.public["session.projection"].voidOutput = null as unknown as boolean;
        },
      ];
      for (const check of checks) {
        const bundle = testBundle();
        check(bundle);
        writeFileSync(path, JSON.stringify(bundle));
        expect(() => loadCanaryPeer(path)).toThrow();
      }
      const dry = testBundle();
      dry.provenance = {
        ...dry.provenance,
        distributed: false,
        tag: `dry-run-${provenance.commit}`,
      };
      for (const recording of Object.values(dry.recordings))
        recording.provenance = { ...recording.provenance, ...dry.provenance };
      writeFileSync(path, JSON.stringify(dry));
      expect(loadCanaryPeer(path)).toEqual(dry);
    }));
  it("captures validated actual data only when enabled", () =>
    withFile((path) => {
      vi.stubEnv("VOLLI_CANARY_CAPTURE_DIR", "");
      captureCanaryRecording("none", "ipc", {}, []);
      vi.stubEnv("VOLLI_CANARY_CAPTURE_DIR", join(path, ".."));
      const exchanges = [
        {
          procedure: "protocol.welcome",
          input: undefined,
          error: { code: "NOT_FOUND", message: "test" },
        },
      ];
      captureCanaryRecording("captured", "ipc", { native: true }, exchanges);
      expect(JSON.parse(readFileSync(join(path, "..", "captured.json"), "utf8"))).toEqual({
        transport: "ipc",
        recording: { native: true },
        exchanges: [
          { procedure: "protocol.welcome", error: { code: "NOT_FOUND", message: "test" } },
        ],
      });
      expect(() =>
        captureCanaryRecording("bad", "ipc", {}, [{ procedure: "unknown", input: {} }]),
      ).toThrow();
    }));
  it("returns cloned frozen requests, falls back only with no selected peer", () => {
    const fallback = { sessionId: "fallback" };
    expect(peerInput(null, "x", "x", fallback)).toBe(fallback);
    const bundle = testBundle();
    const selected = peerInput(bundle, "session-ipc", "session.projection", fallback);
    expect(selected).toEqual({ sessionId: "recorded" });
    selected.sessionId = "changed";
    expect(bundle.recordings["session-ipc"].exchanges[0].input).toEqual({ sessionId: "recorded" });
    expect(() => peerInput(bundle, "missing", "x", fallback)).toThrow(/lacks request/);
    expect(() => peerInput(bundle, "session-ipc", "session.projection", fallback, 1)).toThrow();
  });
});

describe("release playback router", () => {
  function playbackBundle(transport: "ipc" | "websocket") {
    const bundle = testBundle();
    const schema = {
      kind: "mutation" as const,
      input: {},
      output: {},
      noInput: false,
      voidOutput: false,
    };
    bundle.schema.tiers.public = {
      "commands.run": schema,
      plain: { ...schema, kind: "query", noInput: true },
      "events.subscribe": { ...schema, kind: "subscription" },
      "events.empty": { ...schema, kind: "subscription" },
    };
    bundle.recordings.playback = {
      provenance: { ...provenance, how: "test playback" },
      transport,
      recording: null,
      exchanges: [
        { procedure: "commands.run", input: [1, { a: true }], output: { step: 1 } },
        { procedure: "commands.run", input: [1, { a: true }], output: { step: 2 } },
        {
          procedure: "commands.run",
          input: { fail: 1 },
          error: { code: "NOT_FOUND", message: "missing", reason: "workspace-unknown" },
        },
        {
          procedure: "commands.run",
          input: { fail: 2 },
          error: { code: "NOT_FOUND", message: "missing" },
        },
        { procedure: "plain", input: null, output: null },
        {
          procedure: "events.subscribe",
          input: {},
          frames: [null, { plain: true }, { id: "id", data: { tracked: true } }],
        },
        { procedure: "events.empty", input: {}, frames: [] },
      ],
    };
    return bundle;
  }
  for (const transport of ["ipc", "websocket"] as const) {
    it(`replays mutations, failures, no-input queries and both frame forms over ${transport}`, async () => {
      const bundle = playbackBundle(transport);
      await replayCanaryPeer(bundle, "playback", {
        "commands.run": { input: { parse: (value) => value }, output: { parse: (value) => value } },
        plain: {
          output: {
            parse: () => {
              throw new Error("void output is never decoded");
            },
          },
          voidOutput: true,
        },
        "events.subscribe": { output: { parse: (value) => value } },
        "events.empty": { output: { parse: (value) => value } },
      });
      const router = createRecordedPeerRouter(bundle, bundle.recordings.playback);
      const link =
        transport === "ipc"
          ? ipcContractLink({ router, createContext: () => ({}) })
          : webSocketContractLink({ router, createContext: () => ({}) });
      const connection = await link.open(null);
      const client = getUntypedClient(connection.client);
      try {
        expect(await client.mutation("commands.run", [1, { a: true }])).toEqual({ step: 1 });
        expect(await client.mutation("commands.run", [1, { a: true }])).toEqual({ step: 2 });
        expect(await client.mutation("commands.run", [1, { a: true }])).toEqual({ step: 2 });
        expect(
          await expectHostError(client.mutation("commands.run", { notRecorded: true })),
        ).toMatchObject({ code: "BAD_REQUEST" });
        const stream = recordSubscription<unknown>((handlers) =>
          client.subscription("events.empty", {}, handlers),
        );
        await stream.started;
        stream.unsubscribe();
      } finally {
        await connection.close();
      }
    });
  }
  it("finishes an already-aborted subscription even when no frames were recorded", async () => {
    const bundle = playbackBundle("ipc");
    delete bundle.recordings.playback.exchanges.at(-1)!.frames;
    const router = createRecordedPeerRouter(bundle, bundle.recordings.playback);
    const caller = router.createCaller({}, { signal: AbortSignal.abort() });
    const stream = await (
      caller["events.empty"] as (input: unknown) => Promise<AsyncIterable<unknown>>
    )({});
    const frames = [];
    for await (const frame of stream) frames.push(frame);
    expect(frames).toEqual([]);
  });
  it("fails missing peers and changed new-client input decoding, and closes connections on decoder failure", async () => {
    const bundle = testBundle();
    await expect(replayCanaryPeer(bundle, "missing", {})).rejects.toThrow(
      /lacks required recording/,
    );
    await expect(
      replayCanaryPeer(bundle, "session-ipc", {
        "session.projection": {
          input: { parse: () => ({ sessionId: "changed" }) },
          output: { parse: (value) => value },
        },
      }),
    ).rejects.toThrow();
    const streamBundle = playbackBundle("ipc");
    await expect(
      replayCanaryPeer(streamBundle, "playback", {
        "commands.run": { output: { parse: (value) => value } },
        plain: { output: { parse: (value) => value } },
        "events.subscribe": {
          output: {
            parse: () => {
              throw new Error("decoder failed");
            },
          },
        },
      }),
    ).rejects.toThrow("decoder failed");
  });
});
