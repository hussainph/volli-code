import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Button } from "./button";
import { Input } from "./input";
import { Segmented } from "./segmented";
import { Select, SelectTrigger, SelectValue } from "./select";
import { ControlShapeProvider, resolveControlShape, type ControlContext } from "./control-shape";

const contexts: ControlContext[] = ["toolbar", "content", "sheet", "popover", "sidebar"];
describe("contextual native border shape", () => {
  it("matches natural native context and size resolution without conflating material with size", () => {
    for (const context of contexts) {
      expect(resolveControlShape("auto", "default", context)).toBe("capsule");
      expect(resolveControlShape("auto", "icon", context)).toBe(
        context === "toolbar" ? "circle" : "capsule",
      );
      expect(resolveControlShape("auto", "sm", context)).toBe(
        context === "toolbar" || context === "sheet" ? "capsule" : "rounded",
      );
      expect(resolveControlShape("auto", "icon-sm", context)).toBe(
        context === "toolbar" ? "circle" : context === "sheet" ? "capsule" : "rounded",
      );
      for (const shape of ["rounded", "capsule", "circle"] as const)
        expect(resolveControlShape(shape, "lg", context)).toBe(shape);
      expect(resolveControlShape("auto", "mini", context, "search")).toBe("capsule");
      expect(resolveControlShape("auto", "lg", context, "field")).toBe(
        context === "toolbar" ? "capsule" : "rounded",
      );
      for (const kind of ["segmented", "popup"] as const) {
        expect(resolveControlShape("auto", "sm", context, kind)).toBe(
          context === "toolbar" ? "capsule" : "rounded",
        );
        expect(resolveControlShape("auto", "default", context, kind)).toBe("capsule");
      }
      expect(resolveControlShape("auto", "xs", context)).toBe(
        context === "toolbar" || context === "sheet" ? "capsule" : "rounded",
      );
    }
    expect(resolveControlShape("auto", null, "content")).toBe("rounded");
  });
  it("forwards the same explicit API through buttons, segmented controls, pop-ups and search", () => {
    for (const shape of ["rounded", "capsule", "circle"] as const) {
      const html = renderToStaticMarkup(
        <ControlShapeProvider context="sheet">
          <Button shape={shape} size="sm" disabled>
            Continue
          </Button>
          <Segmented
            shape={shape}
            ariaLabel="View"
            value="board"
            options={[
              { key: "board", label: "Board" },
              { key: "list", label: "List" },
            ]}
            onChange={() => {}}
          />
          <Select>
            <SelectTrigger shape={shape}>
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
          </Select>
          <Input shape={shape} variant="search" aria-label="Search" />
        </ControlShapeProvider>,
      );
      expect((html.match(new RegExp(`data-shape="${shape}"`, "g")) ?? []).length).toBe(6);
      expect(html).toContain('data-control-context="sheet"');
      expect(html).toContain('aria-label="Search"');
      expect(html).toContain("disabled");
      expect(html).not.toContain(` shape="${shape}"`);
    }
  });
});
