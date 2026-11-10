import { describe, expect, it, vi } from "vite-plus/test";

import { createDocumentLayout } from "./document-height";

function fixture() {
  let contentHeight = 800;
  let nextId = 0;
  const frames = new Map<number, () => void>();
  const setHeight = vi.fn<(px: number) => void>();
  const onContentHeightChange = vi.fn<(px: number) => void>();
  const getContentHeight = vi.fn(() => contentHeight);
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  let hostSize = { width: 600, height: 384 };
  let resizing = false;
  const layout = vi.fn<(size: { width: number; height: number }) => void>();
  const sync = createDocumentLayout({
    getContentHeight,
    setHeight,
    getHostSize: () => hostSize,
    layout,
    isResizeActive: () => resizing,
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
    layout,
    hostSize: (width: number, height: number) => (hostSize = { width, height }),
    resizing: (value: boolean) => (resizing = value),
    contentHeight: (px: number) => (contentHeight = px),
    flush() {
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id);
      callback();
    },
  };
}

describe("deferred document layout (Monaco automaticLayout is disabled)", () => {
  it("fits once at mount outside dispatch, before readiness, then defers layout notifications", () => {
    const f = fixture();
    f.layout.mockImplementationOnce(() => f.sync.schedule());
    f.sync.initialize();
    f.sync.initialize();
    expect(f.setHeight).toHaveBeenCalledExactlyOnceWith(800);
    expect(f.layout).toHaveBeenCalledExactlyOnceWith({ width: 600, height: 384 });
    expect(f.onContentHeightChange).toHaveBeenCalledExactlyOnceWith(800);
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.layout).toHaveBeenCalledTimes(1);
  });

  it("coalesces Monaco's burst and reads the latest height outside its event stack", () => {
    const f = fixture();
    f.sync.schedule(); // a deferred content-size notification
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
    f.hostSize(600, 28); // initial CSS min-height, before the desired height write
    let actualHostHeight = 0;
    f.setHeight.mockImplementation((px) => {
      actualHostHeight = Math.min(cssCap, px);
      f.hostSize(600, actualHostHeight);
    });
    for (const height of [800, 1200, 72, 0]) {
      f.contentHeight(height);
      f.sync.schedule();
      f.flush();
      expect(actualHostHeight).toBe(Math.min(cssCap, height));
      expect(f.onContentHeightChange).toHaveBeenLastCalledWith(height);
      if (height > 0) {
        expect(f.layout).toHaveBeenLastCalledWith({
          width: 600,
          height: Math.min(cssCap, height),
        });
      }
    }
  });

  it("does not rewrite the observed host or re-notify for unchanged height", () => {
    const f = fixture();
    f.sync.schedule();
    f.flush();
    // A width-only change, a cap toggle or our own height write can notify
    // again. Only a changed CSS box should reach Monaco's layout().
    f.sync.schedule();
    f.flush();
    expect(f.setHeight).toHaveBeenCalledTimes(1);
    expect(f.onContentHeightChange).toHaveBeenCalledTimes(1);
    expect(f.layout).toHaveBeenCalledTimes(1);
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

  it("lays out width and cap changes even when content height is unchanged", () => {
    const f = fixture();
    f.sync.schedule();
    f.flush();
    f.hostSize(500, 384);
    f.sync.schedule();
    f.flush();
    f.hostSize(500, 800); // Expand removes the ticket-body cap
    f.sync.schedule();
    f.flush();
    expect(f.layout.mock.calls).toEqual([
      [{ width: 600, height: 384 }],
      [{ width: 500, height: 384 }],
      [{ width: 500, height: 800 }],
    ]);
    expect(f.setHeight).toHaveBeenCalledTimes(1);
  });

  it("lets a re-wrap's new content height settle on the next frame, never recursively", () => {
    const f = fixture();
    f.layout.mockImplementationOnce(() => {
      f.contentHeight(1100);
      f.sync.schedule();
      expect(f.layout).toHaveBeenCalledTimes(1);
    });
    f.sync.schedule();
    f.flush();
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.setHeight.mock.calls).toEqual([[800], [1100]]);
    expect(f.layout).toHaveBeenCalledTimes(1); // same clamped box
    expect(f.onContentHeightChange).toHaveBeenLastCalledWith(1100);
  });

  it("waits for the pane resize to settle even if a frame was already queued", () => {
    const f = fixture();
    f.sync.schedule();
    f.resizing(true);
    f.flush();
    expect(f.getContentHeight).not.toHaveBeenCalled();
    expect(f.layout).not.toHaveBeenCalled();
    f.resizing(false);
    f.sync.schedule(); // observePaneLayout's settled notification
    f.flush();
    expect(f.layout).toHaveBeenCalledTimes(1);
  });

  it("does not lay out a hidden/empty box and recovers when it becomes visible", () => {
    const f = fixture();
    f.hostSize(0, 384);
    f.sync.schedule();
    f.flush();
    f.hostSize(600, 0);
    f.sync.schedule();
    f.flush();
    expect(f.layout).not.toHaveBeenCalled();
    f.hostSize(600, 384);
    f.sync.schedule();
    f.flush();
    expect(f.layout).toHaveBeenCalledExactlyOnceWith({ width: 600, height: 384 });
  });

  it("cancels pending mount/work on teardown and ignores even an already queued callback", () => {
    const f = fixture();
    f.sync.schedule();
    const callback = [...f.frames.values()][0]!;
    f.sync.dispose();
    expect(f.cancelFrame).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.frames.size).toBe(0);
    callback();
    f.sync.initialize();
    f.sync.schedule();
    f.sync.dispose();
    expect(f.frames.size).toBe(0);
    expect(f.getContentHeight).not.toHaveBeenCalled();
    expect(f.setHeight).not.toHaveBeenCalled();
    expect(f.onContentHeightChange).not.toHaveBeenCalled();
  });

  it("does not report height after a synchronous teardown during layout", () => {
    const f = fixture();
    f.layout.mockImplementationOnce(() => f.sync.dispose());
    f.sync.initialize();
    expect(f.onContentHeightChange).not.toHaveBeenCalled();
    expect(f.frames.size).toBe(0);
  });

  it("can dispose after a completed frame without cancelling unrelated work", () => {
    const f = fixture();
    f.sync.schedule();
    f.flush();
    f.sync.dispose();
    expect(f.cancelFrame).not.toHaveBeenCalled();
  });
});
