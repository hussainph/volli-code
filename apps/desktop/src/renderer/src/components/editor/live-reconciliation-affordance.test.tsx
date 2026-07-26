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

  it("keeps unreadable-file errors visible beside an unsaved draft", () => {
    const html = renderToStaticMarkup(
      <LiveReconciliationAffordance
        kind="error"
        message="File was deleted on disk. Your unsaved draft is still open."
      />,
    );

    expect(html).toContain('data-testid="live-reconciliation-error"');
    expect(html).toContain("File was deleted on disk. Your unsaved draft is still open.");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Overwrite disk");
  });
});
