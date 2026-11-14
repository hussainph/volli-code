import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vite-plus/test";

const css = readFileSync(resolve(import.meta.dirname, "../../../globals.css"), "utf8");

it("fades bounded transcript pixels but keeps an opaque native scrollbar lane", () => {
  const viewport = css
    .match(/\.chat-transcript \[data-conversation-viewport\] \{([^}]+)\}/)?.[1]
    ?.replace(/\s+/g, " ");
  expect(viewport).toContain("var(--composer-height, 0px)");
  expect(viewport).toContain("linear-gradient(black, black)");
  expect(viewport).toContain("mask-size: 100% 100%, var(--scrollbar-size) 100%");
  expect(viewport).toContain("mask-position: center, right top");
  expect(viewport).toContain("mask-repeat: no-repeat");
  expect(viewport).toContain("mask-composite: add");
  const scrollbar = css.match(/\*::-webkit-scrollbar \{([^}]+)\}/)?.[1];
  expect(scrollbar).toContain("width: var(--scrollbar-size)");
  expect(css).toContain("--scrollbar-size: 10px");
  expect(css).toContain(".chat-transcript [data-conversation-viewport][data-scroll-button]");
});
