/**
 * Auto-height is not a second Monaco layout driver. Only automaticLayout sizes
 * the view into the CSS-clamped host; we supply its desired (unclamped) height.
 *
 * Content-size events run inside Monaco's view-model dispatch, and can also
 * arrive during ResizeObserver delivery. Defer even the host write to a frame
 * so neither stack can synchronously re-wrap the editor through our callback.
 * The ports keep the scheduling/lifetime contract testable without Monaco/DOM.
 */
export function createDocumentHeightSync(ports: {
  getContentHeight(): number;
  setHeight(px: number): void;
  onContentHeightChange(px: number): void;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}): { schedule(): void; dispose(): void } {
  let frame: number | null = null;
  let disposed = false;
  let height: number | null = null;

  return {
    schedule() {
      if (disposed || frame !== null) return;
      frame = ports.requestFrame(() => {
        frame = null;
        if (disposed) return;
        const next = ports.getContentHeight();
        if (next === height) return;
        height = next;
        ports.setHeight(next);
        ports.onContentHeightChange(next);
      });
    },
    dispose() {
      disposed = true;
      if (frame !== null) ports.cancelFrame(frame);
      frame = null;
    },
  };
}
