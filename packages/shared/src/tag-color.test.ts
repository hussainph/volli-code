import { describe, expect, it } from "vite-plus/test";

import { TAG_COLORS, tagColor } from "./tag-color";

describe("tagColor", () => {
  it("is deterministic for the same tag", () => {
    expect(tagColor("terminal")).toBe(tagColor("terminal"));
  });

  it("matches known FNV-1a mappings", () => {
    expect(tagColor("terminal")).toBe(TAG_COLORS[1]);
    expect(tagColor("board")).toBe(TAG_COLORS[3]);
    expect(tagColor("infra")).toBe(TAG_COLORS[5]);
    expect(tagColor("bug")).toBe(TAG_COLORS[5]);
    expect(tagColor("agent")).toBe(TAG_COLORS[6]);
    expect(tagColor("design")).toBe(TAG_COLORS[7]);
  });

  it("gives distinct colors to demo-board co-occurring tag pairs", () => {
    expect(tagColor("board")).not.toBe(tagColor("infra"));
    expect(tagColor("agent")).not.toBe(tagColor("infra"));
    expect(tagColor("board")).not.toBe(tagColor("design"));
    expect(tagColor("terminal")).not.toBe(tagColor("bug"));
    expect(tagColor("terminal")).not.toBe(tagColor("infra"));
  });

  it("handles an empty string without throwing", () => {
    expect(TAG_COLORS).toContain(tagColor(""));
  });

  it("handles a non-ASCII tag without throwing", () => {
    expect(TAG_COLORS).toContain(tagColor("日本語"));
  });
});
