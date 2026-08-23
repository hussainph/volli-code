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
  type PiActivityContext,
} from "./activity";

function activityContext(context: Omit<PiActivityContext, "turnId">): PiActivityContext {
  return { turnId: "turn-1", ...context };
}

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

    const started = mapPiActivity(startedEvent, activityContext({ observedAt: 100 }));
    const progress = mapPiActivity(
      updatedEvent,
      activityContext({ startedAt: 100, observedAt: 120 }),
    );
    const completed = mapPiActivity(
      endedEvent,
      activityContext({
        input: started.input,
        startedAt: 100,
        observedAt: 140,
      }),
    );

    expect(started).toMatchObject({
      turnId: "turn-1",
      state: "started",
      input: { path: "src/index.ts", offset: 4, limit: 3 },
      descriptor: {
        subject: { path: "src/index.ts", lineRange: { start: 4, end: 6 } },
        startedAt: 100,
        endedAt: null,
      },
    });
    expect(progress).toMatchObject({
      turnId: "turn-1",
      state: "progress",
      input: { path: "src/index.ts", offset: 4, limit: 3 },
      output: { content: [{ type: "text", text: "partial" }] },
    });
    expect(completed).toMatchObject({
      turnId: "turn-1",
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
      mapPiActivity(
        editEnd,
        activityContext({ input: { path: "src/file.ts" }, startedAt: 300, observedAt: 350 }),
      ),
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
      mapPiActivity(
        bashEnd,
        activityContext({ input: { command: "vp test" }, startedAt: 300, observedAt: 350 }),
      ),
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

    const activity = mapPiActivity(
      endedEvent,
      activityContext({
        input: { command: "vp test" },
        startedAt: 400,
        observedAt: 450,
      }),
    );
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
        (_item, index) => `node-${group * MAX_ACTIVITY_VALUE_ARRAY_LENGTH + index}`,
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
    const activity = mapPiActivity(event, activityContext({ observedAt: 500 }));
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
      activityContext({ observedAt: 510 }),
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
      activityContext({ observedAt: 550 }),
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
      activityContext({ observedAt: 560 }),
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
      activityContext({ input: { path: "src/file.ts" }, startedAt: 570, observedAt: 580 }),
    );

    expect(activity.descriptor.outcome?.addedLines).toBe(additions);
    expect(activity.descriptor.outcome?.removedLines).toBe(removals);
    expect(activity.descriptor.outcome?.diff).toHaveLength(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH + 1);
    expect(activity.descriptor.outcome?.diff?.endsWith("…")).toBe(true);
  });

  it("degrades unknown structural events and hostile getters or proxies to one bounded generic observation", () => {
    const generic = {
      kind: "activity",
      turnId: "turn-1",
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

    expect(() => mapPiActivity(throwingGetter, activityContext({ observedAt: 600 }))).not.toThrow();
    expect(() => mapPiActivity(hostileProxy, activityContext({ observedAt: 600 }))).not.toThrow();
    expect(
      mapPiActivity({ type: "unexpected", args: { invalid: Number.NaN } }, activityContext({})),
    ).toEqual(generic);
    expect(mapPiActivity(throwingGetter, activityContext({ observedAt: 600 }))).toEqual(generic);
    expect(mapPiActivity(hostileProxy, activityContext({ observedAt: 600 }))).toEqual(generic);

    // A hostile END event degrades to a state the recovery marker validator
    // accepts: only end-event activities are persisted, and a fallback that
    // kept "progress" for one would be written and then refused on every
    // read-back — the poisoned-marker shape of VC-155.
    const hostileEndEvent = {
      type: "tool_execution_end",
      get toolName(): never {
        throw new Error("nope");
      },
    };
    expect(mapPiActivity(hostileEndEvent, activityContext({ observedAt: 600 }))).toEqual({
      ...generic,
      state: "completed",
    });
  });

  it("keeps incomplete provider payloads meaningful without inventing paths, ranges, or failures", () => {
    const cases = [
      {
        event: {
          type: "tool_execution_start",
          toolCallId: "call-other",
          toolName: "extension_tool",
          args: null,
        },
        expected: {
          state: "started",
          input: null,
          descriptor: {
            kind: "other",
            subject: { label: "extension_tool", path: null, lineRange: null },
          },
        },
      },
      {
        event: {
          type: "tool_execution_start",
          toolCallId: "call-write-no-path",
          toolName: "write",
          args: {},
        },
        expected: {
          state: "started",
          descriptor: {
            kind: "write-file",
            subject: { label: null, path: null, lineRange: null },
          },
        },
      },
      {
        event: {
          type: "tool_execution_start",
          toolCallId: "call-read-no-range",
          toolName: "read",
          args: { filePath: " src/alternate.ts ", offset: 0, limit: 2.5 },
        },
        expected: {
          state: "started",
          input: { filePath: "src/alternate.ts", offset: 0, limit: 2.5 },
          descriptor: {
            kind: "read-file",
            subject: { label: "src/alternate.ts", path: "src/alternate.ts", lineRange: null },
          },
        },
      },
      {
        event: {
          type: "tool_execution_start",
          toolCallId: "call-bash-empty",
          toolName: "bash",
          args: { command: "   " },
        },
        expected: {
          state: "started",
          input: { command: "   " },
          descriptor: {
            kind: "run-command",
            subject: { label: null, path: null, lineRange: null },
          },
        },
      },
    ] as const;

    for (const { event, expected } of cases) {
      expect(mapPiActivity(event, activityContext({ observedAt: 610 }))).toMatchObject(expected);
    }
  });

  it("projects provider failure fallbacks and serializable primitive edge values", () => {
    const fallbackOutput = mapPiActivity(
      {
        type: "tool_execution_end",
        toolCallId: "call-string-error",
        toolName: "bash",
        result: "Bearer abc.def",
        isError: true,
      },
      activityContext({ input: true, startedAt: 620, observedAt: 630 }),
    );
    const emptyFailure = mapPiActivity(
      {
        type: "tool_execution_end",
        toolCallId: "call-empty-error",
        toolName: "bash",
        result: { summary: "  ", content: [{ type: "image", text: "ignored" }] },
        isError: true,
      },
      activityContext({ input: false, startedAt: 620, observedAt: 630 }),
    );
    const primitiveInput = mapPiActivity(
      {
        type: "tool_execution_start",
        toolCallId: "call-primitives",
        toolName: "extension_tool",
        args: [true, false, Number.POSITIVE_INFINITY, undefined, Symbol("not-json")],
      },
      activityContext({ observedAt: 640 }),
    );

    expect(fallbackOutput).toMatchObject({
      state: "failed",
      input: true,
      output: "Bearer [redacted]",
      error: "Bearer [redacted]",
      descriptor: { outcome: { summary: null } },
    });
    expect(emptyFailure).toMatchObject({
      state: "failed",
      input: false,
      error: "Tool execution failed.",
      descriptor: { outcome: { summary: null } },
    });
    expect(primitiveInput.input).toEqual([true, false, null, null, null]);
  });

  it("falls back when the caller's turn context becomes hostile", () => {
    const context = new Proxy(
      {},
      {
        get() {
          throw new Error("turn context unavailable");
        },
      },
    ) as PiActivityContext;

    expect(
      mapPiActivity(
        { type: "tool_execution_start", toolCallId: "call", toolName: "read", args: {} },
        context,
      ),
    ).toMatchObject({ turnId: "unknown", activityId: "unknown", state: "progress" });
  });

  it("retains only the serializable prefix when aggregate payload capacity is exhausted", () => {
    const duplicateKeyPrefix = "k".repeat(MAX_ACTIVITY_VALUE_KEY_LENGTH);
    const activity = mapPiActivity(
      {
        type: "tool_execution_start",
        toolCallId: "   ",
        toolName: "extension_tool",
        args: {
          first: Array.from({ length: MAX_ACTIVITY_VALUE_ARRAY_LENGTH }, () =>
            "a".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH),
          ),
          arrayAfterBudget: ["not retained"],
          objectAfterBudget: { notRetained: true },
          falseValue: false,
          numberAfterBudget: 12,
          nullAfterBudget: null,
        },
      },
      activityContext({ observedAt: 650 }),
    );
    const input = activity.input as Record<string, unknown>;

    expect(activity.activityId).toBe("unknown");
    expect(JSON.stringify(input.first)).toContain("…");
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(MAX_ACTIVITY_VALUE_TOTAL_LENGTH);
    expect(input).not.toHaveProperty("arrayAfterBudget");
    expect(input).not.toHaveProperty("objectAfterBudget");
    expect(input).not.toHaveProperty("numberAfterBudget");
    expect(input).not.toHaveProperty("nullAfterBudget");

    const duplicateKeys = mapPiActivity(
      {
        type: "tool_execution_start",
        toolCallId: "call-duplicate-key",
        toolName: "extension_tool",
        args: {
          [`${duplicateKeyPrefix}-one`]: "first duplicate key wins",
          [`${duplicateKeyPrefix}-two`]: "second duplicate key is omitted",
        },
      },
      activityContext({ observedAt: 650 }),
    );
    expect(duplicateKeys.input).toEqual({ [duplicateKeyPrefix]: "first duplicate key wins" });

    expect(
      mapPiActivity(
        {
          type: "tool_execution_start",
          toolCallId: "call-false",
          toolName: "extension_tool",
          args: false,
        },
        activityContext({ observedAt: 650 }),
      ).input,
    ).toBe(false);
  });

  it("drops incomplete aggregate children without exceeding the activity payload budget", () => {
    const long = "x".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH);
    const common = { type: "tool_execution_start", toolName: "extension_tool" } as const;
    const arrayWithoutRoomForStructure = mapPiActivity(
      {
        ...common,
        toolCallId: "array-structure",
        args: [long, "y".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH - 9), []],
      },
      activityContext({ observedAt: 651 }),
    );
    const arrayWithoutRoomForValue = mapPiActivity(
      {
        ...common,
        toolCallId: "array-value",
        args: [long, "y".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH - 9), ""],
      },
      activityContext({ observedAt: 651 }),
    );
    const objectWithoutRoomForKey = mapPiActivity(
      {
        ...common,
        toolCallId: "object-key",
        args: {
          a: long,
          b: "y".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH - 66),
          ["k".repeat(MAX_ACTIVITY_VALUE_KEY_LENGTH)]: "omitted",
        },
      },
      activityContext({ observedAt: 651 }),
    );
    const objectWithoutRoomForValue = mapPiActivity(
      {
        ...common,
        toolCallId: "object-value",
        args: {
          a: long,
          b: "y".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH - 21),
          c: true,
        },
      },
      activityContext({ observedAt: 651 }),
    );
    const objectWithoutRoomForStructure = mapPiActivity(
      {
        ...common,
        toolCallId: "object-structure",
        args: { a: [long, "y".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH - 19)], b: {} },
      },
      activityContext({ observedAt: 651 }),
    );
    const arrayWithoutRoomForScalars = [null, 10].map((value) =>
      mapPiActivity(
        {
          ...common,
          toolCallId: `array-${String(value)}`,
          args: [long, "y".repeat(MAX_ACTIVITY_PAYLOAD_STRING_LENGTH - 9), value],
        },
        activityContext({ observedAt: 651 }),
      ),
    );

    for (const activity of [
      arrayWithoutRoomForStructure,
      arrayWithoutRoomForValue,
      objectWithoutRoomForKey,
      objectWithoutRoomForValue,
      objectWithoutRoomForStructure,
      ...arrayWithoutRoomForScalars,
    ]) {
      expect(JSON.stringify(activity.input).length).toBeLessThanOrEqual(
        MAX_ACTIVITY_VALUE_TOTAL_LENGTH,
      );
    }
    expect(arrayWithoutRoomForStructure.input).toHaveLength(2);
    expect(arrayWithoutRoomForValue.input).toHaveLength(2);
    expect(objectWithoutRoomForKey.input).toMatchObject({ a: long });
    expect(objectWithoutRoomForValue.input).toMatchObject({ a: long });
    expect(objectWithoutRoomForValue.input).not.toHaveProperty("c");
    expect(objectWithoutRoomForStructure.input).not.toHaveProperty("b");
  });

  it("keeps a nonempty provider summary when no text content is present", () => {
    expect(
      mapPiActivity(
        {
          type: "tool_execution_end",
          toolCallId: "summary",
          toolName: "bash",
          result: { summary: "completed normally" },
          isError: false,
        },
        activityContext({ observedAt: 652 }),
      ).descriptor.outcome,
    ).toMatchObject({ summary: "completed normally" });
  });

  it("uses a path as the subject label for otherwise unknown tools", () => {
    expect(
      mapPiActivity(
        {
          type: "tool_execution_start",
          toolCallId: "call-unknown-path",
          toolName: "extension_tool",
          args: { path: "plugin/data.json" },
        },
        activityContext({ observedAt: 660 }),
      ),
    ).toMatchObject({
      descriptor: {
        kind: "other",
        subject: { label: "plugin/data.json", path: "plugin/data.json", lineRange: null },
      },
    });
  });
});
