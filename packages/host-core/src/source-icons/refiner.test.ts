import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SourceIconCache } from "./cache";
import { SourceIconRefiner } from "./refiner";
import type { ReadSourceIconCandidate, SourceIconRaster } from "@volli/agent-runtime";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ZkAAAAASUVORK5CYII=",
  "base64",
);
const caches: SourceIconCache[] = [];
const refiners: SourceIconRefiner[] = [];
afterEach(() => {
  for (const refiner of refiners.splice(0)) refiner.close();
  for (const cache of caches.splice(0)) cache.close();
});
const candidate = (site = "one") => ({
  origin: `https://${site}.example.com`,
  url: `https://${site}.example.com/icon`,
});
const live = () => new AbortController().signal;

function fixture(acquire: ConstructorParameters<typeof SourceIconRefiner>[0]["acquire"]) {
  let owner: string | null = "owner-a";
  let now = 0;
  const cache = new SourceIconCache({ authorityForSession: () => owner });
  caches.push(cache);
  // Unit queue scheduling only. The separate live acquisition integration uses
  // the real pinned HTTP transport AND real one-second worker/codec.
  const decode = vi.fn(async () => Uint8Array.from(PNG));
  const refiner = new SourceIconRefiner({ cache, acquire, decode, log: vi.fn(), now: () => now });
  refiners.push(refiner);
  return {
    cache,
    refiner: {
      // Each unit admission represents its own foreground read.
      observe: (sessionId: string, icon: ReadSourceIconCandidate, signal: AbortSignal) =>
        refiner.beginRead(sessionId, signal)?.(icon, signal),
      beginRead: refiner.beginRead.bind(refiner),
      settled: refiner.settled.bind(refiner),
      close: () => refiner.close(),
    },
    decode,
    change: (value: string | null) => {
      owner = value;
    },
    advance: () => {
      now += 10 * 60 * 1000 + 1;
    },
  };
}

describe("bounded successful-read refinement queue", () => {
  it("returns synchronously, coalesces in-flight work and never overlaps acquisitions", async () => {
    const pending = Promise.withResolvers<SourceIconRaster | null>();
    const acquire = vi.fn(() => pending.promise);
    const f = fixture(acquire);
    for (let i = 0; i < 10; i++) f.refiner.observe("session", candidate(), live());
    expect(acquire).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    f.refiner.observe("session", candidate("two"), live());
    expect(acquire).toHaveBeenCalledTimes(1);
    pending.resolve({ bytes: PNG, mime: "image/png" });
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(2));
    expect(acquire).toHaveBeenCalledTimes(2);
    f.refiner.observe("session", candidate(), live());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquire).toHaveBeenCalledTimes(2); // held cache, no second network visit
  });

  it("holds at most 16 queued candidates beside the one active request", async () => {
    const pending = Promise.withResolvers<SourceIconRaster | null>();
    const acquire = vi.fn(() => pending.promise);
    const f = fixture(acquire);
    f.refiner.observe("session", candidate("first"), live());
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 100; i++) f.refiner.observe("session", candidate(`site${i}`), live());
    pending.resolve(null);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(17));
    expect(f.decode).not.toHaveBeenCalled();
  });

  it("bounds failures with a negative TTL, and a new successful read can retry only after it", async () => {
    const acquire = vi.fn(async () => null);
    const f = fixture(acquire);
    f.refiner.observe("session", candidate(), live());
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    f.refiner.observe("session", candidate(), live());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquire).toHaveBeenCalledTimes(1);
    f.advance();
    f.refiner.observe("session", candidate(), live());
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
  });

  it("retains only the newest 256 negative entries", async () => {
    const acquire = vi.fn(async () => null);
    const f = fixture(acquire);
    for (let i = 0; i < 257; i++) {
      f.refiner.observe("session", candidate(`site${i}`), live());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(acquire).toHaveBeenCalledTimes(257);
    f.refiner.observe("session", candidate("site256"), live());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquire).toHaveBeenCalledTimes(257);
    f.refiner.observe("session", candidate("site0"), live());
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(258));
  });

  it("discards results after account revocation and drops cancelled queued work", async () => {
    const pending = Promise.withResolvers<SourceIconRaster | null>();
    const acquire = vi.fn(() => pending.promise);
    const f = fixture(acquire);
    f.refiner.observe("session", candidate(), live());
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    const queued = new AbortController();
    f.refiner.observe("session", candidate("two"), queued.signal);
    queued.abort();
    f.change(null);
    pending.resolve({ bytes: PNG, mime: "image/png" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.decode).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(f.cache.grant("session")).toBeNull();
  });

  it("rejects a completion whose initiating read grant changed and captures fresh grants per read", async () => {
    const acquire = vi.fn(async () => ({ bytes: PNG, mime: "image/png" as const }));
    const f = fixture(acquire);
    const firstRead = f.refiner.beginRead("session", live())!;
    f.change("owner-b");
    firstRead(candidate(), live());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquire).not.toHaveBeenCalled();
    f.refiner.beginRead("session", live())!(candidate(), live());
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
  });

  it("keeps the queue and shutdown joined while physical decoder teardown is pending", async () => {
    const teardown = Promise.withResolvers<void>();
    const acquire = vi.fn(async () => ({ bytes: PNG, mime: "image/png" as const }));
    const f = fixture(acquire);
    Object.assign(f.decode, { settled: () => teardown.promise });
    f.refiner.observe("session", candidate(), live());
    f.refiner.observe("session", candidate("two"), live());
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquire).toHaveBeenCalledOnce();
    f.refiner.close();
    let settled = false;
    const closing = f.refiner.settled().then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    teardown.resolve();
    await closing;
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("aborts its active request and prevents all future work when closed", async () => {
    const pending = Promise.withResolvers<SourceIconRaster | null>();
    const acquire = vi.fn((_candidate: ReadSourceIconCandidate, signal: AbortSignal) => {
      signal.addEventListener("abort", () => pending.resolve(null), { once: true });
      return pending.promise;
    });
    const f = fixture(acquire);
    f.refiner.observe("session", candidate(), live());
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    f.refiner.close();
    f.refiner.observe("session", candidate("two"), live());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(f.decode).not.toHaveBeenCalled();
  });
});
