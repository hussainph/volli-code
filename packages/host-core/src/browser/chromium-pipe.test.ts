/** The CDP pipe's framing and lifetime (VC-619), over in-memory streams. */
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vite-plus/test";

import {
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
});
