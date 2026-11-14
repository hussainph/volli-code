import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vite-plus/test";

const css = readFileSync(resolve(import.meta.dirname, "../../../globals.css"), "utf8");

it("fades bounded transcript pixels with one mask, leaving the thumb outside it", () => {
  const viewport = css
    .match(/\.chat-transcript \[data-conversation-viewport\] \{([^}]+)\}/)?.[1]
    ?.replace(/\s+/g, " ");
  expect(viewport).toContain("var(--composer-height, 0px)");
  // No second opaque lane: the scroll thumb is drawn at the document's end,
  // outside the viewport, so the viewport's mask cannot reach it (VC-1217).
  expect(viewport).not.toContain("linear-gradient(black, black)");
  expect(viewport).not.toContain("--scrollbar-size");
  expect(css).not.toContain("--scrollbar-size");
  expect(css).toContain(".chat-transcript [data-conversation-viewport][data-scroll-button]");
});
