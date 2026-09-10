import { describe, expect, it } from "vite-plus/test";

import { labelColor, labelNameKey } from "./label";
import type { Label } from "./label";
import { TAG_COLORS, tagColor } from "./tag-color";

describe("labelColor", () => {
  it("returns the stored color when set", () => {
    const label: Pick<Label, "name" | "color"> = { name: "bug", color: "#123456" };
    expect(labelColor(label)).toBe("#123456");
  });

  it("derives by hashing the name when color is null", () => {
    const label: Pick<Label, "name" | "color"> = { name: "bug", color: null };
    expect(labelColor(label)).toBe(tagColor("bug"));
  });

  it("the derived color is always one of TAG_COLORS", () => {
    expect(TAG_COLORS).toContain(labelColor({ name: "infra", color: null }));
  });

  it("an empty-string stored color is falsy-but-not-null and still wins over the hash", () => {
    // `??` only falls through on null/undefined, so an explicit (if odd)
    // empty-string color is honored rather than silently reinterpreted.
    expect(labelColor({ name: "bug", color: "" })).toBe("");
  });
});

describe("labelNameKey", () => {
  it("folds ASCII case to the expected stable key", () => {
    expect(labelNameKey("UI")).toBe("ui");
    expect(labelNameKey("ui")).toBe("ui");
    expect(labelNameKey("UX")).toBe("ux");
  });

  it("matches SQLite NOCASE at NUL and does not fold non-ASCII letters", () => {
    expect(labelNameKey("A\0x")).toBe(labelNameKey("a\0y"));
    expect(labelNameKey("Ü")).not.toBe(labelNameKey("ü"));
  });

  it("does not trim names as part of identity", () => {
    expect(labelNameKey(" ui")).not.toBe(labelNameKey("ui"));
    expect(labelNameKey("ui ")).not.toBe(labelNameKey("ui"));
  });
});
