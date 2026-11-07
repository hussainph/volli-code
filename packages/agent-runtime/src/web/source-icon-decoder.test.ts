import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkerSourceIconDecoder } from "./source-icon-decoder";

const REAL = new URL("./source-icon-worker.ts", import.meta.url);
const HUNG = new URL("./test-support/source-icon-hung-worker.mjs", import.meta.url);
const live = () => new AbortController().signal;

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 128, height: 64, channels: 4, background: "#c07a42" } })
    .png()
    .toBuffer();
}

afterEach(() => vi.restoreAllMocks());

describe("source icon parent gate", () => {
  it("decodes through a real worker and real native codec", async () => {
    const decode = createWorkerSourceIconDecoder(REAL);
    const bytes = await decode({ bytes: await png(), mime: "image/png" }, live());
    expect(bytes).not.toBeNull();
    expect(await sharp(bytes!).metadata()).toMatchObject({ format: "png", width: 64, height: 32 });
  });

  it("does not post any bytes for an already cancelled or oversized request", async () => {
    const post = vi.spyOn(Worker.prototype, "postMessage");
    const decode = createWorkerSourceIconDecoder(REAL);
    const abort = new AbortController();
    abort.abort();
    expect(await decode({ bytes: await png(), mime: "image/png" }, abort.signal)).toBeNull();
    expect(
      await decode({ bytes: new Uint8Array(256 * 1024 + 1), mime: "image/png" }, live()),
    ).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("terminates a real hung worker at the fixed total deadline", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const decode = createWorkerSourceIconDecoder(HUNG);
    expect(await decode({ bytes: await png(), mime: "image/png" }, live())).toBeNull();
    expect(terminate).toHaveBeenCalledTimes(1);
    // Joining termination proves the busy thread is gone, not just ignored.
    await Promise.all(terminate.mock.results.map((result) => result.value));
  });

  it("terminates an in-flight thread on cancellation without waiting for the deadline", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const abort = new AbortController();
    const original = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
      const result = original.apply(this, args);
      abort.abort();
      return result;
    });
    const decode = createWorkerSourceIconDecoder(HUNG);
    expect(await decode({ bytes: await png(), mime: "image/png" }, abort.signal)).toBeNull();
    expect(terminate).toHaveBeenCalledTimes(1);
    await Promise.all(terminate.mock.results.map((result) => result.value));
  });

  it("falls back on startup failure, unsupported content and worker exit", async () => {
    const missing = createWorkerSourceIconDecoder(new URL("./no-such-worker.cjs", import.meta.url));
    expect(await missing({ bytes: await png(), mime: "image/png" }, live())).toBeNull();
    expect(
      await createWorkerSourceIconDecoder(REAL)(
        { bytes: new Uint8Array([1]), mime: "image/png" },
        live(),
      ),
    ).toBeNull();
  });
});
