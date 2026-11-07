import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SourceIconsSnapshot } from "@volli/shared";
import { SourceIconCache } from "./cache";

// Cache tests exercise ownership/lifetime, not decoding. The decoder's separate
// real-worker suite proves that only a bounded PNG can enter this trusted sink.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ZkAAAAASUVORK5CYII=",
  "base64",
);
const caches: SourceIconCache[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();
  vi.useRealTimers();
});

function setup() {
  let epoch: string | null = "person-a/workspace-a/epoch-1";
  let now = 0;
  let id = 0;
  const cache = new SourceIconCache({
    authorityForSession: (sessionId) =>
      sessionId === "session" || sessionId === "other" ? epoch : null,
    now: () => now,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
  caches.push(cache);
  return {
    cache,
    epoch: () => epoch!,
    change: (value: string | null) => {
      epoch = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function observe(cache: SourceIconCache, origins = ["https://docs.example.co.uk"]) {
  const snapshots: SourceIconsSnapshot[] = [];
  const stop = cache.watch({ sessionId: "session", origins }, (snapshot) =>
    snapshots.push(snapshot),
  );
  return { snapshots, stop, latest: () => snapshots.at(-1)!.icons };
}

describe("separate source icon cache", () => {
  it("initially emits complete miss identities without any producer or network port", () => {
    const { cache } = setup();
    const { latest } = observe(cache, [
      "https://docs.example.co.uk",
      "https://project.github.io",
      "https://example.invalid",
    ]);
    expect(latest()).toEqual([
      { origin: "https://docs.example.co.uk", pictureId: null, registrableDomain: "example.co.uk" },
      {
        origin: "https://project.github.io",
        pictureId: null,
        registrableDomain: "project.github.io",
      },
      { origin: "https://example.invalid", pictureId: null, registrableDomain: null },
    ]);
  });

  it("publishes cache-ready identities and only serves bytes to the owning Session/epoch", () => {
    const { cache, epoch, change } = setup();
    const { latest } = observe(cache);
    const id = cache.put("session", epoch(), "https://docs.example.co.uk", PNG)!;
    expect(latest()[0]).toMatchObject({ pictureId: id, registrableDomain: "example.co.uk" });
    expect(cache.picture("session", id)).toMatchObject({
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });
    expect(cache.picture("other", id).data).toBeNull();
    expect(cache.picture("session", "../../anything").data).toBeNull();
    expect(cache.picture("session", id, 3).data).toBeNull();
    change("person-b/workspace-b/epoch-2");
    expect(cache.picture("session", id).data).toBeNull();
    cache.invalidate();
    expect(latest()[0]!.pictureId).toBeNull();
    // The old subscription cannot begin showing a different account's pixels.
    const next = cache.put("session", epoch(), "https://docs.example.co.uk", PNG)!;
    expect(next).not.toBe(id);
    expect(latest()[0]!.pictureId).toBeNull();
  });

  it("rejects a job finishing after revocation, including a same-account re-login", () => {
    const { cache, epoch, change } = setup();
    const old = epoch();
    change(null);
    expect(cache.put("session", old, "https://example.com", PNG)).toBeNull();
    change("person-a/workspace-a/epoch-2");
    expect(cache.put("session", old, "https://example.com", PNG)).toBeNull();
    expect(cache.put("missing-session", epoch(), "https://example.com", PNG)).toBeNull();
  });

  it("expires without refreshing TTL on a read, and removes every timer/listener on unsubscribe", () => {
    vi.useFakeTimers();
    const { cache, epoch, advance } = setup();
    const { latest, snapshots, stop } = observe(cache);
    const id = cache.put("session", epoch(), "https://docs.example.co.uk", PNG)!;
    advance(7 * 24 * 60 * 60 * 1000);
    vi.advanceTimersByTime(1000);
    expect(latest()[0]!.pictureId).toBeNull();
    expect(cache.picture("session", id).data).toBeNull();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    const count = snapshots.length;
    cache.put("session", epoch(), "https://docs.example.co.uk", PNG);
    vi.advanceTimersByTime(2000);
    expect(snapshots).toHaveLength(count);
  });

  it("evicts the oldest icon independently and preserves count/image bounds", () => {
    const { cache, epoch } = setup();
    const first = cache.put("session", epoch(), "https://first.example.com", PNG)!;
    for (let i = 0; i < 256; i++)
      cache.put("session", epoch(), `https://site${i}.example.com`, PNG);
    expect(cache.picture("session", first).data).toBeNull();
    expect(
      cache.put("session", epoch(), "https://example.com", new Uint8Array(64 * 1024 + 1)),
    ).toBeNull();
    expect(cache.put("session", epoch(), "https://example.com/path", PNG)).toBeNull();
    cache.close();
    expect(cache.picture("session", first).data).toBeNull();
    expect(cache.grant("session")).toBeNull();
  });

  it("bounds and validates subscriptions", () => {
    const { cache } = setup();
    expect(() => observe(cache, Array(33).fill("https://example.com"))).toThrow(
      "Invalid source origins",
    );
    expect(() => observe(cache, ["https://user:secret@example.com"])).toThrow(
      "Invalid source origins",
    );
    for (let i = 0; i < 128; i++) observe(cache);
    expect(() => observe(cache)).toThrow("unavailable");
  });
});
