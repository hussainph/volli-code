import { expect, it } from "vite-plus/test";
import { scrollEdgeMask } from "./scroll-edge-mask";
it("fades only the cut ends of source lists and virtual file trees", () => {
  expect(scrollEdgeMask({ atTop: true, atBottom: true })).toBeUndefined();
  expect(scrollEdgeMask({ atTop: true, atBottom: false })).toBe(
    "linear-gradient(to bottom, currentColor 0, currentColor calc(100% - 12px), transparent 100%)",
  );
  expect(scrollEdgeMask({ atTop: false, atBottom: true })).toBe(
    "linear-gradient(to bottom, transparent 0, currentColor 12px, currentColor 100%)",
  );
  expect(scrollEdgeMask({ atTop: false, atBottom: false })).toContain(
    "transparent 0, currentColor 12px",
  );
});
