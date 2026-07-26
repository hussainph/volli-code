import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { LiveReconciliationAffordance } from "./live-reconciliation-affordance";

describe("LiveReconciliationAffordance", () => {
  it("offers explicit non-modal conflict consequences without vague reload copy", () => {
    const html = renderToStaticMarkup(
      <LiveReconciliationAffordance
        kind="conflict"
        onUseDisk={vi.fn()}
        onOverwriteDisk={vi.fn()}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Your draft and the newer disk version were both preserved.");
    expect(html).toContain("Use disk and discard draft");
    expect(html).toContain("Overwrite disk with draft");
    expect(html).not.toContain("Reload");
    expect(html).not.toContain('role="dialog"');
  });
});
