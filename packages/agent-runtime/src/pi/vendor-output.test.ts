import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "./vendor/pi-harness/context";
import { AdaptivePublisher } from "./vendor/pi-harness/execution/adaptive-publisher";
import {
  applyShellOutputUpdate,
  OutputCapture,
  sanitizeShellOutput,
} from "./vendor/pi-harness/execution/output-capture";
import { executeShellWithCapture } from "./vendor/pi-harness/execution/shell-output";
import {
  err,
  ExecutionError,
  ok,
  type ExecutionEnv,
  type ShellOutputUpdate,
  type ShellOutputView,
} from "./vendor/pi-harness/types";
import {
  formatSize,
  truncateHead,
  truncateTail,
  utf8ByteLength,
} from "./vendor/pi-harness/utils/truncate";

const context = BACKGROUND_CONTEXT;
const output = (text: string): ShellOutputView => {
  const { content, ...truncation } = truncateTail(text);
  return { text: content, truncation };
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("adaptive shell output publication", () => {
  it("coalesces intermediate states, forces the final state, and stops after disposal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let state = "a";
    const published: string[] = [];
    const publisher = new AdaptivePublisher({
      snapshot: () => state,
      update: (before, after) => (before === after ? undefined : after),
      measure: (s) => s.length,
      publish: (s) => published.push(s),
      onError: () => {},
    });
    publisher.flush();
    publisher.markDirty();
    state = "ab";
    publisher.markDirty();
    publisher.flush();
    state = "abc";
    publisher.markDirty();
    expect(published).toEqual(["a"]);
    vi.advanceTimersByTime(100);
    expect(published).toEqual(["a", "abc"]);
    publisher.markDirty();
    publisher.flush(true);
    expect(published).toEqual(["a", "abc"]);
    state = "abcd";
    publisher.markDirty();
    publisher.flush(true);
    expect(published).toEqual(["a", "abc", "abcd"]);
    state = "lost";
    publisher.markDirty();
    publisher.dispose();
    publisher.markDirty();
    publisher.flush(true);
    publisher.dispose();
    vi.runAllTimers();
    expect(published).toEqual(["a", "abc", "abcd"]);
  });

  it("advances its baseline before a consumer throws and reports trailing publication errors", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let state = "a";
    const error = new Error("consumer failed");
    const onError = vi.fn();
    const update = vi.fn((before: string | undefined, after: string) =>
      after.slice(before?.length ?? 0),
    );
    const publisher = new AdaptivePublisher({
      snapshot: () => state,
      update,
      measure: () => 1,
      publish: () => {
        throw error;
      },
      onError,
      minIntervalMs: 10,
      targetBytesPerSecond: 1000,
    });
    expect(() => publisher.markDirty()).toThrow(error);
    state = "ab";
    publisher.markDirty();
    vi.advanceTimersByTime(10);
    expect(update).toHaveBeenLastCalledWith("a", "ab");
    expect(onError).toHaveBeenCalledWith(error);
    publisher.dispose();
  });

  it("bounds head and tail views without losing total counts or splitting UTF-8", () => {
    vi.useFakeTimers();
    for (const retain of ["head", "tail"] as const) {
      const updates: ShellOutputUpdate[] = [];
      const capture = new OutputCapture(
        { limits: { maxBytes: 8, maxLines: 2, retain }, spill: true },
        context,
        { onUpdate: (update) => updates.push(update), onError: () => {} },
      );
      capture.push(new Uint8Array([0xf0, 0x9f]));
      capture.push(new Uint8Array([0x98, 0x80]));
      capture.push("\nabc\n".repeat(12));
      capture.finish();
      capture.flush();
      const snapshot = capture.snapshot();
      expect(snapshot.text).not.toContain("�");
      expect(utf8ByteLength(snapshot.text)).toBeLessThanOrEqual(8);
      expect(snapshot.truncation).toMatchObject({
        totalBytes: 64,
        totalLines: 24,
        truncated: true,
        truncatedBy: "lines",
      });
      expect(
        updates.reduce<ShellOutputView | undefined>(applyShellOutputUpdate, undefined),
      ).toEqual(snapshot);
      capture.setSpillPath("/log");
      capture.setSpillPath("/log");
      expect(updates.at(-1)?.kind).toBe("metadata");
      expect(capture.snapshot().spillPath).toBe("/log");
      capture.dispose();
      const count = updates.length;
      capture.push("ignored");
      capture.finish();
      capture.flush();
      capture.setSpillPath("ignored");
      expect(updates).toHaveLength(count);
    }
  });

  it("publishes sliding windows as deltas and replaces unrelated windows", () => {
    vi.useFakeTimers();
    const updates: ShellOutputUpdate[] = [];
    const capture = new OutputCapture(
      { limits: { maxBytes: 6, maxLines: 1 }, spill: false },
      context,
      { onUpdate: (u) => updates.push(u), onError: () => {} },
    );
    capture.push("abcde");
    capture.flush();
    capture.push("fg");
    capture.flush();
    expect(updates.at(-1)).toMatchObject({ kind: "slide", drop: 1, text: "fg" });
    capture.push("uvwxyz");
    capture.flush();
    expect(updates.at(-1)?.kind).toBe("replace");
    expect(updates.reduce<ShellOutputView | undefined>(applyShellOutputUpdate, undefined)).toEqual(
      capture.snapshot(),
    );
    capture.dispose();
  });

  it("preserves bounded multi-byte partial lines and sanitizes only terminal control bytes", () => {
    const capture = new OutputCapture(
      { limits: { maxBytes: 5, maxLines: 2, retain: "tail" } },
      context,
      { onError: () => {} },
    );
    capture.push("abcdef😀");
    capture.flush();
    expect(capture.snapshot()).toMatchObject({
      text: "f😀",
      lastLineBytes: 10,
      truncation: { lastLinePartial: true, totalBytes: 10, truncatedBy: "bytes" },
    });
    capture.dispose();
    expect(sanitizeShellOutput("a\u0000\u0008\u000b\u001b\ufff9\ufffa\ufffbb\t\n\r")).toBe(
      "ab\t\n",
    );
    for (const limits of [
      { maxBytes: 0, maxLines: 2 },
      { maxBytes: Number.NaN, maxLines: 2 },
      { maxBytes: 5, maxLines: 0 },
      { maxBytes: 5, maxLines: 1.5 },
    ]) {
      expect(() => new OutputCapture({ limits }, context, { onError: () => {} })).toThrow(
        TypeError,
      );
    }
  });

  it("handles empty and repetitive window turnovers, including fractional byte guards", () => {
    vi.useFakeTimers();
    const defaults = new OutputCapture(undefined, context, { onError: () => {} });
    defaults.push("default");
    defaults.dispose();
    for (const [before, after, maxBytes] of [
      ["a", "😀", 3],
      ["a".repeat(19) + "b", "a".repeat(19) + "c", 20],
      ["abcde", "fg\nh", 6],
    ] as const) {
      const updates: ShellOutputUpdate[] = [];
      const capture = new OutputCapture({ limits: { maxBytes, maxLines: 1 } }, context, {
        onError: () => {},
        onUpdate: (u) => updates.push(u),
      });
      capture.push(before);
      capture.flush();
      capture.push(after);
      capture.flush();
      expect(
        updates.reduce<ShellOutputView | undefined>(applyShellOutputUpdate, undefined),
      ).toEqual(capture.snapshot());
      capture.dispose();
    }
    for (const retain of ["head", "tail"] as const) {
      for (const maxBytes of [1, 1.1]) {
        const capture = new OutputCapture({ limits: { maxBytes, maxLines: 2, retain } }, context, {
          onError: () => {},
        });
        capture.push("😀😀😀");
        capture.flush();
        expect(capture.snapshot().text).toBe("");
        capture.dispose();
      }
    }
  });

  it("rebuilds standalone metadata and sliding updates even if no initial view arrived", () => {
    const metadata = { truncation: output("").truncation };
    expect(applyShellOutputUpdate(undefined, { kind: "append", text: "new", metadata })).toEqual({
      text: "new",
      ...metadata,
    });
    expect(applyShellOutputUpdate(undefined, { kind: "metadata", metadata })).toEqual({
      text: "",
      ...metadata,
    });
    expect(
      applyShellOutputUpdate(undefined, { kind: "slide", drop: 2, text: "new", metadata }),
    ).toEqual({ text: "new", ...metadata });
  });

  it("collects incremental chunks without duplicating metadata or replacements and distinguishes errors from cancellation", async () => {
    const snapshots: string[] = [];
    const env = {
      exec: vi.fn(async (_command, options, currentContext) => {
        const first = output("first");
        options?.onUpdate?.(
          { kind: "replace", output: { ...first, spillPath: "/log" } },
          currentContext,
        );
        options?.onUpdate?.(
          { kind: "metadata", metadata: { truncation: first.truncation, spillPath: "/log" } },
          currentContext,
        );
        options?.onUpdate?.({ kind: "replace", output: output("replaced") }, currentContext);
        options?.onUpdate?.(
          {
            kind: "slide",
            drop: 1,
            text: "!",
            metadata: { truncation: output("eplaced!").truncation },
          },
          currentContext,
        );
        return err(new ExecutionError("spawn_error", "bad shell"));
      }),
    } as Pick<ExecutionEnv, "exec">;
    const result = await executeShellWithCapture(
      env as ExecutionEnv,
      "command",
      {
        onChunk: (chunk, getProgress) => snapshots.push(chunk, getProgress().output),
        returnExecutionErrors: true,
      },
      context,
    );
    expect(snapshots).toEqual(["first", "first", "!", "eplaced!"]);
    expect(result).toMatchObject({
      ok: true,
      value: { output: "eplaced!", cancelled: false, executionError: { code: "spawn_error" } },
    });
    expect(
      await executeShellWithCapture(env as ExecutionEnv, "command", undefined, context),
    ).toMatchObject({ ok: false, error: { code: "spawn_error" } });
    const aborted: Pick<ExecutionEnv, "exec"> = {
      exec: async () => err(new ExecutionError("aborted", "stop")),
    };
    expect(
      await executeShellWithCapture(aborted as ExecutionEnv, "command", undefined, context),
    ).toMatchObject({ ok: true, value: { cancelled: true, output: "", lastLineBytes: 0 } });
    const controller = new AbortController();
    controller.abort();
    expect(
      await executeShellWithCapture(
        env as ExecutionEnv,
        "command",
        undefined,
        withAbortSignal(controller.signal, context),
      ),
    ).toMatchObject({ ok: true, value: { cancelled: true } });
    const silent: Pick<ExecutionEnv, "exec"> = {
      exec: async () => ok({ exitCode: 0, truncation: output("").truncation }),
    };
    expect(
      await executeShellWithCapture(silent as ExecutionEnv, "command", undefined, context),
    ).toMatchObject({ ok: true, value: { cancelled: false, output: "" } });
  });
});

describe("UTF-8 tool-output truncation", () => {
  it("keeps whole head lines, exact byte boundaries and the correct limit metadata", () => {
    expect(truncateHead("").totalLines).toBe(0);
    expect(truncateHead("a\n").outputLines).toBe(1);
    expect(truncateHead("😀\na", { maxBytes: 3 })).toMatchObject({
      content: "",
      firstLineExceedsLimit: true,
      truncatedBy: "bytes",
    });
    expect(truncateHead("a\nbb\nc", { maxBytes: 3 })).toMatchObject({
      content: "a",
      truncatedBy: "bytes",
      outputBytes: 1,
    });
    expect(truncateHead("a\nbb\nc", { maxLines: 2 })).toMatchObject({
      content: "a\nbb",
      truncatedBy: "lines",
      outputBytes: 4,
    });
    expect(truncateHead("a\nbb", { maxBytes: 4 })).toMatchObject({
      content: "a\nbb",
      truncated: false,
    });
    expect(formatSize(1)).toBe("1B");
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(1024 * 1024)).toBe("1.0MB");
  });

  it("never emits half a UTF-8 codepoint and normalizes unpaired surrogate tails", () => {
    expect(truncateTail("a\nbb\nc", { maxBytes: 3 })).toMatchObject({
      content: "c",
      truncatedBy: "bytes",
    });
    expect(truncateTail("a\nbb\nc", { maxLines: 2 })).toMatchObject({
      content: "bb\nc",
      truncatedBy: "lines",
    });
    for (const [text, maxBytes, expected] of [
      ["x😀", 3, ""],
      ["xé", 2, "é"],
      ["x文", 3, "文"],
      ["x\ud800a", 4, "�a"],
      ["x\udc00a", 4, "�a"],
      ["x\ud800\ud800", 3, "�"],
      ["x😀", 0, ""],
      ["x😀\ud800", 7, "😀�"],
      ["x\ud800\ud800a", 7, "��a"],
    ] as const) {
      expect(truncateTail(text, { maxBytes }).content).toBe(expected);
    }
  });

  it("matches UTF-8 byte counts when the portable implementation runs without Buffer", async () => {
    vi.resetModules();
    vi.stubGlobal("Buffer", undefined);
    try {
      const portable = await import("./vendor/pi-harness/utils/truncate");
      for (const text of ["ASCII", "aé文😀b", "a\ud800x", "a\udc00x", "a\ud800"]) {
        expect(portable.utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
      }
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
