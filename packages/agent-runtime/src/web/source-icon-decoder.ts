/** One bounded background decode, using the host's shipped worker entry. */
import { Worker } from "node:worker_threads";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEADLINE_MS = 1_000;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ignored = (): void => {};

export interface SourceIconRaster {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg" | "image/webp";
}

/** The cache owns the cancellation signal; no caller can widen these limits. */
export type SourceIconDecoder = (
  input: SourceIconRaster,
  signal: AbortSignal,
) => Promise<Uint8Array | null>;

/** All outcomes are optional decoration. No worker error crosses into a tool. */
export function createWorkerSourceIconDecoder(entry: string | URL): SourceIconDecoder {
  return async (input, signal) => {
    if (
      signal.aborted ||
      input.bytes.byteLength === 0 ||
      input.bytes.byteLength > MAX_INPUT_BYTES
    ) {
      return null;
    }
    const started = performance.now();
    let worker: Worker;
    try {
      worker = new Worker(entry);
    } catch {
      return null;
    }
    return await new Promise<Uint8Array | null>((resolve) => {
      let finished = false;
      const finish = (bytes: Uint8Array | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        worker.removeListener("message", message);
        worker.removeListener("error", failed);
        worker.removeListener("exit", failed);
        // Keep a rejection observer until the thread is gone. A late startup
        // error must not become an unhandled EventEmitter error after abort.
        worker.on("error", ignored);
        void worker.terminate().catch(ignored);
        resolve(bytes);
      };
      const abort = (): void => finish(null);
      const failed = (): void => finish(null);
      const message = (answer: unknown): void => {
        if (signal.aborted || performance.now() - started >= DEADLINE_MS) return finish(null);
        if (answer === null || typeof answer !== "object" || Array.isArray(answer))
          return finish(null);
        const record = answer as Record<string, unknown>;
        const bytes = record.bytes;
        if (record.type !== "ready" || !(bytes instanceof Uint8Array)) return finish(null);
        if (bytes.byteLength < 33 || bytes.byteLength > MAX_OUTPUT_BYTES) return finish(null);
        const png = Buffer.from(bytes);
        if (!png.subarray(0, 8).equals(PNG) || png.toString("ascii", 12, 16) !== "IHDR")
          return finish(null);
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        if (width < 1 || width > 64 || height < 1 || height > 64) return finish(null);
        finish(Uint8Array.from(bytes));
      };
      const deadline = setTimeout(failed, Math.max(0, DEADLINE_MS - (performance.now() - started)));
      worker.once("message", message);
      worker.once("error", failed);
      worker.once("exit", failed);
      signal.addEventListener("abort", abort, { once: true });
      // An abort can precede listener installation; never post in that case.
      if (signal.aborted || performance.now() - started >= DEADLINE_MS) return finish(null);
      try {
        worker.postMessage({ bytes: Uint8Array.from(input.bytes), mime: input.mime }, []);
      } catch {
        finish(null);
      }
    });
  };
}
