import { describe, expect, it, vi } from "vite-plus/test";

import { BROWSER_PICTURE_LIVE_LIMIT, BrowserPictureStore } from "./picture-store";

function store(options: { persist?: boolean } = {}) {
  let nextId = 0;
  const disk = new Map<string, { bytes: Uint8Array; mime: string }>();
  const persist = {
    write: vi.fn((id: string, bytes: Uint8Array, mime: string) => {
      disk.set(id, { bytes, mime });
    }),
    read: vi.fn((id: string) => disk.get(id) ?? null),
  };
  const pictures = new BrowserPictureStore({
    createId: () => `picture-${++nextId}`,
    now: () => 1_000,
    ...(options.persist === false ? {} : { persist }),
  });
  return { pictures, persist, disk };
}

const jpeg = (label: string) => Buffer.from(label);

describe("BrowserPictureStore", () => {
  it("keeps the bytes in main and hands out an opaque reference the renderer resolves to a data URL", () => {
    const { pictures } = store();

    const id = pictures.put({
      tabId: "tab-1",
      generation: 3,
      mime: "image/jpeg",
      bytes: jpeg("page"),
      persist: false,
    });

    expect(id).toBe("picture-1");
    expect(pictures.dataUrl(id)).toBe(`data:image/jpeg;base64,${jpeg("page").toString("base64")}`);
    expect(pictures.describe(id)).toEqual({ tabId: "tab-1", generation: 3, capturedAt: 1_000 });
    expect(pictures.dataUrl("nothing")).toBeNull();
  });

  it("bounds the live set and forgets the oldest after-action capture first", () => {
    const { pictures } = store();
    const ids: string[] = [];
    for (let index = 0; index <= BROWSER_PICTURE_LIVE_LIMIT; index += 1) {
      ids.push(
        pictures.put({
          tabId: "tab-1",
          generation: index,
          mime: "image/jpeg",
          bytes: jpeg(`frame-${index}`),
          persist: false,
        }),
      );
    }

    expect(pictures.dataUrl(ids[0]!)).toBeNull();
    expect(pictures.dataUrl(ids[1]!)).not.toBeNull();
    expect(pictures.dataUrl(ids.at(-1)!)).not.toBeNull();
  });

  it("writes a picture the model asked for to disk and reads it back after the live set forgot it", () => {
    const { pictures, persist } = store();
    const kept = pictures.put({
      tabId: "tab-1",
      generation: 0,
      mime: "image/png",
      bytes: jpeg("shot"),
      persist: true,
    });
    expect(persist.write).toHaveBeenCalledWith(kept, jpeg("shot"), "image/png");

    for (let index = 0; index < BROWSER_PICTURE_LIVE_LIMIT; index += 1) {
      pictures.put({
        tabId: "tab-1",
        generation: index,
        mime: "image/jpeg",
        bytes: jpeg("x"),
        persist: false,
      });
    }

    expect(pictures.dataUrl(kept)).toBe(`data:image/png;base64,${jpeg("shot").toString("base64")}`);
    expect(persist.read).toHaveBeenCalledWith(kept);
  });

  it("answers null for a persisted picture the disk no longer has, and never touches disk for live ones", () => {
    const { pictures, persist, disk } = store();
    const kept = pictures.put({
      tabId: "tab-1",
      generation: 0,
      mime: "image/png",
      bytes: jpeg("shot"),
      persist: true,
    });
    const live = pictures.put({
      tabId: "tab-1",
      generation: 0,
      mime: "image/jpeg",
      bytes: jpeg("live"),
      persist: false,
    });
    pictures.forgetLive();
    disk.clear();

    expect(pictures.dataUrl(kept)).toBeNull();
    expect(pictures.dataUrl(live)).toBeNull();
    expect(persist.read).toHaveBeenCalledTimes(1);
  });

  it("refuses an id it did not mint before it could become a file name", () => {
    const { pictures, persist } = store();

    expect(pictures.dataUrl("../etc/passwd")).toBeNull();
    expect(persist.read).not.toHaveBeenCalled();
  });

  it("keeps a persist-less store honest: a persisted put is held live only", () => {
    const { pictures } = store({ persist: false });
    const id = pictures.put({
      tabId: "tab-1",
      generation: 0,
      mime: "image/png",
      bytes: jpeg("shot"),
      persist: true,
    });

    expect(pictures.dataUrl(id)).not.toBeNull();
    pictures.forgetLive();
    expect(pictures.dataUrl(id)).toBeNull();
  });
});
