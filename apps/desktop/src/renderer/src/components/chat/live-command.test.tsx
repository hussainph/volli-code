// @vitest-environment jsdom
import { ACTIVITY_METADATA_KEY, type ActivityDescriptor } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { commandOutputTail, useLiveCommand } from "./live-command";

function command(
  changes: Partial<DynamicToolUIPart> = {},
  descriptorChanges: Partial<ActivityDescriptor> = {},
): DynamicToolUIPart {
  const descriptor: ActivityDescriptor = {
    kind: "run-command",
    nativeToolName: "bash",
    subject: { label: "pnpm test", path: null, lineRange: null },
    startedAt: 8000,
    endedAt: null,
    outcome: null,
    ...descriptorChanges,
  };
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: "bash-1",
    state: "input-available",
    input: { command: "pnpm test" },
    toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"],
    ...changes,
  } as DynamicToolUIPart;
}

function output(value: unknown): DynamicToolUIPart {
  return command({ state: "output-available", output: value });
}

describe("commandOutputTail", () => {
  it("reads raw strings and host preliminary output evidence", () => {
    expect(commandOutputTail(output("  indented\nlast\n"))).toBe("  indented\nlast");
    expect(
      commandOutputTail(command({ input: { "volli.activity.output": "starting\nready" } })),
    ).toBe("starting\nready");
    expect(
      commandOutputTail(
        command({
          input: { "volli.activity.output": { content: [{ type: "text", text: "ready" }] } },
        }),
      ),
    ).toBe("ready");
  });

  it("extracts only text blocks, not images, details, or arbitrary JSON", () => {
    expect(
      commandOutputTail(
        output({
          content: [
            { type: "text", text: "first" },
            { type: "image", text: "not text", data: "secret bytes" },
            null,
            { type: "text", text: 42 },
            { type: "text", text: "second" },
          ],
          details: { text: "hidden" },
        }),
      ),
    ).toBe("first\nsecond");
    for (const value of [null, 42, ["text"], { text: "not a content block" }, { content: [] }]) {
      expect(commandOutputTail(output(value))).toBeNull();
    }
  });

  it("prefers explicit output, including empty output, over preliminary evidence", () => {
    const input = { "volli.activity.output": "stale" };
    expect(commandOutputTail(command({ state: "output-available", output: "final", input }))).toBe(
      "final",
    );
    expect(commandOutputTail(command({ state: "output-available", output: "", input }))).toBeNull();
  });

  it("returns null for absent and visually blank evidence", () => {
    expect(commandOutputTail(command())).toBeNull();
    for (const value of [
      "",
      " \n\r\t",
      "\u200b\u200d\ufeff",
      { content: [{ type: "text", text: "\n" }] },
    ]) {
      expect(commandOutputTail(output(value))).toBeNull();
    }
  });

  it("keeps the last twelve lines and no more than 4096 characters", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    expect(commandOutputTail(output(`${lines.join("\r\n")}\r\n`))).toBe(
      lines.slice(-12).join("\n"),
    );
    expect(commandOutputTail(output(`${"x".repeat(9000)}END`))).toBe(`${"x".repeat(4093)}END`);
    const extreme = commandOutputTail(
      output(Array.from({ length: 40 }, () => "x".repeat(1000)).join("\n")),
    )!;
    expect(extreme.length).toBeLessThanOrEqual(4096);
    expect(extreme.split("\n").length).toBeLessThanOrEqual(12);
  });
});

let root: Root;
let result: ReturnType<typeof useLiveCommand>;
function Probe({ part, enabled }: { part: DynamicToolUIPart; enabled?: boolean }) {
  result = useLiveCommand(part, enabled);
  return null;
}
function render(part: DynamicToolUIPart, enabled?: boolean) {
  act(() => root.render(<Probe part={part} enabled={enabled} />));
}
function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useLiveCommand", () => {
  it("uses the recorded start and the activity duration formatter while running", () => {
    render(command({ input: { "volli.activity.output": "ready" } }));
    expect(result).toEqual({ tail: "ready", elapsed: "2.0s" });
    expect(vi.getTimerCount()).toBe(1);
    advance(1000);
    expect(result.elapsed).toBe("3.0s");
    advance(60_000);
    expect(result.elapsed).toBe("1m3s");
  });

  it("also ticks preliminary output rows and updates their tail without resetting the clock", () => {
    render(command({ state: "output-available", preliminary: true, output: "first" }));
    advance(1000);
    render(command({ state: "output-available", preliminary: true, output: "first\nsecond" }));
    expect(result).toEqual({ tail: "first\nsecond", elapsed: "3.0s" });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("uses only observed live time when the recorded clock is missing", () => {
    render(command({}, { startedAt: null }));
    expect(result.elapsed).toBe("0ms");
    advance(2000);
    expect(result.elapsed).toBe("2.0s");
    render(command({}, { startedAt: 5000 }));
    expect(result.elapsed).toBe("7.0s");
  });

  it("does not measure disabled historical time, and resets an unrecorded live baseline on re-enable", () => {
    const part = command({}, { startedAt: null });
    render(part, false);
    expect(result.elapsed).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    advance(20_000);
    render(part);
    expect(result.elapsed).toBe("0ms");
    advance(2000);
    expect(result.elapsed).toBe("2.0s");
    render(part, false);
    expect(result.elapsed).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    advance(20_000);
    render(part);
    expect(result.elapsed).toBe("0ms");
  });

  it("never ticks pending, non-command, or settled rows; final meta remains the presenter's", () => {
    for (const part of [
      command({ state: "input-streaming", input: undefined }),
      command({}, { kind: "read-file" }),
      command({ state: "output-available", output: "finished" }, { endedAt: 9500 }),
      command({ state: "output-error", errorText: "failed" }),
      command({ state: "output-denied" }),
    ]) {
      render(part);
      expect(result.elapsed).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    }
    render(command({ state: "output-available", output: "finished" }, { startedAt: null }));
    expect(result).toEqual({ tail: "finished", elapsed: null });
    render(command({ input: { "volli.activity.output": "not a shell" } }, { kind: "read-file" }));
    expect(result).toEqual({ tail: null, elapsed: null });
  });

  it("stops the live timer immediately on settlement and unmount", () => {
    render(command());
    advance(1000);
    render(command({ state: "output-available", output: "finished" }, { endedAt: 11000 }));
    expect(result).toEqual({ tail: "finished", elapsed: null });
    expect(vi.getTimerCount()).toBe(0);
    advance(10_000);
    expect(result.elapsed).toBeNull();
    render(command());
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets observed time when row identity changes and clamps future clocks", () => {
    render(command({}, { startedAt: null }));
    advance(2000);
    render(command({ toolCallId: "bash-2" }, { startedAt: null }));
    expect(result.elapsed).toBe("0ms");
    render(command({}, { startedAt: 20_000 }));
    expect(result.elapsed).toBe("0ms");
  });
});
