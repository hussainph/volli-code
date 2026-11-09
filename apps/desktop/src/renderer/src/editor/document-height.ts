/**
 * One layout driver for the auto-height document editor (whose Monaco
 * automaticLayout is disabled). After the initial mount, both content-size
 * dispatch and the pane's ResizeObserver only schedule a frame, never
 * synchronously re-enter Monaco.
 *
 * The desired host height and VC-99 notification are unclamped; the layout
 * uses the CSS-clamped box measured AFTER the height write. Ports keep this
 * scheduling/lifetime contract testable without Monaco or DOM.
 */
export function createDocumentLayout(ports: {
  getContentHeight(): number;
  setHeight(px: number): void;
  getHostSize(): { width: number; height: number };
  layout(size: { width: number; height: number }): void;
  isResizeActive(): boolean;
  onContentHeightChange(px: number): void;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}): { initialize(): void; schedule(): void; dispose(): void } {
  let frame: number | null = null;
  let disposed = false;
  let initialized = false;
  let height: number | null = null;
  let size: { width: number; height: number } | null = null;

  function fit(): void {
    // observePaneLayout schedules again when the resize transaction ends.
    if (disposed || ports.isResizeActive()) return;
    const next = ports.getContentHeight();
    const changed = next !== height;
    if (changed) {
      height = next;
      ports.setHeight(next);
    }
    const nextSize = ports.getHostSize();
    if (
      nextSize.width > 0 &&
      nextSize.height > 0 &&
      (size === null || nextSize.width !== size.width || nextSize.height !== size.height)
    ) {
      size = nextSize;
      ports.layout(nextSize);
    }
    if (changed && !disposed) ports.onContentHeightChange(next);
  }

  return {
    /** Mount only, outside Monaco dispatch: retain first-paint sizing/readiness. */
    initialize() {
      if (initialized) return;
      initialized = true;
      fit();
    },
    schedule() {
      if (disposed || frame !== null) return;
      frame = ports.requestFrame(() => {
        frame = null;
        fit();
      });
    },
    dispose() {
      disposed = true;
      if (frame !== null) ports.cancelFrame(frame);
      frame = null;
    },
  };
}
