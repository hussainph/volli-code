/** The CDP pipe's framing and lifetime (VC-619), over in-memory streams. */
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  CdpBackpressureError,
  CdpCommandAbandonedError,
  CdpConnectionClosedError,
  CdpPipeConnection,
  CdpProtocolError,
  type CdpEvent,
} from "./chromium-pipe";

function wire(): { connection: CdpPipeConnection; toBrowser: string[]; fromBrowser: PassThrough } {
  const output = new PassThrough();
  const fromBrowser = new PassThrough();
  const toBrowser: string[] = [];
  output.on("data", (chunk: Buffer) => toBrowser.push(chunk.toString("utf8")));
  return { connection: new CdpPipeConnection(output, fromBrowser), toBrowser, fromBrowser };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("CdpPipeConnection", () => {
  it("frames each command as NUL-terminated JSON, with its flattened session", async () => {
    const { connection, toBrowser } = wire();
    void connection.send("Page.enable", {}, "session-1");
    void connection.send("Browser.getVersion");
    await flush();
    expect(toBrowser.join("")).toBe(
      `${JSON.stringify({ id: 1, method: "Page.enable", params: {}, sessionId: "session-1" })}\0${JSON.stringify({ id: 2, method: "Browser.getVersion", params: {} })}\0`,
    );
  });

  it("answers by id across frames split over chunks, and several frames in one", async () => {
    const { connection, fromBrowser } = wire();
    const first = connection.send("A.one");
    const second = connection.send("A.two");
    const frame = `${JSON.stringify({ id: 2, result: { two: true } })}\0`;
    fromBrowser.write(frame.slice(0, 5));
    fromBrowser.write(frame.slice(5) + `${JSON.stringify({ id: 1, result: { one: true } })}\0`);
    await expect(second).resolves.toEqual({ two: true });
    await expect(first).resolves.toEqual({ one: true });
  });

  it("rejects a command the browser refused, naming the method", async () => {
    const { connection, fromBrowser } = wire();
    const sent = connection.send("Target.closeTarget");
    fromBrowser.write(
      `${JSON.stringify({ id: 1, error: { code: -32000, message: "No target" } })}\0`,
    );
    const error = await sent.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CdpProtocolError);
    expect((error as CdpProtocolError).message).toBe("Target.closeTarget: No target");
  });

  it("fans events out in order, a throwing listener notwithstanding", async () => {
    const { connection, fromBrowser } = wire();
    const seen: CdpEvent[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    connection.onEvent(() => {
      throw new Error("listener bug");
    });
    const unsubscribe = connection.onEvent((event) => seen.push(event));
    fromBrowser.write(
      `${JSON.stringify({ method: "Page.frameStartedLoading", params: { frameId: "f" }, sessionId: "s" })}\0${JSON.stringify({ method: "Target.targetCreated" })}\0`,
    );
    await flush();
    expect(seen).toEqual([
      { method: "Page.frameStartedLoading", params: { frameId: "f" }, sessionId: "s" },
      { method: "Target.targetCreated", params: {} },
    ]);
    unsubscribe();
    fromBrowser.write(`${JSON.stringify({ method: "After" })}\0`);
    await flush();
    expect(seen).toHaveLength(2);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("closes on a frame that is not JSON, rejecting what waits and refusing what follows", async () => {
    const { connection, fromBrowser } = wire();
    const reasons: string[] = [];
    connection.onClose((reason) => reasons.push(reason));
    const pending = connection.send("A.waiting");
    fromBrowser.write("not json\0");
    await expect(pending).rejects.toBeInstanceOf(CdpConnectionClosedError);
    expect(connection.closed).toBe(true);
    expect(reasons).toEqual(["the browser sent a frame that is not JSON"]);
    await expect(connection.send("A.after")).rejects.toThrow(/not JSON/);
    connection.onClose((reason) => reasons.push(`late: ${reason}`));
    expect(reasons).toHaveLength(2);
  });

  it("closes when the browser's end of the pipe does", async () => {
    const { connection, fromBrowser } = wire();
    const pending = connection.send("A.waiting");
    fromBrowser.destroy();
    await expect(pending).rejects.toThrow(/closed its pipe/);
  });

  it("ignores an answer to a command it never sent, and a non-object frame closes it", async () => {
    const { connection, fromBrowser } = wire();
    fromBrowser.write(`${JSON.stringify({ id: 99, result: {} })}\0`);
    await flush();
    expect(connection.closed).toBe(false);
    fromBrowser.write("42\0");
    await flush();
    expect(connection.closed).toBe(true);
  });

  it("closes on an unterminated frame past its byte bound, rather than buffering it (B2)", async () => {
    const output = new PassThrough();
    const fromBrowser = new PassThrough();
    const connection = new CdpPipeConnection(output, fromBrowser, { maxInboundFrameBytes: 1_024 });
    const pending = connection.send("Page.captureScreenshot");
    for (let i = 0; i < 4; i += 1) fromBrowser.write("x".repeat(400));
    await expect(pending).rejects.toThrow(/larger than the pipe accepts/);
    expect(connection.closed).toBe(true);
  });

  it("closes on a terminated frame past its byte bound too", async () => {
    const output = new PassThrough();
    const fromBrowser = new PassThrough();
    const connection = new CdpPipeConnection(output, fromBrowser, { maxInboundFrameBytes: 1_024 });
    fromBrowser.write("y".repeat(600));
    fromBrowser.write(`${"y".repeat(600)}\0`);
    await flush();
    expect(connection.closed).toBe(true);
  });

  it("refuses sends past its output bound when the browser stops reading (B2)", async () => {
    const fromBrowser = new PassThrough();
    // A writer that never drains: nothing it was given is ever consumed.
    const stalled = new Writable({ highWaterMark: 16, write: () => undefined });
    const connection = new CdpPipeConnection(stalled, fromBrowser, {
      maxQueuedOutputBytes: 64 * 1_024,
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 1_000 }, () =>
        Promise.race([
          connection.send("Runtime.evaluate", { expression: "x".repeat(1_000) }),
          flush().then(() => "waiting"),
        ]),
      ),
    );
    const refused = outcomes.filter(
      (outcome) => outcome.status === "rejected" && outcome.reason instanceof CdpBackpressureError,
    );
    expect(refused.length).toBeGreaterThan(900);
    expect(stalled.writableLength).toBeLessThanOrEqual(64 * 1_024);
    expect(connection.pendingCount).toBe(1_000 - refused.length);
    connection.close();
    expect(connection.pendingCount).toBe(0);
  });

  it("refuses sends past its pending-command bound", async () => {
    const { connection } = wire();
    const bounded = new CdpPipeConnection(new PassThrough(), new PassThrough(), {
      maxPendingCommands: 2,
    });
    void bounded.send("A.one").catch(() => undefined);
    void bounded.send("A.two").catch(() => undefined);
    await expect(bounded.send("A.three")).rejects.toBeInstanceOf(CdpBackpressureError);
    bounded.close();
    connection.close();
  });

  it("abandons a command past its deadline or on withdrawal, leaving the pending map (B2)", async () => {
    const { connection, fromBrowser } = wire();
    const timed = connection.send("Page.getNavigationHistory", {}, undefined, { timeoutMs: 10 });
    await expect(timed).rejects.toBeInstanceOf(CdpCommandAbandonedError);
    expect(connection.pendingCount).toBe(0);
    // Its late answer is an unknown id, ignored.
    fromBrowser.write(`${JSON.stringify({ id: 1, result: {} })}\0`);
    await flush();
    expect(connection.closed).toBe(false);

    const controller = new AbortController();
    const withdrawn = connection.send("Page.getNavigationHistory", {}, undefined, {
      signal: controller.signal,
    });
    expect(connection.pendingCount).toBe(1);
    controller.abort();
    await expect(withdrawn).rejects.toThrow(/withdrawn/);
    expect(connection.pendingCount).toBe(0);
    await expect(
      connection.send("A.late", {}, undefined, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CdpCommandAbandonedError);
  });

  it("lets a close listener unsubscribe (B3)", () => {
    const { connection } = wire();
    const heard: string[] = [];
    const unsubscribe = connection.onClose((reason) => heard.push(reason));
    expect(connection.closeListenerCount).toBe(1);
    unsubscribe();
    expect(connection.closeListenerCount).toBe(0);
    connection.close("done");
    expect(heard).toEqual([]);
  });

  it("holds a finely fragmented frame in one buffer, not a view per fragment", async () => {
    const { connection, fromBrowser } = wire();
    const answered = connection.send("A.big");
    const body = JSON.stringify({ id: 1, result: { pad: "z".repeat(50_000) } });
    for (const byte of body) fromBrowser.write(byte);
    await flush();
    // About twice the bytes held at most, however many fragments carried them.
    expect(connection.inboundCapacity).toBeLessThanOrEqual(2 * body.length);
    fromBrowser.write("\0");
    await expect(answered).resolves.toEqual({ pad: "z".repeat(50_000) });
  });
});
