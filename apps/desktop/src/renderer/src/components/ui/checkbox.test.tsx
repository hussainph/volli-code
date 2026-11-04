import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Checkbox } from "./checkbox";

describe("Checkbox material", () => {
  it.each([false, true, "indeterminate"] as const)(
    "keeps a flat bordered box in state %s",
    (checked) => {
      const html = renderToStaticMarkup(<Checkbox checked={checked} aria-label="Include" />);
      expect(html).toContain('role="checkbox"');
      expect(html).toContain(`aria-checked="${checked === "indeterminate" ? "mixed" : checked}"`);
      expect(html).toContain("border-glass-edge");
      expect(html).not.toContain("shadow-");
      expect(html).toContain("data-[state=unchecked]:hover:bg-glass-2");
      expect(html).not.toContain("border-primary");
      expect(html).toContain("calc(var(--radius-control) / 2)");
    },
  );
});
