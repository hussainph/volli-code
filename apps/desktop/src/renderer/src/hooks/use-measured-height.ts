/**
 * Live height of a node, so a layout can be keyed to it instead of a constant.
 *
 * The Session plane's whole bottom-clearance contract runs through this: the
 * composer mount is measured, published as `--composer-height`, and the
 * transcript pads its bottom by it — so anything that grows inside that mount
 * (a queued-message strip, an ask-user card, the `/` and `@` pickers) pushes
 * the feed up instead of covering its last line. It lives here rather than
 * beside one consumer so the UI lab can exercise the same measurement the app
 * does, rather than a copy of it that can drift.
 */
import * as React from "react";

export function useMeasuredHeight<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  height: number;
} {
  const ref = React.useRef<T>(null);
  const [height, setHeight] = React.useState(0);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Border box, not `contentRect`: the content box drops the observed node's
      // own padding, and every consumer of this height would sit that far too
      // low — including the fade, whose opaque end would land below the
      // composer's hard top edge and slice a partly-visible line.
      setHeight(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, height };
}
