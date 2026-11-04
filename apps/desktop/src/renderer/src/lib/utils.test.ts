import { describe, expect, it } from "vite-plus/test";

import { cn } from "./utils";

describe("cn", () => {
  it("keeps a type-scale token beside a text color", () => {
    // The bug this file exists for: tailwind-merge does not know the design
    // language's custom font-size tokens, so before they were registered as a
    // `font-size` classGroup it read `text-label` as a *color* and dropped it.
    expect(cn("text-label", "text-white")).toBe("text-label text-white");
    expect(cn("text-white", "text-ui")).toBe("text-white text-ui");
  });

  it("resolves --primary-text's utility as a color, not a size", () => {
    // `text-primary-text` is the one generated token whose name ends in a word
    // that could plausibly be read as a scale step, and it is registered
    // nowhere in cn(). It does not need to be: tailwind-merge's default
    // `text-color` group already claims it, which is exactly right — it must
    // override an earlier text color and must NOT displace a font size.
    expect(cn("text-primary", "text-primary-text")).toBe("text-primary-text");
    expect(cn("text-primary-text", "text-muted-foreground")).toBe("text-muted-foreground");
    expect(cn("text-ui", "text-primary-text")).toBe("text-ui text-primary-text");
    expect(cn("text-primary-text", "text-label")).toBe("text-primary-text text-label");
  });
});

describe("control token overrides", () => {
  it("merges control geometry with caller resets", () => {
    expect(cn("h-control-default", "h-auto")).toBe("h-auto");
    expect(cn("px-control-pad-default", "px-0")).toBe("px-0");
    expect(cn("size-control-sm", "size-4")).toBe("size-4");
  });

  it("drops the compound field's inner control shadow", () => {
    expect(cn("shadow-control", "shadow-none")).toBe("shadow-none");
    expect(cn("shadow-control-pressed", "shadow-raised")).toBe("shadow-raised");
  });
});
