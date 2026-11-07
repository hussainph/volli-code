// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

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

it("lets a keyboard inspect each context bucket without a hundred tab stops", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ContextUsagePill
          usage={{
            usedTokens: 30_000,
            contextWindow: 100_000,
            fraction: 0.3,
            segments: [
              { id: "system", label: "System", tokens: 10_000 },
              { id: "user", label: "You", tokens: 20_000 },
            ],
          }}
        />,
      ),
    );
    await act(async () => host.querySelector("button")?.click());
    const buckets = Array.from(
      document.querySelectorAll<HTMLElement>('[role="img"][tabindex="0"]'),
    );
    expect(buckets).toHaveLength(3);
    expect(buckets.map((bucket) => bucket.getAttribute("aria-label"))).toEqual([
      "System: ~10k · 10%",
      "You: ~20k · 20%",
      "Free: 70k · 70%",
    ]);
    await act(async () => buckets[1].focus());
    expect(document.activeElement).toBe(buckets[1]);
    expect(document.body.textContent).toContain("~20k · 20%");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
