import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "vite-plus";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { sanitizeMcpToolDefinition, type McpJsonObject } from "./mcp";
import { DEFAULT_CODE_MODE_LIMITS } from "./code-mode";
import {
  assertSessionEvent,
  encodeSessionJson,
  parseRendererSessionEvent,
  decodeSessionEventPayload,
  scrubSessionEvent,
} from "./session-event-codec";
import type { SessionEvent } from "./session-ledger";

let browserBundle: string;

beforeAll(async () => {
  const bundled = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./session-event-codec.ts", import.meta.url)),
        name: "RendererCodec",
        formats: ["iife"],
      },
    },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  if (output === undefined || !("output" in output)) throw new Error("Missing browser bundle");
  const chunk = output.output.find((entry) => entry.type === "chunk");
  if (chunk === undefined) throw new Error("Missing browser chunk");
  browserBundle = chunk.code;
});

function shippedEvent(dialect?: string, withOutput = false): SessionEvent {
  const sanitized = sanitizeMcpToolDefinition({
    serverId: "paper",
    serverName: "Paper",
    toolName: "get_document",
    description: "Read a Paper document",
    inputSchema: {
      ...(dialect === undefined ? {} : { $schema: dialect }),
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    ...(withOutput
      ? { outputSchema: { type: "object", properties: { title: { type: "string" } } } }
      : {}),
  });
  if (!sanitized.ok) throw new Error(sanitized.reason);
  const definition = { ...sanitized.definition, parallelRead: true as const };
  const event: SessionEvent = {
    id: "event-1",
    sessionId: "session-1",
    sequence: 1,
    occurredAt: 100,
    recordedAt: 100,
    provenance: { source: { kind: "system", id: "session-runtime", detail: null }, venue: null },
    payload: {
      kind: "session.input.recorded",
      input: {
        kind: "tool-surface",
        tools: ["read", definition.providerName],
        mcpTools: [definition],
      },
    },
  };
  // Discovery and durable validation execute on the host, before the wire scrub.
  assertSessionEvent(event, "event");
  return event;
}

function parseUnderCsp(event: SessionEvent): unknown {
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  runInContext(browserBundle, context);
  // Prove the VM really enforces the renderer's no-unsafe-eval policy.
  expect(() => runInContext('new Function("return 1")()', context)).toThrow();
  context.frameJson = encodeSessionJson(scrubSessionEvent(event));
  return runInContext(
    'RendererCodec.parseRendererSessionEvent(JSON.parse(frameJson), "frame.event")',
    context,
  );
}

describe("renderer Session input under CSP", () => {
  it.each([
    undefined,
    "",
    ...[
      "core",
      "applicator",
      "validation",
      "unevaluated",
      "format-annotation",
      "content",
      "meta-data",
    ].map((meta) => `https://json-schema.org/draft/2020-12/meta/${meta}`),
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ])("keeps the host-validated MCP tool-surface frame (%s)", (dialect) => {
    const event = shippedEvent(dialect);
    expect(parseUnderCsp(event)).toEqual({ ok: true, event: scrubSessionEvent(event) });
  });

  it.each<McpJsonObject>([
    { additionalProperties: false },
    {
      properties: { pair: { type: "array", items: [{ type: "string" }], additionalItems: false } },
    },
    { dependencies: { id: ["title"] } },
  ])("keeps previously frozen schemas that fresh discovery now rejects (%j)", (body) => {
    const event = shippedEvent();
    if (
      event.payload.kind !== "session.input.recorded" ||
      event.payload.input.kind !== "tool-surface"
    ) {
      throw new Error("Missing tool surface");
    }
    const inputSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      ...body,
    };
    const definition = { ...event.payload.input.mcpTools![0]!, inputSchema };
    expect(sanitizeMcpToolDefinition({ ...definition, serverName: "Paper" }).ok).toBe(false);
    event.payload.input = { ...event.payload.input, mcpTools: [definition] };
    // Existing records are decoded by the host before the renderer sees them.
    const decoded = decodeSessionEventPayload(
      JSON.parse(encodeSessionJson(event.payload)),
      "payload",
    );
    expect(decoded).toEqual(event.payload);
    assertSessionEvent(event, "event");
    expect(parseUnderCsp({ ...event, payload: decoded })).toEqual({
      ok: true,
      event: scrubSessionEvent(event),
    });
  });

  it("keeps frozen output schemas and parallel-read eligibility", () => {
    const event = shippedEvent(undefined, true);
    expect(parseUnderCsp(event)).toEqual({ ok: true, event: scrubSessionEvent(event) });
  });

  it("keeps Code Mode routes beside the frozen MCP tools", () => {
    const event = shippedEvent();
    if (
      event.payload.kind !== "session.input.recorded" ||
      event.payload.input.kind !== "tool-surface"
    ) {
      throw new Error("Missing tool surface");
    }
    const input = event.payload.input;
    event.payload.input = {
      ...input,
      tools: [...input.tools, "codemode"],
      codeMode: {
        routes: Object.fromEntries(input.tools.map((name) => [name, "code" as const])),
        limits: DEFAULT_CODE_MODE_LIMITS,
      },
    };
    assertSessionEvent(event, "event");
    expect(parseUnderCsp(event)).toEqual({ ok: true, event: scrubSessionEvent(event) });
  });
});

function rendererFrame(
  definitionOverrides: Record<string, unknown> = {},
  inputOverrides: Record<string, unknown> = {},
) {
  const event = shippedEvent(undefined, true);
  if (
    event.payload.kind !== "session.input.recorded" ||
    event.payload.input.kind !== "tool-surface"
  ) {
    throw new Error("Missing tool surface");
  }
  return {
    ...event,
    payload: {
      kind: "session.input.recorded",
      input: {
        ...event.payload.input,
        mcpTools: [{ ...event.payload.input.mcpTools![0], ...definitionOverrides }],
        ...inputOverrides,
      },
    },
  };
}

describe("renderer MCP wire shape", () => {
  it("preserves frozen definitions, with or without optional fields", () => {
    for (const withOutput of [false, true]) {
      const event = shippedEvent(undefined, withOutput);
      expect(parseRendererSessionEvent(event, "frame.event")).toEqual({ ok: true, event });
    }
    const legacy = rendererFrame({ outputSchema: undefined, parallelRead: undefined });
    const parsed = parseRendererSessionEvent(legacy, "frame.event");
    expect(parsed).toEqual({ ok: true, event: JSON.parse(JSON.stringify(legacy)) });
  });

  it.each([
    ["serverId", 1],
    ["toolName", null],
    ["description", false],
    ["providerName", 1],
    ["providerName", "mcp__not valid"],
    ["parallelRead", false],
    ["inputSchema", null],
    ["inputSchema", []],
    ["inputSchema", { property: undefined }],
    ["outputSchema", true],
  ])("rejects a malformed %s (%j)", (key, value) => {
    expect(parseRendererSessionEvent(rendererFrame({ [key]: value }), "frame.event")).toMatchObject(
      {
        ok: false,
        reason: "malformed",
      },
    );
  });

  it.each([
    { mcpTools: {} },
    { mcpTools: [null] },
    { mcpTools: [] },
    { tools: ["read"] },
    { tools: ["read", "unsupported"] },
    { mcpManagementNames: "unknown" },
  ])("rejects malformed containers or surface mismatches (%j)", (input) => {
    expect(parseRendererSessionEvent(rendererFrame({}, input), "frame.event")).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("leaves JSON Schema semantics to the host, which still rejects damaged schemas", () => {
    // Shape-safe data is presentation-only in the renderer. It cannot cause
    // the host to execute a tool or bypass discovery/durable replay validation.
    const frame = rendererFrame({ inputSchema: { type: "object", allOf: "not an array" } });
    expect(parseRendererSessionEvent(frame, "frame.event").ok).toBe(true);
    expect(() => decodeSessionEventPayload(frame.payload, "payload")).toThrow(
      "input schema must be valid JSON Schema",
    );
    const output = rendererFrame({ outputSchema: { type: "object", allOf: "not an array" } });
    expect(parseRendererSessionEvent(output, "frame.event").ok).toBe(true);
    expect(() => decodeSessionEventPayload(output.payload, "payload")).toThrow(
      "output schema must be valid JSON Schema",
    );
  });
});

it("ships refreshed names under CSP with no MCP declarations or effective surface", () => {
  const birth = shippedEvent("https://json-schema.org/draft/2020-12/schema", true);
  if (
    birth.payload.kind !== "session.input.recorded" ||
    birth.payload.input.kind !== "tool-surface"
  )
    throw new Error("Missing surface");
  const event: SessionEvent = {
    ...birth,
    payload: {
      kind: "session.tools.refreshed",
      trigger: "cold-turn",
      delta: { mcpTools: birth.payload.input.mcpTools },
      added: birth.payload.input.mcpTools!.map((tool) => tool.providerName),
      changed: [],
    },
  };
  assertSessionEvent(event, "event");
  expect(parseUnderCsp(event)).toEqual({ ok: true, event: scrubSessionEvent(event) });
  const safe = JSON.stringify(scrubSessionEvent(event));
  expect(safe).not.toContain("inputSchema");
  expect(safe).not.toContain("description");
  expect(safe).not.toContain("surface");
  expect(safe).toContain(birth.payload.input.mcpTools![0]!.providerName);
});
