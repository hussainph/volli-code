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

  it.each(["cancellation", "deadline"] as const)(
    "retains the physical slot after %s until delayed termination settles",
    async (reason) => {
      const gate = Promise.withResolvers<void>();
      const originalTerminate = Worker.prototype.terminate;
      const originalPost = Worker.prototype.postMessage;
      let abort = new AbortController();
      const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        ...args
      ) {
        const result = originalPost.apply(this, args);
        if (reason === "cancellation") abort.abort();
        return result;
      });
      const terminate = vi
        .spyOn(Worker.prototype, "terminate")
        .mockImplementation(function (this: Worker) {
          return gate.promise.then(() => originalTerminate.call(this));
        });
      const decode = createWorkerSourceIconDecoder(HUNG);
      const input = { bytes: await png(), mime: "image/png" as const };
      try {
        expect(await decode(input, abort.signal)).toBeNull();
        let settled = false;
        const settling = decode.settled!().then(() => {
          settled = true;
        });
        expect(await decode(input, live())).toBeNull();
        expect(post).toHaveBeenCalledTimes(1);
        expect(terminate).toHaveBeenCalledTimes(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        gate.resolve();
        await settling;
        abort = new AbortController();
        expect(await decode(input, abort.signal)).toBeNull();
        await decode.settled!();
        expect(post).toHaveBeenCalledTimes(2);
        expect(terminate).toHaveBeenCalledTimes(2);
      } finally {
        gate.resolve();
        await decode.settled!();
      }
    },
  );

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

const SCRIPTED = new URL("./test-support/source-icon-scripted-worker.mjs", import.meta.url);
const VALID_PNG_REPLY = 15;
// Explicit wire codes match the fixture; reordering cases cannot change their meaning.
it.each([
  { code: 0, scenario: "null reply" },
  { code: 1, scenario: "array reply" },
  { code: 2, scenario: "string reply" },
  { code: 3, scenario: "missing reply type" },
  { code: 4, scenario: "omitted reply" },
  { code: 5, scenario: "non-byte payload" },
  { code: 6, scenario: "empty byte payload" },
  { code: 7, scenario: "oversized byte payload" },
  { code: 8, scenario: "short PNG header" },
  { code: 9, scenario: "invalid PNG signature" },
  { code: 10, scenario: "missing IHDR marker" },
  { code: 11, scenario: "zero width" },
  { code: 12, scenario: "zero height" },
  { code: 13, scenario: "width above 64" },
  { code: 14, scenario: "height above 64" },
])("rejects worker reply $code: $scenario through the actual worker wire", async ({ code }) => {
  const decode = createWorkerSourceIconDecoder(SCRIPTED);
  expect(await decode({ bytes: new Uint8Array([code]), mime: "image/png" }, live())).toBeNull();
  await decode.settled!();
});
it("admits a real wire PNG while keeping synchronous startup/input faults local", async () => {
  const decode = createWorkerSourceIconDecoder(SCRIPTED);
  expect(await decode({ bytes: new Uint8Array(), mime: "image/png" }, live())).toBeNull();
  expect(
    await createWorkerSourceIconDecoder("invalid-relative-worker")(
      { bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" },
      live(),
    ),
  ).toBeNull();
  const bytes = await decode(
    { bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" },
    live(),
  );
  expect(await sharp(bytes!).metadata()).toMatchObject({ format: "png", width: 1, height: 1 });
  await decode.settled!();
});
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 2_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Capture actual threads before posting; cleanup never calls the mocked or
 * production teardown path, so a regression cannot leave a busy worker alive. */
function ownWorkers() {
  const workers: Worker[] = [];
  const once = Worker.prototype.once;
  const terminate = Worker.prototype.terminate;
  vi.spyOn(Worker.prototype, "once").mockImplementation(function (this: Worker, ...args) {
    if (!workers.includes(this)) workers.push(this);
    return once.apply(this, args);
  });
  return {
    workers,
    terminate,
    close: () =>
      bounded(
        Promise.all(workers.map((worker) => terminate.call(worker))),
        "independent worker cleanup",
      ),
  };
}

it("contains a synchronous post failure and still joins the actual thread", async () => {
  const owned = ownWorkers();
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(() => {
    throw new Error("post refused");
  });
  const decode = createWorkerSourceIconDecoder(HUNG);
  try {
    expect(
      await bounded(
        decode({ bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" }, live()),
        "post failure",
      ),
    ).toBeNull();
    await bounded(decode.settled!(), "production settlement");
  } finally {
    await owned.close();
  }
});
it.each(["throw", "reject"] as const)(
  "retains teardown observation when terminate %s fails",
  async (mode) => {
    const realTerminate = Worker.prototype.terminate;
    const workers: Worker[] = [];
    const originalPost = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
      workers.push(this);
      return originalPost.apply(this, args);
    });
    vi.spyOn(Worker.prototype, "terminate").mockImplementation(() => {
      if (mode === "throw") throw new Error("termination refused");
      return Promise.reject(new Error("termination rejected"));
    });
    const decode = createWorkerSourceIconDecoder(SCRIPTED);
    try {
      expect(
        await decode({ bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" }, live()),
      ).not.toBeNull();
      // A late worker error must have an observer even after logical completion.
      workers[0]!.emit("error", new Error("late worker failure"));
      await decode.settled!();
    } finally {
      await Promise.all(workers.map((worker) => realTerminate.call(worker)));
    }
  },
);
it("cancels during abort-listener installation, before posting", async () => {
  const owned = ownWorkers();
  const abort = new AbortController();
  const original = abort.signal.addEventListener.bind(abort.signal);
  vi.spyOn(abort.signal, "addEventListener").mockImplementation((...args) => {
    original(...args);
    abort.abort();
  });
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const decode = createWorkerSourceIconDecoder(HUNG);
  try {
    expect(
      await bounded(
        decode({ bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" }, abort.signal),
        "listener-install abort",
      ),
    ).toBeNull();
    expect(post).not.toHaveBeenCalled();
    await bounded(decode.settled!(), "production settlement");
  } finally {
    await owned.close();
  }
});
it("refuses a deadline already spent during worker setup", async () => {
  const owned = ownWorkers();
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1000);
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const decode = createWorkerSourceIconDecoder(HUNG);
  try {
    expect(
      await bounded(
        decode({ bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" }, live()),
        "setup deadline",
      ),
    ).toBeNull();
    expect(post).not.toHaveBeenCalled();
    await bounded(decode.settled!(), "production settlement");
  } finally {
    await owned.close();
  }
});
it("rejects a ready wire reply arriving at the total deadline", async () => {
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValue(1000);
  const decode = createWorkerSourceIconDecoder(SCRIPTED);
  expect(
    await decode({ bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" }, live()),
  ).toBeNull();
  await decode.settled!();
});
it("rejects a signal withdrawn before the wire callback observes it", async () => {
  const signal = live();
  vi.spyOn(signal, "aborted", "get")
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(false)
    .mockReturnValue(true);
  const decode = createWorkerSourceIconDecoder(SCRIPTED);
  expect(
    await decode({ bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" }, signal),
  ).toBeNull();
  await decode.settled!();
});
it("does not clear a newer physical lease when the older real thread exits first", async () => {
  const owned = ownWorkers();
  const releaseNewer = Promise.withResolvers<void>();
  vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
    return this === owned.workers[1]
      ? releaseNewer.promise.then(() => owned.terminate.call(this))
      : owned.terminate.call(this);
  });
  const decode = createWorkerSourceIconDecoder(SCRIPTED);
  const signal = live();
  let nested: Promise<Uint8Array | null> | undefined;
  vi.spyOn(signal, "aborted", "get")
    .mockImplementationOnce(() => {
      nested = decode({ bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" }, live());
      return false;
    })
    .mockReturnValue(false);
  try {
    const current = decode(
      { bytes: new Uint8Array([VALID_PNG_REPLY, 1]), mime: "image/png" },
      signal,
    );
    expect(owned.workers).toHaveLength(2);
    const olderExited = new Promise<void>((resolve) =>
      owned.workers[0]!.once("exit", () => resolve()),
    );
    expect(await bounded(nested!, "older logical result")).not.toBeNull();
    await bounded(olderExited, "older actual exit");
    expect(await bounded(current, "newer logical result")).not.toBeNull();
    let settled = false;
    const settling = decode.settled!().then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(owned.workers[1]!.threadId).toBeGreaterThan(0);
    expect(settled).toBe(false);
    expect(
      await bounded(
        decode({ bytes: new Uint8Array([VALID_PNG_REPLY]), mime: "image/png" }, live()),
        "busy physical lease",
      ),
    ).toBeNull();
    expect(owned.workers).toHaveLength(2);
    releaseNewer.resolve();
    await bounded(settling, "newer confirmed termination");
    expect(settled).toBe(true);
  } finally {
    releaseNewer.resolve();
    await owned.close();
  }
});
