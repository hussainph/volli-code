import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ContextUsagePill } from "./context-usage-ui";

// Exercise the private percent formatter through the pill's visible and
// accessible labels, without adding a test-only export.
describe("ContextUsagePill percentages", () => {
  it.each([
    [0, "0%"],
    [0.004, "<1%"],
    [0.01, "1%"],
    [0.99499, "99%"],
    [0.995, ">99%"],
    [0.996, ">99%"],
    [0.99999, ">99%"],
    [1, "100%"],
  ])("formats fraction %s as %s", (fraction, expected) => {
    const html = renderToStaticMarkup(
      <ContextUsagePill
        usage={{
          usedTokens: Math.round(fraction * 200_000),
          contextWindow: 200_000,
          fraction,
          segments: [],
        }}
      />,
    );
    const escaped = expected.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    expect(html).toContain(`(${escaped})`);
    expect(html).toContain(`>${escaped}</span>`);
  });
});
