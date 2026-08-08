import type { AgentEvent, EditToolDetails } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_ACTIVITY_PAYLOAD_STRING_LENGTH,
  MAX_ACTIVITY_SUMMARY_LENGTH,
  MAX_ACTIVITY_VALUE_ARRAY_LENGTH,
  MAX_ACTIVITY_VALUE_DEPTH,
  MAX_ACTIVITY_VALUE_KEY_LENGTH,
  MAX_ACTIVITY_VALUE_NODE_COUNT,
  MAX_ACTIVITY_VALUE_OBJECT_KEYS,
  MAX_ACTIVITY_VALUE_TOTAL_LENGTH,
  MAX_ACTIVITY_IDENTIFIER_LENGTH,
  mapPiActivity,
} from "./activity";

describe("mapPiActivity", () => {
  it("maps exact Pi read lifecycle shapes and retains settled input context", () => {
    const startedEvent = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: " src/index.ts ", offset: 4, limit: 3 },
    } satisfies Extract<AgentEvent, { type: "tool_execution_start" }>;
    const updatedEvent = {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: " src/index.ts ", offset: 4, limit: 3 },
      partialResult: { content: [{ type: "text", text: "partial" }] },
    } satisfies Extract<AgentEvent, { type: "tool_execution_update" }>;
    const endedEvent = {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "line 4\nline 5\nline 6" }] },
      isError: false,
    } satisfies Extract<AgentEvent, { type: "tool_execution_end" }>;

    const started = mapPiActivity(startedEvent, { observedAt: 100 });
    const progress = mapPiActivity(updatedEvent, { startedAt: 100, observedAt: 120 });
    const completed = mapPiActivity(endedEvent, {
      input: started.input,
      startedAt: 100,
      observedAt: 140,
    });

    expect(started).toMatchObject({
      state: "started",
      input: { path: "src/index.ts", offset: 4, limit: 3 },
      descriptor: {
        subject: { path: "src/index.ts", lineRange: { start: 4, end: 6 } },
        startedAt: 100,
        endedAt: null,
      },
    });
    expect(progress).toMatchObject({
      state: "progress",
      input: { path: "src/index.ts", offset: 4, limit: 3 },
      output: { content: [{ type: "text", text: "partial" }] },
    });
    expect(completed).toMatchObject({
      state: "completed",
      input: { path: "src/index.ts", offset: 4, limit: 3 },
      descriptor: {
        kind: "read-file",
        subject: { path: "src/index.ts", lineRange: { start: 4, end: 6 } },
        startedAt: 100,
        endedAt: 140,
        outcome: { summary: "line 4\nline 5\nline 6" },
      },
    });
  });

  it("retains completed path and command descriptors without inventing end args", () => {
    const details = {
      diff: "- 12 const oldName = true;\n+ 12 const newName = true;",
      patch:
        "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -12 +12 @@\n-const oldName = true;\n+const newName = true;",
      firstChangedLine: 12,
    } satisfies EditToolDetails;
    const editEnd = {
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "Successfully replaced 1 block." }],
        details: { ...details, matchCount: 1, bytes: 4 },
      },
      isError: false,
    } satisfies Extract<AgentEvent, { type: "tool_execution_end" }>;
    const bashEnd = {
      type: "tool_execution_end",
      toolCallId: "call-3",
      toolName: "bash",
      result: { details: { exitCode: 0 } },
      isError: false,
    } satisfies Extract<AgentEvent, { type: "tool_execution_end" }>;

    expect(
      mapPiActivity(editEnd, { input: { path: "src/file.ts" }, startedAt: 300, observedAt: 350 }),
    ).toMatchObject({
      state: "completed",
      input: { path: "src/file.ts" },
      descriptor: {
        kind: "edit-file",
        subject: { path: "src/file.ts" },
        outcome: {
          matchCount: 1,
          bytes: 4,
          addedLines: 1,
          removedLines: 1,
          diff: details.patch,
        },
      },
    });
    expect(
      mapPiActivity(bashEnd, { input: { command: "vp test" }, startedAt: 300, observedAt: 350 }),
    ).toMatchObject({
      state: "completed",
      input: { command: "vp test" },
      descriptor: { kind: "run-command", subject: { label: "vp test" }, outcome: { exitCode: 0 } },
    });
  });

  it("retains useful bounded payloads, while summaries and failures remain diagnostic-sized and redacted", () => {
    const payload = `prefix ${"a".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH + 20)}`;
    const endedEvent = {
      type: "tool_execution_end",
      toolCallId: "call-4",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: `password: hunter2\n${payload}` }],
        details: { patch: `--- a/file\n+++ b/file\n${"+line\n".repeat(80)}` },
      },
      isError: true,
    } satisfies Extract<AgentEvent, { type: "tool_execution_end" }>;

    const activity = mapPiActivity(endedEvent, {
      input: { command: "vp test" },
      startedAt: 400,
      observedAt: 450,
    });
    const text = (activity.output as { content: Array<{ text: string }> }).content[0]?.text;

    expect(text).toMatch(/password: \[redacted\]/);
    expect(text).toHaveLength(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH + 1);
    expect(text?.endsWith("…")).toBe(true);
    expect(activity.descriptor.outcome?.summary).toHaveLength(MAX_ACTIVITY_SUMMARY_LENGTH + 1);
    expect(activity.descriptor.outcome?.summary?.endsWith("…")).toBe(true);
    expect(activity.descriptor.outcome?.addedLines).toBe(80);
    expect(activity.error).toMatch(/password: \[redacted\]/);
    expect(activity.error?.length).toBeLessThanOrEqual(MAX_ACTIVITY_SUMMARY_LENGTH + 1);
    expect(activity.error).not.toContain("a".repeat(24));
  });

  it("bounds normalized values by depth, nodes, object keys, array length, and cycles", () => {
    const tooDeep: { child?: unknown; marker?: string } = {};
    let cursor = tooDeep;
    for (let index = 0; index <= MAX_ACTIVITY_VALUE_DEPTH; index += 1) {
      cursor.child = {};
      cursor = cursor.child as { child?: unknown; marker?: string };
    }
    cursor.marker = "too-deep";

    const tooManyKeys = Object.fromEntries(
      Array.from({ length: MAX_ACTIVITY_VALUE_OBJECT_KEYS + 1 }, (_, index) => [
        `key-${index}`,
        index,
      ]),
    );
    const tooManyItems = Array.from(
      { length: MAX_ACTIVITY_VALUE_ARRAY_LENGTH + 1 },
      (_, index) => index,
    );
    const nodeGroups = Math.ceil(
      (MAX_ACTIVITY_VALUE_NODE_COUNT + 1) / MAX_ACTIVITY_VALUE_ARRAY_LENGTH,
    );
    const tooManyNodes = Array.from({ length: nodeGroups }, (_, group) =>
      Array.from(
        { length: MAX_ACTIVITY_VALUE_ARRAY_LENGTH },
        (_, index) => `node-${group * MAX_ACTIVITY_VALUE_ARRAY_LENGTH + index}`,
      ),
    );
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;

    const event = {
      type: "tool_execution_start",
      toolCallId: "call-5",
      toolName: "extension_tool",
      args: { tooDeep, tooManyKeys, tooManyItems, cycle },
    } satisfies Extract<AgentEvent, { type: "tool_execution_start" }>;
    const activity = mapPiActivity(event, { observedAt: 500 });
    const input = activity.input as {
      tooDeep: unknown;
      tooManyKeys: Record<string, unknown>;
      tooManyItems: unknown[];
      cycle: { self: unknown };
    };

    expect(JSON.stringify(input.tooDeep)).not.toContain("too-deep");
    expect(Object.keys(input.tooManyKeys)).toHaveLength(MAX_ACTIVITY_VALUE_OBJECT_KEYS);
    expect(input.tooManyItems).toHaveLength(MAX_ACTIVITY_VALUE_ARRAY_LENGTH);
    expect(input.cycle.self).toBeNull();

    const nodeActivity = mapPiActivity(
      {
        type: "tool_execution_start",
        toolCallId: "call-6",
        toolName: "extension_tool",
        args: { tooManyNodes },
      },
      { observedAt: 510 },
    );
    expect(JSON.stringify(nodeActivity.input)).toContain("node-0");
    expect(JSON.stringify(nodeActivity.input)).not.toContain(
      `node-${nodeGroups * MAX_ACTIVITY_VALUE_ARRAY_LENGTH - 1}`,
    );
  });

  it("redacts sensitive keys recursively without reading their getter values and redacts authorization strings", () => {
    const nested: { api_token?: string } = {};
    Object.defineProperty(nested, "api_token", {
      enumerable: true,
      get() {
        throw new Error("sensitive getter must not be read");
      },
    });
    const activity = mapPiActivity(
      {
        type: "tool_execution_start",
        toolCallId: "call-secret",
        toolName: "extension_tool",
        args: {
          token: "plain-token",
          apiKey: "plain-api-key",
          api_key: "another-api-key",
          password: "hunter2",
          Secret: "shh",
          AUTHORIZATION: "Basic dXNlcjpwYXNz",
          credential: "credential-value",
          nested,
          raw: "Authorization: Basic dXNlcjpwYXNz; Authorization: Bearer abc.def; token=visible-no-more",
        },
      } satisfies Extract<AgentEvent, { type: "tool_execution_start" }>,
      { observedAt: 550 },
    );

    expect(activity.input).toEqual({
      token: "[redacted]",
      apiKey: "[redacted]",
      api_key: "[redacted]",
      password: "[redacted]",
      Secret: "[redacted]",
      AUTHORIZATION: "[redacted]",
      credential: "[redacted]",
      nested: { api_token: "[redacted]" },
      raw: "Authorization: Basic [redacted]; Authorization: Bearer [redacted]; token= [redacted]",
    });
  });

  it("enforces one aggregate value budget, including structural overhead, keys, and identifiers", () => {
    const activity = mapPiActivity(
      {
        type: "tool_execution_start",
        toolCallId: "i".repeat(MAX_ACTIVITY_IDENTIFIER_LENGTH + 20),
        toolName: "extension_tool",
        args: {
          ["k".repeat(MAX_ACTIVITY_VALUE_KEY_LENGTH + 20)]: "x".repeat(
            MAX_ACTIVITY_PAYLOAD_STRING_LENGTH,
          ),
          nested: Array.from({ length: MAX_ACTIVITY_VALUE_ARRAY_LENGTH }, () => ({
            text: "y".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH),
          })),
        },
      } satisfies Extract<AgentEvent, { type: "tool_execution_start" }>,
      { observedAt: 560 },
    );
    const input = activity.input as Record<string, unknown>;

    expect(activity.activityId).toHaveLength(MAX_ACTIVITY_IDENTIFIER_LENGTH);
    expect(Object.keys(input)[0]).toHaveLength(MAX_ACTIVITY_VALUE_KEY_LENGTH);
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(MAX_ACTIVITY_VALUE_TOTAL_LENGTH);
  });

  it("counts the complete Pi unified patch before retaining only its bounded payload", () => {
    const additions = 6_000;
    const removals = 5_000;
    const patch = `--- a/src/file.ts\n+++ b/src/file.ts\n${"-old\n".repeat(removals)}${"+new\n".repeat(additions)}`;
    const activity = mapPiActivity(
      {
        type: "tool_execution_end",
        toolCallId: "call-large-patch",
        toolName: "edit",
        result: {
          details: {
            diff: "- 4 old\n+ 4 new",
            patch,
            firstChangedLine: 4,
          } satisfies EditToolDetails,
        },
        isError: false,
      } satisfies Extract<AgentEvent, { type: "tool_execution_end" }>,
      { input: { path: "src/file.ts" }, startedAt: 570, observedAt: 580 },
    );

    expect(activity.descriptor.outcome?.addedLines).toBe(additions);
    expect(activity.descriptor.outcome?.removedLines).toBe(removals);
    expect(activity.descriptor.outcome?.diff).toHaveLength(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH + 1);
    expect(activity.descriptor.outcome?.diff?.endsWith("…")).toBe(true);
  });

  it("degrades unknown structural events and hostile getters or proxies to one bounded generic observation", () => {
    const generic = {
      kind: "activity",
      activityId: "unknown",
      state: "progress",
      descriptor: {
        kind: "other",
        nativeToolName: "unknown",
        subject: { label: "unknown", path: null, lineRange: null },
        outcome: null,
        startedAt: null,
        endedAt: null,
      },
      input: null,
      output: null,
    };
    const throwingGetter = {
      get type(): never {
        throw new Error("nope");
      },
    };
    const hostileProxy = new Proxy(
      {},
      {
        get() {
          throw new Error("nope");
        },
        ownKeys() {
          throw new Error("nope");
        },
      },
    );

    expect(() => mapPiActivity(throwingGetter, { observedAt: 600 })).not.toThrow();
    expect(() => mapPiActivity(hostileProxy, { observedAt: 600 })).not.toThrow();
    expect(mapPiActivity({ type: "unexpected", args: { invalid: Number.NaN } }, {})).toEqual(
      generic,
    );
    expect(mapPiActivity(throwingGetter, { observedAt: 600 })).toEqual(generic);
    expect(mapPiActivity(hostileProxy, { observedAt: 600 })).toEqual(generic);
  });
});
