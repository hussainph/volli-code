import { describe, expect, it, vi } from "vite-plus/test";

import { createDocumentHeightSync } from "./document-height";

function fixture() {
  let contentHeight = 800;
  let nextId = 0;
  const frames = new Map<number, () => void>();
  const setHeight = vi.fn<(px: number) => void>();
  const onContentHeightChange = vi.fn<(px: number) => void>();
  const getContentHeight = vi.fn(() => contentHeight);
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  const sync = createDocumentHeightSync({
    getContentHeight,
    setHeight,
    onContentHeightChange,
    requestFrame: (callback) => {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelFrame,
  });
  return {
    sync,
    frames,
    getContentHeight,
    setHeight,
    onContentHeightChange,
    cancelFrame,
    contentHeight: (px: number) => (contentHeight = px),
    flush() {
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id);
      callback();
    },
  };
}

describe("document auto-height (automaticLayout is the sole layout driver)", () => {
  it("coalesces Monaco's burst and reads the latest height outside its event stack", () => {
    const f = fixture();
    f.sync.schedule(); // mount
    f.sync.schedule(); // content-size notification
    f.contentHeight(960); // a second wrap update before the frame
    f.sync.schedule();
    expect(f.frames.size).toBe(1);
    expect(f.getContentHeight).not.toHaveBeenCalled();
    expect(f.setHeight).not.toHaveBeenCalled();
    expect(f.onContentHeightChange).not.toHaveBeenCalled();

    f.flush();
    expect(f.setHeight).toHaveBeenCalledExactlyOnceWith(960);
    expect(f.onContentHeightChange).toHaveBeenCalledExactlyOnceWith(960);
  });

  it("reports unclamped height while CSS owns the actual host box, then grows and shrinks", () => {
    const f = fixture();
    const cssCap = 384;
    let actualHostHeight = 0;
    f.setHeight.mockImplementation((px) => (actualHostHeight = Math.min(cssCap, px)));
    for (const height of [800, 1200, 72, 0]) {
      f.contentHeight(height);
      f.sync.schedule();
      f.flush();
      expect(actualHostHeight).toBe(Math.min(cssCap, height));
      expect(f.onContentHeightChange).toHaveBeenLastCalledWith(height);
    }
  });

  it("does not rewrite the observed host or re-notify for unchanged height", () => {
    const f = fixture();
    f.sync.schedule();
    f.flush();
    // A width-only change, a cap toggle or our own height write can notify
    // again. Monaco's automaticLayout owns those sizes, not this callback.
    f.sync.schedule();
    f.flush();
    expect(f.setHeight).toHaveBeenCalledTimes(1);
    expect(f.onContentHeightChange).toHaveBeenCalledTimes(1);
    expect(f.frames.size).toBe(0);
  });

  it("defers a notification re-entered from a height write to another frame", () => {
    const f = fixture();
    f.setHeight.mockImplementationOnce(() => {
      f.contentHeight(900);
      f.sync.schedule();
      expect(f.setHeight).toHaveBeenCalledTimes(1);
    });
    f.sync.schedule();
    f.flush();
    expect(f.frames.size).toBe(1);
    expect(f.onContentHeightChange).toHaveBeenCalledExactlyOnceWith(800);
    f.flush();
    expect(f.setHeight.mock.calls).toEqual([[800], [900]]);
    expect(f.onContentHeightChange).toHaveBeenLastCalledWith(900);
    expect(f.frames.size).toBe(0);
  });

  it("cancels pending mount/work on teardown and ignores even an already queued callback", () => {
    const f = fixture();
    f.sync.schedule();
    const callback = [...f.frames.values()][0]!;
    f.sync.dispose();
    expect(f.cancelFrame).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.frames.size).toBe(0);
    callback();
    f.sync.schedule();
    f.sync.dispose();
    expect(f.frames.size).toBe(0);
    expect(f.getContentHeight).not.toHaveBeenCalled();
    expect(f.setHeight).not.toHaveBeenCalled();
    expect(f.onContentHeightChange).not.toHaveBeenCalled();
  });

  it("can dispose after a completed frame without cancelling unrelated work", () => {
    const f = fixture();
    f.sync.schedule();
    f.flush();
    f.sync.dispose();
    expect(f.cancelFrame).not.toHaveBeenCalled();
  });
});
