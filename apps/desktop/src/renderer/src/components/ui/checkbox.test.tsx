import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Checkbox } from "./checkbox";

describe("Checkbox material", () => {
  it.each([false, true, "indeterminate"] as const)(
    "retains a lifted perimeter in state %s",
    (checked) => {
      const html = renderToStaticMarkup(<Checkbox checked={checked} aria-label="Include" />);
      expect(html).toContain('role="checkbox"');
      expect(html).toContain(`aria-checked="${checked === "indeterminate" ? "mixed" : checked}"`);
      expect(html).toContain("control-material");
      expect(html).toContain("border-border-strong");
      expect(html).toContain("shadow-control");
      expect(html).not.toContain("border-primary");
      expect(html).toContain("calc(var(--radius-control) / 2)");
    },
  );
});
