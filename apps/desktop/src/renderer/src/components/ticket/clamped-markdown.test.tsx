import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ClampedMarkdown } from "./clamped-markdown";

// The renderer test project runs under Node with no DOM, and dompurify only
// binds `sanitize` when a window exists. The clamp is the subject here, not
// sanitization (unconditional in `Markdown`, per its own contract), so the
// mock is the identity and the markdown pipeline downstream stays covered by
// the app's runtime use.
vi.mock("dompurify", () => ({ default: { sanitize: (raw: string) => raw } }));

/**
 * Static markup can only see the pre-measurement frame — the layout effect
 * that measures the content never runs under `react-dom/server`, so the toggle
 * and fade (which the measurement gates) are absent here. That frame is still
 * worth pinning: the markdown body itself must render, and nothing about the
 * clamp may touch content that has not been measured. The measurement-driven
 * branch (fade, toggle, cap style) is exercised by the policy tests and the
 * live surface; `clamp-policy.test.ts` pins the decision they feed on.
 */
describe("ClampedMarkdown", () => {
  it("renders the comment's markdown body", () => {
    const html = renderToStaticMarkup(
      <ClampedMarkdown source={"# Title\n\nbody paragraph with `code`"} />,
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("body paragraph with");
    expect(html).toContain("<code>code</code>");
  });

  it("applies no cap, fade, or toggle before measurement says it overflows", () => {
    const html = renderToStaticMarkup(<ClampedMarkdown source={"one short line"} />);
    expect(html).not.toContain("max-height");
    expect(html).not.toContain("maxHeight");
    expect(html).not.toContain("Show more");
    expect(html).not.toContain("gradient"); // the fade layer
  });
});
