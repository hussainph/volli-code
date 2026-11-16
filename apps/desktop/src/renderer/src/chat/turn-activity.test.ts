import { describe, expect, it } from "vite-plus/test";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { ACTIVITY_METADATA_KEY, type ActivityKind } from "@volli/shared";
import {
  escalateTurnActivity,
  middleTruncatePayload,
  pickTurnActivityWord,
  selectTurnActivity,
  selectTurnExitKind,
  turnActivityHash,
  TURN_ACTIVITY_POOLS,
  type TurnActivityInput,
} from "./turn-activity";

const frame = (kind: string) => ({ event: { payload: { kind } } });

describe("turn exit from existing renderer frames", () => {
  it("distinguishes completion from local or remote interruption and resets on the next start", () => {
    expect(selectTurnExitKind([])).toBe("done");
    expect(
      selectTurnExitKind([frame("turn.started"), frame("turn.interrupted"), { event: null }]),
    ).toBe("abort");
    expect(selectTurnExitKind([frame("turn.interrupted"), frame("turn.started")])).toBe("done");
    expect(
      selectTurnExitKind([
        frame("turn.interrupted"),
        frame("turn.completed"),
        frame("usage.recorded"),
      ]),
    ).toBe("done");
  });
});

function tool(
  nativeToolName: string,
  args: unknown = {},
  options: {
    id?: string;
    kind?: ActivityKind;
    done?: boolean;
    preliminary?: boolean;
    label?: string;
  } = {},
): DynamicToolUIPart {
  const base = {
    type: "dynamic-tool" as const,
    toolName: "volli.activity",
    toolCallId: options.id ?? "call-1",
    toolMetadata: {
      [ACTIVITY_METADATA_KEY]: {
        kind: options.kind ?? "other",
        nativeToolName,
        subject: { label: options.label ?? null, path: null, lineRange: null },
        outcome: null,
        startedAt: 100,
        endedAt: options.done ? 200 : null,
      },
    },
    input: args,
  };
  return options.done || options.preliminary
    ? { ...base, state: "output-available", output: {}, preliminary: options.preliminary }
    : { ...base, state: "input-available" };
}

function input(parts: UIMessage["parts"] = []): TurnActivityInput {
  return {
    messages: [
      { id: "user", role: "user", parts: [{ type: "text", text: "go" }] },
      { id: "assistant", role: "assistant", parts },
    ],
    working: true,
    turnActive: true,
    projection: null,
    liveCompaction: null,
  };
}
function selected(part: DynamicToolUIPart) {
  return selectTurnActivity("session", input([part]))!;
}
function streaming(part: DynamicToolUIPart, args: unknown): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: part.toolName,
    toolCallId: part.toolCallId,
    toolMetadata: part.toolMetadata,
    state: "input-streaming",
    input: args,
  };
}

describe("activity vocabulary", () => {
  it("pins the approved pools rather than adding invented synonyms", () => {
    expect(TURN_ACTIVITY_POOLS.reason).toEqual([
      "Mulling",
      "Pondering",
      "Puzzling",
      "Weighing",
      "Musing",
      "Thinking",
    ]);
    expect(TURN_ACTIVITY_POOLS.read).toEqual([
      "Perusing",
      "Poring over",
      "Leafing through",
      "Studying",
      "Skimming",
      "Reading",
    ]);
    expect(TURN_ACTIVITY_POOLS.git).toEqual(["Committing", "Stashing", "Branching", "Pushing"]);
    expect(Object.keys(TURN_ACTIVITY_POOLS)).toHaveLength(19);
  });
  it("uses stable FNV-1a and defaults for idless events", () => {
    expect(turnActivityHash("hello")).toBe(0x4f9f2cab);
    expect(pickTurnActivityWord("reason")).toBe("Mulling");
    expect(pickTurnActivityWord("read", "toolu_010")).toBe("Skimming");
    const first = pickTurnActivityWord("read", "same-id");
    expect(pickTurnActivityWord("read", "same-id", first)).not.toBe(first);
    expect(pickTurnActivityWord("shot", "same-id", "Snapping")).toBe("Snapping");
    expect(pickTurnActivityWord("reason", undefined, "Mulling")).toBe("Mulling");
  });
  it("reconstructs repeat avoidance from call order without render cycling", () => {
    const first = "first";
    const collision = Array.from({ length: 100 }, (_, i) => `next-${i}`).find(
      (id) => pickTurnActivityWord("read", id) === pickTurnActivityWord("read", first),
    )!;
    const state = input([
      tool("read", { path: "a.ts" }, { id: first, done: true }),
      tool("read", { path: "b.ts" }, { id: collision }),
    ]);
    const result = selectTurnActivity("session", state)!;
    expect(result.word).not.toBe(pickTurnActivityWord("read", first));
    for (let i = 0; i < 5; i += 1) expect(selectTurnActivity("session", state)).toEqual(result);
    const replay = structuredClone(state);
    expect(selectTurnActivity("session", replay)).toEqual(result);
  });
});

describe("real tool activity projection", () => {
  it.each([
    ["read", { path: "src/a.ts" }, "read", "a.ts"],
    ["edit", { path: "src/a.ts" }, "edit", "a.ts"],
    ["write", { path: "src/new.ts" }, "write", "new.ts"],
    ["bash", { command: "pnpm test" }, "test", "pnpm test"],
    [
      "execute",
      { command: "pnpm -C apps/desktop run typecheck" },
      "build",
      "pnpm -C apps/desktop run typecheck",
    ],
    ["shell_start", { command: "npm ci" }, "install", "npm ci"],
    ["web_search", { query: "springs" }, "web", "springs"],
    ["web_fetch", { url: "https://example.com" }, "web", "https://example.com"],
    ["browser_navigate", { url: "http://localhost:5174" }, "browser", "http://localhost:5174"],
    ["browser_screenshot", { tabId: "tab-1" }, "shot", null],
    ["session_delegate", { title: "Explorer" }, "delegate", "Explorer"],
    ["session_await", {}, "awaitSub", null],
    ["ask_user", {}, "askUser", null],
    ["codemode", { code: "tools.read({path:'x'})" }, "code", null],
    ["unfamiliar_mcp_tool", {}, "run", "unfamiliar_mcp_tool"],
  ])("reads %s through the descriptor, not volli.activity", (name, args, activity, payload) => {
    const result = selected(tool(name, args));
    expect(result.activity).toBe(activity);
    expect(result.payload).toBe(payload);
    expect(result.waiting).toBe(activity === "askUser");
    expect(result.key).toBe("session:call:call-1");
  });
  it("accepts descriptor kinds with unfamiliar native names and missing legacy descriptors", () => {
    expect(selected(tool("legacy-reader", {}, { kind: "read-file", label: "a.ts" })).activity).toBe(
      "read",
    );
    expect(selected(tool("legacy-search", { pattern: "needle" }, { kind: "search" })).payload).toBe(
      "needle",
    );
    const legacy: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "old",
      state: "input-available",
      input: { path: "old.ts" },
    };
    expect(selected(legacy)).toMatchObject({ activity: "read", payload: "old.ts" });
  });
  it.each([
    ["vp test run a.test.ts", "test"],
    ["pnpm --filter @volli/desktop test", "test"],
    ["pnpm exec vitest run", "test"],
    ["pytest -q", "test"],
    ["cargo test", "test"],
    ["go build ./...", "build"],
    ["vp run --filter @volli/desktop typecheck", "build"],
    ["pnpm add zod", "install"],
    ["rg -n 'needle' src", "search"],
    ["echo 'pnpm test'", "run"],
    ["cat test.ts", "run"],
    ["git status; git commit -m x", "run"],
    ["echo x | pnpm test", "run"],
    ["bash -c 'git commit -m x'", "run"],
    ["git -C . status", "run"],
    ["git diff", "run"],
    ["git push --dry-run", "run"],
    ["git stash list", "run"],
    ["git branch --list", "run"],
    ["git checkout main", "run"],
  ])("classifies only known executable operations: %s", (command, activity) => {
    expect(selected(tool("bash", { command })).activity).toBe(activity);
  });
  it.each([
    ["git commit -m 'test and push'", "Committing"],
    ["git -C repo push origin main", "Pushing"],
    ["git stash push", "Stashing"],
    ["git switch -c new-branch", "Branching"],
    ["git branch new-branch", "Branching"],
  ])("does not hash Git into a different operation: %s", (command, word) => {
    expect(selected(tool("bash", { command }, { id: "any-hash" }))).toMatchObject({
      activity: "git",
      word,
    });
  });
  it("attaches prepositions to the selected word, not the activity", () => {
    const search = (id: string) =>
      selected(tool("search", { query: "needle" }, { kind: "search", id }));
    const candidates = Array.from({ length: 30 }, (_, i) => search(`s${i}`));
    expect(
      candidates.find((result) => result.word === "Tracking down")?.preposition,
    ).toBeUndefined();
    expect(candidates.find((result) => result.word === "Combing")).toMatchObject({
      preposition: "for",
      announcement: "Searching for needle",
    });
    const delegates = Array.from({ length: 30 }, (_, i) =>
      selected(tool("session_delegate", { title: "Explorer" }, { id: `d${i}` })),
    );
    expect(delegates.find((result) => result.word === "Enlisting")?.announcement).toBe(
      "Delegating to Explorer",
    );
    expect(delegates.find((result) => result.word === "Handing off")?.announcement).toBe(
      "Delegating to Explorer",
    );
  });
});

describe("current activity selection", () => {
  it("returns null when idle and never claims reasoning before output", () => {
    expect(selectTurnActivity("s", { ...input(), working: false, turnActive: false })).toBeNull();
    expect(selectTurnActivity("s", input())).toMatchObject({
      activity: "busy",
      word: "On it",
      payload: null,
    });
  });
  it("does not reopen a settled turn from a stale presentation snapshot", () => {
    expect(
      selectTurnActivity("s", {
        ...input(),
        working: false,
        turnActive: false,
        projection: { turnActive: true, interactions: { active: [] } },
      }),
    ).toBeNull();
  });
  it("does not revive tools from a previous user turn", () => {
    const state = input([tool("read", { path: "stale.ts" })]);
    state.messages = [
      ...state.messages,
      { id: "new-user", role: "user", parts: [{ type: "text", text: "again" }] },
    ];
    expect(selectTurnActivity("s", state)?.activity).toBe("busy");
  });
  it("keeps preliminary output live but stops claiming completed and failed tools run", () => {
    expect(selected(tool("read", { path: "a" }, { preliminary: true })).activity).toBe("read");
    expect(selected(tool("read", { path: "a" }, { done: true })).activity).toBe("busy");
    const failed: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "failed",
      state: "output-error",
      input: { command: "pnpm test" },
      errorText: "failed",
    };
    expect(selected(failed).activity).toBe("busy");
  });
  it("chooses the newest still-running parallel call, not a completed sibling", () => {
    expect(
      selectTurnActivity(
        "s",
        input([
          tool("read", { path: "still-running" }, { id: "one" }),
          tool("edit", { path: "done" }, { id: "two", done: true }),
        ]),
      )?.payload,
    ).toBe("still-running");
  });
  it.each([false, true])(
    "lets a settled duplicate call win over a stale overlay (result first: %s)",
    (resultFirst) => {
      const live = tool("read", { path: "settled.ts" }, { id: "duplicate" });
      const result = tool("read", { path: "settled.ts" }, { id: "duplicate", done: true });
      const duplicate = resultFirst ? [result, live] : [live, result];
      expect(selectTurnActivity("s", input(duplicate))?.activity).toBe("busy");
      expect(
        selectTurnActivity(
          "s",
          input([tool("read", { path: "still-running.ts" }, { id: "parallel" }), ...duplicate]),
        )?.payload,
      ).toBe("still-running.ts");
    },
  );
  it("does not leave earlier reasoning streaming when text follows it", () => {
    expect(
      selectTurnActivity(
        "s",
        input([
          { type: "reasoning", text: "old", state: "streaming" },
          { type: "text", text: "reply", state: "streaming" },
        ]),
      )?.activity,
    ).toBe("reply");
  });
  it("prioritizes an actual user interaction and compaction over transcript work", () => {
    const state = input([tool("read", { path: "a" })]);
    state.liveCompaction = { throughSequence: 42 };
    expect(selectTurnActivity("s", state)?.activity).toBe("compact");
    state.projection = {
      turnActive: true,
      interactions: { active: [{ id: "q", kind: "question" }] },
    };
    expect(selectTurnActivity("s", state)).toMatchObject({
      activity: "status",
      word: "Waiting for you",
      waiting: true,
      payload: null,
    });
  });
  it("prioritizes factual state over questions, queue, compaction and stale work", () => {
    const state = input([tool("read", { path: "stale.ts" })]);
    state.queue = [{ id: "follow-up" }];
    expect(selectTurnActivity("s", state)).toMatchObject({
      word: "Message queued",
      priority: true,
    });
    state.steeringIds = new Set(["follow-up"]);
    expect(selectTurnActivity("s", state)?.word).toBe("Sends after this step");
    state.steeringIds = new Set();
    state.queue = [{ id: "one" }, { id: "two" }];
    expect(selectTurnActivity("s", state)?.word).toBe("2 messages queued");
    state.queue = [...state.queue, { id: "steer", afterCurrentStep: true }];
    expect(selectTurnActivity("s", state)?.word).toBe("Sends after this step");
    state.projection = {
      turnActive: true,
      interactions: { active: [{ id: "p", kind: "permission" }] },
    };
    expect(selectTurnActivity("s", state)).toMatchObject({
      word: "Waiting for approval",
      waiting: true,
    });
    state.status = { key: "retry", label: "Reconnecting" };
    state.working = state.turnActive = false;
    expect(selectTurnActivity("s", state)).toMatchObject({
      word: "Reconnecting",
      announcement: "Reconnecting",
      priority: true,
    });
    state.status = { key: "fault", label: "Needs attention", detail: "Run stopped" };
    expect(selectTurnActivity("s", state)).toMatchObject({
      word: "Needs attention",
      payload: null,
      announcement: "Needs attention: Run stopped",
    });
  });
  it("ignores failed local sends and keeps completed background calls out of turn presence", () => {
    const state = {
      ...input([tool("shell_start", { command: "long task" }, { done: true })]),
      queue: [{ id: "unsent", localUnsent: true as const }],
    };
    expect(selectTurnActivity("s", state)?.activity).toBe("busy");
    state.working = state.turnActive = false;
    expect(selectTurnActivity("s", state)).toBeNull();
  });
  it("announces tool arguments only once they are available, never per streamed character", () => {
    const read = tool("read", { path: "a" });
    const announcements = ["a", "ab", "abc"].map(
      (path) => selected(streaming(read, { path })).announcement,
    );
    expect(announcements).toEqual(["Reading", "Reading", "Reading"]);
    expect(selected({ ...read, input: { path: "abc" } }).announcement).toBe("Reading abc");
    const command = tool("bash", { command: "git commit" });
    expect(selected(streaming(command, command.input))).toMatchObject({
      activity: "run",
      payload: null,
      announcement: "Running",
    });
    expect(selected(command).word).toBe("Committing");
    for (const name of ["browser_screenshot", "browser_navigate"]) {
      const part = streaming(tool(name), {});
      part.toolMetadata = {
        [ACTIVITY_METADATA_KEY]: {
          kind: "browse",
          nativeToolName: name,
          browse: {
            action: name === "browser_screenshot" ? "screenshot" : "open",
            url: "https://partial",
          },
        },
      };
      expect(selected(part).payload).toBeNull();
      const available = tool(name);
      available.toolMetadata = part.toolMetadata;
      expect(selected(available).payload).toBe("https://partial");
    }
  });
  it("escalates only command/reasoning without losing the full announcement", () => {
    const run = selected(tool("bash", { command: "long command" }));
    expect(escalateTurnActivity(run)).toMatchObject({
      word: "Still running",
      announcement: "Running long command",
      key: run.key,
    });
    const reason = selectTurnActivity(
      "s",
      input([{ type: "reasoning", text: "", state: "streaming" }]),
    )!;
    expect(escalateTurnActivity(reason).word).toBe("Deep in thought");
    const test = selected(tool("bash", { command: "pnpm test" }));
    expect(escalateTurnActivity(test)).toBe(test);
  });
});

describe("middle-truncated payloads", () => {
  it("preserves short values and fits an injected width budget", () => {
    expect(middleTruncatePayload("short", 8)).toBe("short");
    expect(middleTruncatePayload("apps/desktop/src/chat/turn-activity.ts", 18)).toBe(
      "apps/d…activity.ts",
    );
    const result = middleTruncatePayload("long/filename.ts", 10, (value) => value.length * 2);
    expect(result.length * 2).toBeLessThanOrEqual(10);
    expect(result).toContain("…");
  });
  it("handles tiny budgets and unicode without splitting surrogate pairs", () => {
    expect(middleTruncatePayload("abc", 0)).toBe("");
    expect(middleTruncatePayload("abc", 0.5)).toBe("");
    expect(middleTruncatePayload("abc", 1)).toBe("…");
    expect(middleTruncatePayload("😀😀😀😀😀", 3)).toBe("😀…😀");
  });
  it("measures a long payload logarithmically, not once per character", () => {
    const payload = `cat > /tmp/big.ts <<'EOF' ${"x".repeat(12_000)} EOF`;
    let measured = 0;
    const result = middleTruncatePayload(payload, 40, (value) => {
      measured += 1;
      return Array.from(value).length;
    });
    expect(Array.from(result)).toHaveLength(40);
    expect(result.startsWith("cat > /tmp/big")).toBe(true);
    expect(result.endsWith("x EOF")).toBe(true);
    expect(measured).toBeLessThanOrEqual(20);
  });
});
