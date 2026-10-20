import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "./vendor/pi-harness/context";
import {
  bashExecutionToText,
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  type BashExecutionMessage,
} from "./vendor/pi-harness/messages";
import {
  buildSessionContext,
  sessionEntryToContextMessages,
} from "./vendor/pi-harness/session/context";
import { prepareStorageCommit, validateCommittedWrites } from "./vendor/pi-harness/session/commit";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  Entry,
  Write,
} from "./vendor/pi-harness/session/types";
import { addUsage, emptyUsage } from "./vendor/pi-harness/session/usage";
import { list, resolveListReadOptions, value } from "./vendor/pi-harness/session/values";
import { CompactionError, err, getOrThrow, toError } from "./vendor/pi-harness/types";

const assistant = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "response" }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test",
  timestamp: 0,
  usage: emptyUsage(),
  stopReason,
});
const entry = (id: string, message: AgentMessage): Entry => ({
  type: "message",
  id,
  message,
  seq: 1,
  timestamp: 0,
  parentId: null,
});

describe("vendored durable address and commit contracts", () => {
  it("rejects ambiguous addresses without rejecting empty keys", () => {
    for (const factory of [value, list]) {
      expect(() => factory("", "key")).toThrow("namespace must not be empty");
      expect(() => factory("bad\u0000namespace")).toThrow("namespace must not contain");
      expect(() => factory("valid", "bad\u0000key")).toThrow("key must not contain");
      expect(Object.isFrozen(factory("valid"))).toBe(true);
      expect(factory("valid").key).toBe("");
    }
  });

  it("defaults, bounds and validates list pagination without losing the cursor", () => {
    expect(resolveListReadOptions()).toEqual({ order: "asc", limit: 1000 });
    const cursor = { seq: 12 };
    expect(resolveListReadOptions({ cursor, order: "desc", limit: 10001 })).toEqual({
      cursor,
      order: "desc",
      limit: 10000,
    });
    expect(resolveListReadOptions({ limit: 1 })).toEqual({ order: "asc", limit: 1 });
    for (const limit of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => resolveListReadOptions({ limit })).toThrow("positive safe integer");
    }
  });

  it("rejects corrupted sequence, duplicate ids and dangling parents before replay", () => {
    const state = {
      hasEntryOrUsageId: (id: string) => id === "persisted",
      hasEntryId: (id: string) => id === "parent",
    };
    const writes: Write[] = [
      {
        kind: "entry",
        entry: { type: "custom", id: "root", parentId: "parent", customType: "test" },
      },
      {
        kind: "entry",
        entry: { type: "custom", id: "child", parentId: "root", customType: "test" },
      },
    ];
    const prepared = prepareStorageCommit(writes, 4, 9);
    expect(prepared.result).toEqual({ firstSeq: 4, seqs: [4, 5], timestamp: 9 });
    expect(() => validateCommittedWrites(prepared.writes, 4, state)).not.toThrow();
    expect(() => validateCommittedWrites([{ ...prepared.writes[0], seq: 3 }], 4, state)).toThrow(
      "Non-monotonic storage sequence: 3",
    );
    expect(() =>
      validateCommittedWrites([...prepared.writes, { ...prepared.writes[0], seq: 6 }], 4, state),
    ).toThrow("Duplicate entry or usage id: root");
    expect(() =>
      validateCommittedWrites(
        prepareStorageCommit(
          [
            {
              kind: "entry",
              entry: { type: "custom", id: "persisted", parentId: null, customType: "test" },
            },
          ],
          4,
          9,
        ).writes,
        4,
        state,
      ),
    ).toThrow("Duplicate entry or usage id: persisted");
    expect(() =>
      validateCommittedWrites(
        prepareStorageCommit(
          [
            {
              kind: "entry",
              entry: { type: "custom", id: "orphan", parentId: "missing", customType: "test" },
            },
          ],
          4,
          9,
        ).writes,
        4,
        state,
      ),
    ).toThrow("Missing parent entry: missing");
  });

  it("adds optional usage counters only when a provider reported them", () => {
    const none = emptyUsage();
    expect(addUsage(none, none)).toEqual(none);
    expect(
      addUsage(
        { ...none, cacheWrite1h: 2, reasoning: 3 },
        { ...none, cacheWrite1h: 5, reasoning: 7 },
      ),
    ).toMatchObject({ cacheWrite1h: 7, reasoning: 10 });
    expect(addUsage(none, { ...none, cacheWrite1h: 2, reasoning: 3 })).toMatchObject({
      cacheWrite1h: 2,
      reasoning: 3,
    });
    expect(addUsage({ ...none, cacheWrite1h: 2, reasoning: 3 }, none)).toMatchObject({
      cacheWrite1h: 2,
      reasoning: 3,
    });
  });
});

describe("vendored persisted message projection", () => {
  it("preserves shell output, cancellation, exit status and truncation diagnostics", () => {
    const base: BashExecutionMessage = {
      role: "bashExecution",
      command: "command",
      output: "",
      exitCode: undefined,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    };
    expect(bashExecutionToText(base)).toBe("Ran `command`\n(no output)");
    expect(
      bashExecutionToText({
        ...base,
        output: "out",
        cancelled: true,
        exitCode: 2,
        truncated: true,
        fullOutputPath: "/log",
      }),
    ).toBe(
      "Ran `command`\n```\nout\n```\n\n(command cancelled)\n\n[Output truncated. Full output: /log]",
    );
    expect(bashExecutionToText({ ...base, exitCode: 2 })).toContain("Command exited with code 2");
    for (const exitCode of [0, null, undefined]) {
      expect(
        bashExecutionToText({ ...base, exitCode: exitCode as number | undefined, truncated: true }),
      ).not.toContain("Command exited");
    }
  });

  it("normalizes legacy timestamps and converts only supported LLM roles", () => {
    const iso = "2026-01-02T00:00:00Z";
    expect(createBranchSummaryMessage("branch", null, iso).timestamp).toBe(Date.parse(iso));
    expect(createCompactionSummaryMessage("summary", 123, iso).timestamp).toBe(Date.parse(iso));
    const image = { type: "image" as const, data: "AQ==", mimeType: "image/png" };
    const user: AgentMessage = { role: "user", content: "original", timestamp: 1 };
    const messages: AgentMessage[] = [
      {
        role: "bashExecution",
        command: "a",
        output: "",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      },
      {
        role: "bashExecution",
        command: "private",
        output: "",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 1,
      },
      { role: "custom", customType: "note", content: "custom", display: false, timestamp: 2 },
      { role: "custom", customType: "image", content: [image], display: true, timestamp: 3 },
      createBranchSummaryMessage("branch", null, 4),
      createCompactionSummaryMessage("summary", 123, 5),
      user,
      { role: "unknown", timestamp: 0 } as unknown as AgentMessage,
    ];
    const converted = convertToLlm(messages);
    expect(converted).toHaveLength(6);
    expect(converted[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Ran `a`\n(no output)" }],
    });
    expect(converted[1]).toMatchObject({ content: [{ type: "text", text: "custom" }] });
    expect(converted[2]).toMatchObject({ content: [image] });
    expect(converted[3]).toMatchObject({
      content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + "branch" + BRANCH_SUMMARY_SUFFIX }],
    });
    expect(converted[4]).toMatchObject({
      content: [
        { type: "text", text: COMPACTION_SUMMARY_PREFIX + "summary" + COMPACTION_SUMMARY_SUFFIX },
      ],
    });
    expect(converted[5]).toBe(user);
  });

  it("reconstructs the latest compaction tail but drops failed and pending assistant attempts", async () => {
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "compact",
      seq: 2,
      timestamp: 0,
      parentId: "old",
      summary: "summary",
      tokensBefore: 123,
      fromHook: false,
      retainedTail: [
        assistant("stop"),
        assistant("error"),
        assistant("aborted"),
        assistant("deferred"),
      ],
    };
    const branch: BranchSummaryEntry = {
      type: "branch_summary",
      id: "branch",
      seq: 3,
      timestamp: 0,
      parentId: "compact",
      summary: "branch",
      fromId: null,
      fromHook: false,
    };
    expect(sessionEntryToContextMessages(branch)).toEqual([
      createBranchSummaryMessage("branch", null, 0),
    ]);
    expect(sessionEntryToContextMessages({ ...branch, summary: "" })).toEqual([]);
    expect(sessionEntryToContextMessages(entry("failed", assistant("error")))).toEqual([]);
    const custom: Entry = {
      type: "custom",
      id: "custom",
      seq: 4,
      timestamp: 0,
      parentId: "branch",
      customType: "note",
    };
    expect(sessionEntryToContextMessages(custom)).toEqual([]);
    const result = await buildSessionContext(
      [entry("old", { role: "user", content: "old", timestamp: 0 }), compaction, branch, custom],
      { entryProjectors: { note: () => undefined } },
      BACKGROUND_CONTEXT,
    );
    expect(result).toEqual([
      createCompactionSummaryMessage("summary", 123, 0),
      assistant("stop"),
      createBranchSummaryMessage("branch", null, 0),
    ]);
  });

  it("retains thrown error causes even when an external callback throws non-Errors", () => {
    const original = new Error("original");
    expect(toError(original)).toBe(original);
    expect(toError("text").message).toBe("text");
    expect(toError({ code: 7 }).message).toBe('{"code":7}');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(toError(cyclic).message).toBe("[object Object]");
    const compaction = new CompactionError("aborted", "stop", original);
    expect(compaction.cause).toBe(original);
    expect(() => getOrThrow(err(original))).toThrow(original);
  });
});
