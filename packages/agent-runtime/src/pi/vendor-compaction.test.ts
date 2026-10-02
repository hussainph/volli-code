import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/chord";
import {
  contentText,
  createModels,
  fauxProvider,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "./vendor/pi-harness/context";
import {
  compactWithRequest,
  createSummaryRequestOptions,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateSummaryWithRequest,
  prepareCompaction,
  type CompactionPreparation,
  type SummaryRequest,
} from "./vendor/pi-harness/compaction/compaction";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  formatFileOperations,
  serializeConversation,
} from "./vendor/pi-harness/compaction/utils";
import type { BranchSummaryEntry, CompactionEntry, Entry } from "./vendor/pi-harness/session/types";
import { emptyUsage } from "./vendor/pi-harness/session/usage";
import { getOrThrow } from "./vendor/pi-harness/types";

const context = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(
  fauxProvider({ api: "anthropic-messages", provider: "anthropic", models: [{ id: "test" }] })
    .provider,
);
const model = models.getModel("anthropic", "test")!;
const assistant = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "summary" }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test",
  timestamp: 0,
  usage: { ...emptyUsage(), input: 10, totalTokens: 10 },
  stopReason: "stop",
  ...overrides,
});
const user = (content = "user"): AgentMessage => ({ role: "user", content, timestamp: 0 });
const messageEntry = (id: string, message: AgentMessage): Entry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: 0,
  seq: 1,
  message,
});
const branchEntry = (summary = "branch"): BranchSummaryEntry => ({
  type: "branch_summary",
  id: "branch",
  parentId: null,
  timestamp: 0,
  seq: 1,
  summary,
  fromId: null,
  fromHook: false,
});
const compactEntry = (details: CompactionEntry["details"]): CompactionEntry => ({
  type: "compaction",
  id: "compact",
  parentId: null,
  timestamp: 0,
  seq: 1,
  summary: "old summary",
  fromHook: false,
  tokensBefore: 99,
  retainedTail: [user("retained"), assistant()],
  details,
});
const preparation = (overrides: Partial<CompactionPreparation> = {}): CompactionPreparation => ({
  messagesToSummarize: [user("history")],
  turnPrefixMessages: [user("prefix")],
  retainedTail: [assistant()],
  isSplitTurn: true,
  tokensBefore: 123,
  fileOps: createFileOps(),
  settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 100 },
  ...overrides,
});

describe("vendored compaction usage and cut-point edges", () => {
  it("ignores failed, missing and zero usage and adds estimates after the last valid reply", () => {
    const valid = assistant();
    const skipped = [
      assistant({ stopReason: "aborted" }),
      assistant({ stopReason: "error" }),
      assistant({ usage: emptyUsage() }),
      { role: "assistant", content: [], timestamp: 0 } as unknown as AgentMessage,
    ];
    expect(estimateContextTokens([valid, ...skipped, user("12345678")])).toEqual({
      tokens: 10 + skipped.reduce((sum, m) => sum + estimateTokens(m), 0) + 2,
      usageTokens: 10,
      trailingTokens: skipped.reduce((sum, m) => sum + estimateTokens(m), 0) + 2,
      lastUsageIndex: 0,
    });
    expect(estimateContextTokens([user("12345678")])).toEqual({
      tokens: 2,
      usageTokens: 0,
      trailingTokens: 2,
      lastUsageIndex: null,
    });
    expect(
      estimateContextTokens([
        assistant({ usage: { ...emptyUsage(), input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } }),
      ]).tokens,
    ).toBe(14);
  });

  it("estimates legacy custom, shell, image, thinking and unserializable tool content", () => {
    expect(
      estimateTokens({
        role: "custom",
        customType: "note",
        display: false,
        timestamp: 0,
        content: "12345",
      }),
    ).toBe(2);
    expect(
      estimateTokens({
        role: "bashExecution",
        command: "abc",
        output: "de",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 0,
      }),
    ).toBe(2);
    expect(
      estimateTokens({ role: "branchSummary", summary: "12345", fromId: null, timestamp: 0 }),
    ).toBe(2);
    expect(
      estimateTokens({
        role: "compactionSummary",
        summary: "12345",
        tokensBefore: 1,
        timestamp: 0,
      }),
    ).toBe(2);
    expect(
      estimateTokens({
        role: "user",
        timestamp: 0,
        content: [
          { type: "text", text: "" },
          { type: "image", data: "", mimeType: "image/png" },
        ],
      }),
    ).toBe(1200);
    const cycle: Record<string, JsonValue> = {};
    cycle.self = cycle;
    expect(
      estimateTokens(
        assistant({
          content: [
            { type: "thinking", thinking: "1234" },
            { type: "toolCall", id: "1", name: "tool", arguments: cycle },
            {
              type: "toolCall",
              id: "2",
              name: "tool",
              arguments: undefined as unknown as Record<string, JsonValue>,
            },
          ],
        }),
      ),
    ).toBe(Math.ceil((4 + 4 + "[unserializable]".length + 4 + "undefined".length) / 4));
    expect(estimateTokens({ role: "system", content: "ignored", timestamp: 0 })).toBe(0);
    expect(
      estimateTokens(
        assistant({
          content: [{ type: "legacy-unknown" } as unknown as AssistantMessage["content"][number]],
        }),
      ),
    ).toBe(0);
    expect(
      estimateTokens({
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        isError: false,
        timestamp: 0,
        content: [
          { type: "text", text: "1234" },
          { type: "image", data: "", mimeType: "image/png" },
        ],
      }),
    ).toBe(1201);
  });

  it("does not split orphan tool results and attaches metadata to the next retained turn", () => {
    const custom: Entry = {
      type: "custom",
      id: "custom",
      parentId: null,
      seq: 1,
      timestamp: 0,
      customType: "note",
    };
    const tool = messageEntry("tool", {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [],
      isError: false,
      timestamp: 0,
    });
    expect(findCutPoint([custom, tool], 0, 2, 1)).toEqual({
      firstKeptEntryIndex: 0,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
    expect(findTurnStartIndex([custom, messageEntry("assistant", assistant())], 1, 0)).toBe(-1);
    expect(findTurnStartIndex([branchEntry(), messageEntry("assistant", assistant())], 1, 0)).toBe(
      0,
    );
    const entries = [
      messageEntry("user", user()),
      custom,
      branchEntry(),
      messageEntry("assistant", assistant()),
    ];
    expect(findCutPoint(entries, 0, entries.length, 1, () => 1)).toMatchObject({
      firstKeptEntryIndex: 1,
      turnStartIndex: 0,
      isSplitTurn: true,
    });
    expect(
      findCutPoint([compactEntry(undefined), messageEntry("u", user())], 0, 2, 1, () => 1)
        .firstKeptEntryIndex,
    ).toBe(1);
    for (const message of [
      {
        role: "bashExecution",
        command: "cmd",
        output: "out",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 0,
      },
      { role: "custom", customType: "note", content: "custom", display: true, timestamp: 0 },
      { role: "branchSummary", summary: "branch", fromId: null, timestamp: 0 },
      { role: "compactionSummary", summary: "compaction", tokensBefore: 10, timestamp: 0 },
    ] satisfies AgentMessage[])
      expect(
        findCutPoint([messageEntry("legacy", message)], 0, 1, 1, () => 1).firstKeptEntryIndex,
      ).toBe(0);
    expect(
      findCutPoint(
        [messageEntry("system", { role: "system", content: "prompt", timestamp: 0 })],
        0,
        1,
        1,
      ).firstKeptEntryIndex,
    ).toBe(0);
  });

  it("carries only valid legacy file details into iterative compaction", () => {
    for (const details of [
      null,
      [],
      { readFiles: ["read", 12], modifiedFiles: ["edit", false] },
      { readFiles: false, modifiedFiles: false },
    ]) {
      const result = getOrThrow(
        prepareCompaction(
          [compactEntry(details), messageEntry("new", user("new"))],
          { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 },
          () => 1,
        ),
      );
      expect(result?.previousSummary).toBe("old summary");
      expect(result?.retainedTail).toEqual([user("new")]);
      expect(result?.fileOps.read.has("read")).toBe(
        typeof details === "object" &&
          details !== null &&
          !Array.isArray(details) &&
          Array.isArray(details.readFiles),
      );
      expect(result?.fileOps.edited.has("edit")).toBe(
        typeof details === "object" &&
          details !== null &&
          !Array.isArray(details) &&
          Array.isArray(details.modifiedFiles),
      );
    }
    expect(getOrThrow(prepareCompaction([], DEFAULT_COMPACTION_SETTINGS))).toBeUndefined();
    expect(
      getOrThrow(prepareCompaction([compactEntry(undefined)], DEFAULT_COMPACTION_SETTINGS)),
    ).toBeUndefined();
    const result = getOrThrow(
      prepareCompaction(
        [branchEntry(), messageEntry("u", user()), messageEntry("a", assistant())],
        { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 },
        () => 1,
      ),
    );
    expect(result?.messagesToSummarize[0].role).toBe("branchSummary");
    const custom: Entry = {
      type: "custom",
      id: "custom",
      parentId: null,
      seq: 1,
      timestamp: 0,
      customType: "note",
    };
    const ordinary = getOrThrow(
      prepareCompaction(
        [
          custom,
          messageEntry("old", user("old")),
          custom,
          messageEntry("old-assistant", assistant()),
          messageEntry("new", user("new")),
          custom,
        ],
        { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 },
        () => 1,
      ),
    );
    expect(ordinary?.messagesToSummarize).toEqual([user("old"), assistant()]);
    expect(ordinary?.retainedTail).toEqual([user("new")]);
    const split = getOrThrow(
      prepareCompaction(
        [
          messageEntry("old", user("old")),
          custom,
          messageEntry("assistant-1", assistant()),
          custom,
          messageEntry("assistant-2", assistant()),
        ],
        { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 },
        () => 1,
      ),
    );
    expect(split?.turnPrefixMessages).toEqual([user("old"), assistant()]);
  });
});

describe("vendored compaction generation boundaries", () => {
  it("isolates cache and cancellation options while retaining explicit request routing", () => {
    const controller = new AbortController();
    const scoped = withAbortSignal(controller.signal, context);
    const opts = createSummaryRequestOptions(
      { sessionId: "explicit", cacheRetention: "long" },
      scoped,
    );
    expect(opts).toMatchObject({
      sessionId: "explicit",
      cacheRetention: "none",
      signal: controller.signal,
    });
    const generated = createSummaryRequestOptions({}, context);
    expect(generated.sessionId).toBeTruthy();
    expect(generated.sessionId).not.toBe(createSummaryRequestOptions({}, context).sessionId);
  });

  it("keeps update instructions and caps output independently of model reasoning", async () => {
    const request = vi.fn<SummaryRequest>().mockResolvedValue(assistant());
    const options = {
      model: { ...model, maxTokens: 0, reasoning: false } as Model<string>,
      reserveTokens: 100,
      previousSummary: "old",
      customInstructions: "files",
      thinkingLevel: "high" as const,
    };
    expect(await generateSummaryWithRequest([user()], options, request, context)).toMatchObject({
      ok: true,
      value: { text: "summary" },
    });
    expect(request.mock.calls[0][1]).toMatchObject({ maxTokens: 80, cacheRetention: "none" });
    expect(request.mock.calls[0][1]).not.toHaveProperty("reasoning");
    expect(contentText(request.mock.calls[0][0].messages[0].content)).toContain(
      "<previous-summary>\nold\n</previous-summary>",
    );
    expect(contentText(request.mock.calls[0][0].messages[0].content)).toContain(
      "Additional focus: files",
    );
    await generateSummaryWithRequest(
      [user()],
      { ...options, model: { ...model, maxTokens: 7, reasoning: true }, thinkingLevel: "off" },
      request,
      context,
    );
    expect(request.mock.calls[1][1]).toMatchObject({ maxTokens: 7 });
    expect(request.mock.calls[1][1]).not.toHaveProperty("reasoning");
  });

  it("does not persist a partial split-turn summary when either provider request fails", async () => {
    for (const stopReason of ["aborted", "error"] as const) {
      for (const errorMessage of [undefined, "provider detail"]) {
        const failed = assistant({ stopReason, errorMessage });
        const first = vi.fn<SummaryRequest>().mockResolvedValue(failed);
        const history = await compactWithRequest(preparation(), { model }, first, context);
        expect(history).toMatchObject({
          ok: false,
          error: { code: stopReason === "aborted" ? "aborted" : "summarization_failed" },
        });
        expect(first).toHaveBeenCalledTimes(1);
        const second = vi
          .fn<SummaryRequest>()
          .mockResolvedValueOnce(assistant())
          .mockResolvedValueOnce(failed);
        const prefix = await compactWithRequest(preparation(), { model }, second, context);
        expect(prefix).toMatchObject({
          ok: false,
          error: {
            code: stopReason === "aborted" ? "aborted" : "summarization_failed",
            message: errorMessage
              ? stopReason === "error"
                ? "Turn prefix summarization failed: provider detail"
                : "provider detail"
              : stopReason === "error"
                ? "Turn prefix summarization failed: Unknown error"
                : "Turn prefix summarization aborted",
          },
        });
        expect(second).toHaveBeenCalledTimes(2);
      }
    }
  });

  it("sums both split-turn calls, or skips history without losing the retained suffix", async () => {
    const fileOps = createFileOps();
    fileOps.read.add("read");
    fileOps.written.add("write");
    const request = vi
      .fn<SummaryRequest>()
      .mockResolvedValueOnce(assistant({ content: [{ type: "text", text: "history summary" }] }))
      .mockResolvedValueOnce(assistant({ content: [{ type: "text", text: "prefix summary" }] }));
    const prep = preparation({ fileOps });
    const result = getOrThrow(
      await compactWithRequest(
        prep,
        { model: { ...model, reasoning: true }, thinkingLevel: "high" },
        request,
        context,
      ),
    );
    expect(result.summary).toBe(
      "history summary\n\n---\n\n**Turn Context (split turn):**\n\nprefix summary\n\n<read-files>\nread\n</read-files>\n\n<modified-files>\nwrite\n</modified-files>",
    );
    expect(result.usage?.input).toBe(20);
    expect(result.retainedTail).toBe(prep.retainedTail);
    expect(request.mock.calls[1][1]).toMatchObject({ maxTokens: 50, reasoning: "high" });
    const oneRequest = vi.fn<SummaryRequest>().mockResolvedValue(assistant());
    const noHistory = getOrThrow(
      await compactWithRequest(
        preparation({ messagesToSummarize: [] }),
        { model: { ...model, maxTokens: 0, reasoning: false } },
        oneRequest,
        context,
      ),
    );
    expect(noHistory.summary).toContain("No prior history.");
    expect(noHistory.usage?.input).toBe(10);
    expect(oneRequest).toHaveBeenCalledTimes(1);
    await compactWithRequest(
      preparation(),
      { model: { ...model, maxTokens: 2, reasoning: true }, thinkingLevel: "off" },
      oneRequest,
      context,
    );
    expect(oneRequest.mock.calls.at(-1)?.[1]).toMatchObject({ maxTokens: 2 });
    expect(oneRequest.mock.calls.at(-1)?.[1]).not.toHaveProperty("reasoning");
  });
});

describe("summary file-operation extraction and serialization", () => {
  it("ignores malformed legacy tool blocks and separates read-only from modified files", () => {
    const fileOps = createFileOps();
    for (const content of [
      undefined,
      "invalid",
      [
        null,
        false,
        {},
        { type: "text" },
        { type: "toolCall" },
        { type: "toolCall", name: "read", arguments: undefined },
        { type: "toolCall", name: "read", arguments: { path: 1 } },
        { type: "toolCall", name: "other", arguments: { path: "ignored" } },
        { type: "toolCall", name: "write", arguments: { path: "modified" } },
        { type: "toolCall", name: "edit", arguments: { path: "modified" } },
        { type: "toolCall", name: "read", arguments: { path: "read" } },
        { type: "toolCall", name: "read", arguments: { path: "modified" } },
      ],
    ]) {
      extractFileOpsFromMessage({ role: "assistant", content } as unknown as AgentMessage, fileOps);
    }
    expect(computeFileLists(fileOps)).toEqual({ readFiles: ["read"], modifiedFiles: ["modified"] });
    expect(formatFileOperations([], [])).toBe("");
    expect(formatFileOperations([], ["a"])).toBe("\n\n<modified-files>\na\n</modified-files>");
  });

  it("serializes useful text and tool arguments without crashing on cyclic values", () => {
    const cycle: Record<string, JsonValue> = {};
    cycle.self = cycle;
    const conversation = serializeConversation([
      { role: "user", content: [], timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: 0,
      },
      assistant({
        content: [
          {
            type: "toolCall",
            id: "1",
            name: "read",
            arguments: { cycle, absent: undefined as unknown as JsonValue },
          },
        ],
      }),
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(2001) }],
        isError: false,
        timestamp: 0,
      },
      { role: "system", content: "ignored", timestamp: 0 },
    ]);
    expect(conversation).toContain("read(cycle=[unserializable], absent=undefined)");
    expect(conversation).toContain("[... 1 more characters truncated]");
    expect(conversation).not.toContain("[User]");
    expect(conversation).not.toContain("ignored");
    expect(
      serializeConversation([
        assistant({
          content: [
            { type: "thinking", thinking: "reason" },
            { type: "text", text: "reply" },
          ],
        }),
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          isError: false,
          timestamp: 0,
          content: [{ type: "text", text: "short" }],
        },
      ]),
    ).toBe("[Assistant thinking]: reason\n\n[Assistant]: reply\n\n[Tool result]: short");
  });
});
