import { describe, expect, it, vi } from "vite-plus/test";

import {
  BROWSER_PICTURE_LIVE_LIMIT,
  BrowserPictureStore,
  type BrowserPictureRecord,
  type BrowserPictureStoreDependencies,
} from "./picture-store";

/**
 * One sink shared across store instances, which is the whole point: the
 * relaunch cases construct a SECOND store over the same disk, and a fake that
 * lived inside the store could never show that.
 */
function disk() {
  const files = new Map<string, { bytes: Uint8Array; record: BrowserPictureRecord }>();
  const persist = {
    write: vi.fn((bytes: Uint8Array, record: BrowserPictureRecord) => {
      files.set(record.id, { bytes, record });
    }),
    read: vi.fn((id: string) => {
      const held = files.get(id);
      return held === undefined ? null : { bytes: held.bytes, mime: held.record.mime };
    }),
    list: vi.fn((): readonly BrowserPictureRecord[] =>
      [...files.values()].map((one) => one.record),
    ),
    remove: vi.fn((id: string) => {
      files.delete(id);
    }),
  };
  return { files, persist };
}

function store(
  options: {
    persist?: ReturnType<typeof disk>["persist"] | null;
    now?: () => number;
    firstId?: number;
  } & Partial<Pick<BrowserPictureStoreDependencies, "persistLimit" | "persistMaxAgeMs">> = {},
): { pictures: BrowserPictureStore; persist: ReturnType<typeof disk>["persist"] } {
  let nextId = options.firstId ?? 0;
  // Always built, so the fixture's shape does not change with the option; only
  // WIRED when the case wants a store that can persist at all.
  const sink = options.persist ?? disk().persist;
  const pictures = new BrowserPictureStore({
    createId: () => `picture-${++nextId}`,
    now: options.now ?? (() => 1_000),
    ...(options.persist === null ? {} : { persist: sink }),
    ...(options.persistLimit === undefined ? {} : { persistLimit: options.persistLimit }),
    ...(options.persistMaxAgeMs === undefined ? {} : { persistMaxAgeMs: options.persistMaxAgeMs }),
  });
  return { pictures, persist: sink };
}

const jpeg = (label: string) => Buffer.from(label);

const shot = (over: Partial<Parameters<BrowserPictureStore["put"]>[0]> = {}) => ({
  tabId: "tab-1",
  generation: 0,
  mime: "image/jpeg" as const,
  bytes: jpeg("page"),
  ownerSessionId: "session-1",
  persist: false,
  ...over,
});

describe("BrowserPictureStore", () => {
  it("keeps the bytes in main and hands out an opaque reference the renderer resolves to a data URL", () => {
    const { pictures } = store();

    const id = pictures.put(shot({ generation: 3 }));

    expect(id).toBe("picture-1");
    expect(pictures.dataUrl(id)).toBe(`data:image/jpeg;base64,${jpeg("page").toString("base64")}`);
    expect(pictures.describe(id)).toEqual({
      id,
      tabId: "tab-1",
      generation: 3,
      capturedAt: 1_000,
      ownerSessionId: "session-1",
      mime: "image/jpeg",
    });
    expect(pictures.dataUrl("nothing")).toBeNull();
  });

  it("bounds the live set and forgets the oldest after-action capture first", () => {
    const { pictures } = store();
    const ids: string[] = [];
    for (let index = 0; index <= BROWSER_PICTURE_LIVE_LIMIT; index += 1) {
      ids.push(pictures.put(shot({ generation: index, bytes: jpeg(`frame-${index}`) })));
    }

    expect(pictures.dataUrl(ids[0]!)).toBeNull();
    expect(pictures.dataUrl(ids[1]!)).not.toBeNull();
    expect(pictures.dataUrl(ids.at(-1)!)).not.toBeNull();
  });

  it("writes a picture the model asked for to disk, with its owner, and reads it back after the live set forgot it", () => {
    const { pictures, persist } = store();
    const kept = pictures.put(shot({ mime: "image/png", bytes: jpeg("shot"), persist: true }));
    expect(persist.write).toHaveBeenCalledWith(
      jpeg("shot"),
      expect.objectContaining({ id: kept, ownerSessionId: "session-1", mime: "image/png" }),
    );

    for (let index = 0; index < BROWSER_PICTURE_LIVE_LIMIT; index += 1) {
      pictures.put(shot({ generation: index, bytes: jpeg("x") }));
    }

    expect(pictures.dataUrl(kept)).toBe(`data:image/png;base64,${jpeg("shot").toString("base64")}`);
    expect(persist.read).toHaveBeenCalledWith(kept);
  });

  it("resolves a persisted picture in a store that never minted it — the relaunch a transcript outlives", () => {
    const sink = disk().persist;
    const first = store({ persist: sink });
    const kept = first.pictures.put(
      shot({ mime: "image/png", bytes: jpeg("shot"), persist: true }),
    );
    const live = first.pictures.put(shot({ bytes: jpeg("after-action") }));

    // A new instance over the same directory: nothing of the first store's
    // memory survives, exactly as after an app relaunch.
    const relaunched = store({ persist: sink, firstId: 100 });

    expect(relaunched.pictures.dataUrl(kept)).toBe(
      `data:image/png;base64,${jpeg("shot").toString("base64")}`,
    );
    expect(relaunched.pictures.describe(kept)).toMatchObject({
      tabId: "tab-1",
      ownerSessionId: "session-1",
    });
    // The after-action capture was live-only and is honestly gone.
    expect(relaunched.pictures.dataUrl(live)).toBeNull();
  });

  it("sweeps persisted pictures past the count bound, newest kept, and forgets them from the index", () => {
    const sink = disk().persist;
    let clock = 1_000;
    const { pictures } = store({ persist: sink, persistLimit: 2, now: () => (clock += 10) });

    const oldest = pictures.put(shot({ mime: "image/png", persist: true }));
    const middle = pictures.put(shot({ mime: "image/png", persist: true }));
    const newest = pictures.put(shot({ mime: "image/png", persist: true }));

    expect(sink.remove).toHaveBeenCalledWith(oldest);
    expect(pictures.describe(oldest)).toBeNull();
    expect(pictures.dataUrl(oldest)).toBeNull();
    expect(pictures.dataUrl(middle)).not.toBeNull();
    expect(pictures.dataUrl(newest)).not.toBeNull();
  });

  it("sweeps persisted pictures past their age at the next launch, so nothing accumulates unowned", () => {
    const sink = disk().persist;
    const first = store({ persist: sink, now: () => 1_000, persistMaxAgeMs: 500 });
    const stale = first.pictures.put(shot({ mime: "image/png", persist: true }));

    const relaunched = store({
      persist: sink,
      firstId: 100,
      now: () => 5_000,
      persistMaxAgeMs: 500,
    });

    expect(sink.remove).toHaveBeenCalledWith(stale);
    expect(relaunched.pictures.dataUrl(stale)).toBeNull();
  });

  it("skips a sidecar the sink could not describe rather than failing the launch", () => {
    const sink = disk().persist;
    const first = store({ persist: sink });
    const kept = first.pictures.put(shot({ mime: "image/png", persist: true }));
    sink.list.mockReturnValueOnce([]);

    // Nothing in the index means nothing answers — and nothing throws.
    expect(store({ persist: sink, firstId: 100 }).pictures.dataUrl(kept)).toBeNull();
  });

  it("answers null for a persisted picture whose bytes the disk no longer has", () => {
    const { pictures, persist } = store();
    const kept = pictures.put(shot({ mime: "image/png", bytes: jpeg("shot"), persist: true }));
    // Out of the live set, so the read has to reach the sink to answer at all.
    for (let index = 0; index <= BROWSER_PICTURE_LIVE_LIMIT; index += 1) {
      pictures.put(shot({ generation: index }));
    }
    persist.read.mockReturnValue(null);

    expect(pictures.dataUrl(kept)).toBeNull();
    expect(persist.read).toHaveBeenCalledTimes(1);
  });

  it("never touches disk for a picture the live set still holds", () => {
    const { pictures, persist } = store();
    const live = pictures.put(shot({ bytes: jpeg("live") }));

    expect(pictures.dataUrl(live)).toBe(
      `data:image/jpeg;base64,${jpeg("live").toString("base64")}`,
    );
    expect(persist.read).not.toHaveBeenCalled();
  });

  it("refuses an id it did not mint before it could become a file name", () => {
    const { pictures, persist } = store();

    expect(pictures.dataUrl("../etc/passwd")).toBeNull();
    expect(persist.read).not.toHaveBeenCalled();
  });

  it("keeps a persist-less store honest: a persisted put is held live only", () => {
    const { pictures } = store({ persist: null });
    const id = pictures.put(shot({ mime: "image/png", persist: true }));

    expect(pictures.dataUrl(id)).not.toBeNull();
    for (let index = 0; index <= BROWSER_PICTURE_LIVE_LIMIT; index += 1) {
      pictures.put(shot({ generation: index }));
    }
    expect(pictures.dataUrl(id)).toBeNull();
  });
});
