/**
 * Tests for model-aware compaction preparation. The estimator under test is
 * `estimateMessageTokens` from `./token-counting` — the same one the cut and
 * `tokensBefore` are built on — so these tests prove the preparation agrees
 * with the tokenizer, and with Pi's own structural rules.
 */

import {
  findCutPoint,
  type AgentMessage,
  type CompactionEntry,
  type Entry,
  type MessageEntry,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import { findModelCutPoint, prepareModelCompaction } from "./compaction-preparation";
import { estimateMessageTokens } from "./token-counting";

function model(): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages",
    provider: "test",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  } as Model<Api>;
}

const charsOver4 = (text: string) => Math.ceil(text.length / 4);

const SETTINGS = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };

let nextSeq = 0;

function entry(message: AgentMessage): MessageEntry {
  nextSeq += 1;
  return {
    type: "message",
    id: `entry-${nextSeq}`,
    seq: nextSeq,
    parentId: null,
    timestamp: nextSeq,
    message,
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistant(
  text: string,
  toolCall?: { id: string; name: string; path: string },
): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      ...(toolCall
        ? [
            {
              type: "toolCall" as const,
              id: toolCall.id,
              name: toolCall.name,
              arguments: { path: toolCall.path },
            },
          ]
        : []),
    ],
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse" as const,
    timestamp: 0,
  };
}

function toolResult(callId: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

function compactionEntry(summary: string, retainedTail: AgentMessage[]): CompactionEntry {
  nextSeq += 1;
  return {
    type: "compaction",
    id: `compaction-${nextSeq}`,
    seq: nextSeq,
    parentId: null,
    timestamp: nextSeq,
    summary,
    tokensBefore: 1_000,
    retainedTail,
    details: { readFiles: [], modifiedFiles: [] },
    fromHook: false,
  };
}

describe("prepareModelCompaction", () => {
  it("is a no-op for an empty path and for a path already ending in a compaction", () => {
    expect(prepareModelCompaction([], SETTINGS, model())).toBeUndefined();
    const path = [entry(user("hello")), compactionEntry("prior summary", [])];
    expect(prepareModelCompaction(path, SETTINGS, model())).toBeUndefined();
  });

  it("never cuts between a tool call and its result", () => {
    const path: Entry[] = [
      entry(user("read the file")),
      entry(assistant("looking", { id: "call-1", name: "read", path: "/tmp/a.ts" })),
      entry(toolResult("call-1", "file contents here")),
      entry(assistant("done reading")),
    ];
    const prepared = prepareModelCompaction(path, SETTINGS, model());
    expect(prepared).toBeDefined();
    const tail = prepared?.retainedTail ?? [];
    expect(tail.length).toBeGreaterThan(0);
    expect(tail[0]?.role).not.toBe("toolResult");
  });

  it("keeps the estimator's grouping intact: a tiny budget keeps only the current turn's tail, split at the turn start", () => {
    const path: Entry[] = [
      entry(user("turn one")),
      entry(assistant("reply one")),
      entry(user("turn two")),
      entry(assistant("reply two")),
      entry(user("turn three")),
      entry(assistant("reply three")),
    ];
    const prepared = prepareModelCompaction(path, { ...SETTINGS, keepRecentTokens: 1 }, model());
    expect(prepared).toBeDefined();
    // Budget of 1 token: the first valid cut point from the end is the last
    // entry — an assistant reply — so the cut lands inside the last turn and
    // the turn's user message becomes the split-turn prefix.
    expect(prepared?.isSplitTurn).toBe(true);
    expect(prepared?.retainedTail.map((m) => m.role)).toEqual(["assistant"]);
    expect(prepared?.turnPrefixMessages.map((m) => m.role)).toEqual(["user"]);
    expect(prepared?.messagesToSummarize.length).toBe(4);
  });

  it("cuts earlier than Pi's chars/4 heuristic on CJK text, whose tokens the chars/4 divisor understates", () => {
    const cjk = "这是一段很长的中文文本，用来测试分词估算。".repeat(400);
    const path: Entry[] = [
      entry(user(cjk)),
      entry(assistant("回复一")),
      entry(user(cjk)),
      entry(assistant("回复二")),
      entry(user("final question")),
      entry(assistant("final answer")),
    ];
    // 2500 sits between the estimator's per-CJK-message figure (~8400 chars /
    // 3, plus framing) and chars/4's (~2100 per message): Pi keeps walking
    // where the model-aware cut has already stopped.
    const budget = 2_500;
    const prepared = prepareModelCompaction(
      path,
      { ...SETTINGS, keepRecentTokens: budget },
      model(),
    );
    expect(prepared).toBeDefined();
    const piCut = findCutPoint(path, 0, path.length, budget);
    expect(prepared?.retainedTail.length).toBeLessThan(
      path.length - (piCut.firstKeptEntryIndex as number),
    );
  });

  it("estimates above chars/4 for both code and CJK, and uses a real tokenizer when the model has one", () => {
    const code = "const x=1;".repeat(200);
    const cjk = "这是一段很长的中文文本，用来测试分词估算。".repeat(400);
    // Conservative fallback (no published tokenizer for this model): errs high
    // against chars/4, for code and CJK alike.
    expect(estimateMessageTokens(user(code), model())).toBeGreaterThan(charsOver4(code));
    expect(estimateMessageTokens(user(cjk), model())).toBeGreaterThan(charsOver4(cjk));
    // OpenAI-family model: the real BPE ranks, and CJK costs far more than
    // chars/4 claims.
    const openai = { ...model(), api: "openai-completions" as const, id: "gpt-4o" } as Model<Api>;
    expect(estimateMessageTokens(user(cjk), openai)).toBeGreaterThan(charsOver4(cjk));
  });

  it("splits a turn only when the cut lands mid-turn, and summarizes the prefix separately", () => {
    const path: Entry[] = [
      entry(user("turn start")),
      entry(assistant("mid-turn reply", { id: "call-2", name: "read", path: "/tmp/b.ts" })),
      entry(toolResult("call-2", "result")),
      entry(assistant("mid-turn conclusion")),
    ];
    const prepared = prepareModelCompaction(path, { ...SETTINGS, keepRecentTokens: 1 }, model());
    expect(prepared?.isSplitTurn).toBe(true);
    expect(prepared?.turnPrefixMessages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(prepared?.retainedTail.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("uses the latest compaction entry's summary and ranges the cut over its retained tail plus everything after", () => {
    const prior = compactionEntry("the latest summary", [assistant("kept reply")]);
    const path: Entry[] = [
      entry(user("pre-compaction turn")),
      prior,
      entry(user("post-compaction turn")),
      entry(assistant("post-compaction reply")),
    ];
    const prepared = prepareModelCompaction(path, { ...SETTINGS, keepRecentTokens: 1 }, model());
    expect(prepared?.previousSummary).toBe("the latest summary");
    const summarizedText = JSON.stringify(prepared?.messagesToSummarize);
    expect(summarizedText).not.toContain("pre-compaction turn");
    expect(summarizedText).toContain("kept reply");
  });

  it("computes tokensBefore from the messages alone, never from the stale usage in the retained tail", () => {
    const stale = assistant("overflowed reply");
    const staleWithHugeUsage = {
      ...stale,
      usage: {
        ...("usage" in stale ? stale.usage : {}),
        totalTokens: 99_999,
        input: 99_000,
        output: 900,
      },
    } as AgentMessage;
    const path: Entry[] = [entry(user("short turn")), entry(staleWithHugeUsage)];
    const prepared = prepareModelCompaction(path, SETTINGS, model());
    const expected = [path[0], path[1]]
      .map((e) => estimateMessageTokens((e as MessageEntry).message, model()))
      .reduce((a, b) => a + b, 0);
    expect(prepared?.tokensBefore).toBe(expected);
    expect(prepared?.tokensBefore).toBeLessThan(99_999);
  });

  it("carries file operations out of the messages this preparation actually summarizes", () => {
    const path: Entry[] = [
      entry(user("work the files")),
      entry(assistant("reading", { id: "call-3", name: "read", path: "/tmp/read.ts" })),
      entry(toolResult("call-3", "contents")),
      entry(assistant("editing", { id: "call-4", name: "edit", path: "/tmp/edited.ts" })),
    ];
    // A budget that forces everything old into the summarized range: the file
    // metadata must follow these partitions, not Pi's (Pi's own cut over this
    // small history would keep everything and extract nothing).
    const prepared = prepareModelCompaction(path, { ...SETTINGS, keepRecentTokens: 1 }, model());
    expect(prepared?.fileOps.read.has("/tmp/read.ts")).toBe(true);
    // The edit call sits in the retained tail, not the summarized range, so it
    // is deliberately absent from the metadata.
    expect(prepared?.fileOps.edited.has("/tmp/edited.ts")).toBe(false);
  });

  it("inherits the previous compaction's details file lists conservatively", () => {
    const prior = compactionEntry("prior", []);
    (prior as { details?: unknown }).details = {
      readFiles: ["/tmp/prev-read.ts"],
      modifiedFiles: ["/tmp/prev-mod.ts"],
    };
    const path: Entry[] = [
      entry(user("before")),
      prior,
      entry(user("after")),
      entry(assistant("reply")),
    ];
    const prepared = prepareModelCompaction(path, { ...SETTINGS, keepRecentTokens: 1 }, model());
    expect(prepared?.fileOps.read.has("/tmp/prev-read.ts")).toBe(true);
    expect(prepared?.fileOps.edited.has("/tmp/prev-mod.ts")).toBe(true);
  });

  it("agrees with Pi's turn-start rule through findModelCutPoint", () => {
    const path: Entry[] = [
      entry(user("turn start")),
      entry(assistant("mid reply")),
      entry(user("next turn")),
    ];
    const cut = findModelCutPoint(path, 0, path.length, 1, model());
    expect(cut.firstKeptEntryIndex).toBe(2);
    expect(cut.isSplitTurn).toBe(false);
  });
});
