import { renderToStaticMarkup } from "react-dom/server";
import type { ToasterProps } from "sonner";
import { describe, expect, it, vi } from "vite-plus/test";

import { Toaster } from "./sonner";

const captured = vi.hoisted(() => ({ props: null as ToasterProps | null }));
vi.mock("sonner", () => ({
  Toaster: (props: ToasterProps) => {
    captured.props = props;
    return null;
  },
}));
vi.mock("@renderer/lib/resolved-appearance", () => ({ useResolvedAppearance: () => "dark" }));

describe("Toaster", () => {
  it("resolves appearance and keeps description ink and action cursors semantic", () => {
    renderToStaticMarkup(
      <Toaster
        toastOptions={{ duration: 6000, classNames: { description: "custom-description" } }}
      />,
    );
    expect(captured.props?.theme).toBe("dark");
    expect(captured.props?.toastOptions?.classNames?.toast).toBe("material-floating");
    expect(captured.props?.toastOptions?.duration).toBe(6000);
    expect(captured.props?.toastOptions?.classNames?.description).toBe(
      "!text-muted-foreground custom-description",
    );
    for (const key of ["actionButton", "cancelButton", "closeButton"] as const) {
      expect(captured.props?.toastOptions?.classNames?.[key]).toContain("!cursor-default");
    }
  });

  it("retains state glyphs and stops the loading glyph under reduced motion", () => {
    renderToStaticMarkup(<Toaster />);
    expect(renderToStaticMarkup(<>{captured.props?.icons?.loading}</>)).toContain(
      "motion-reduce:animate-none",
    );
    for (const key of ["success", "error", "info", "warning"] as const) {
      expect(renderToStaticMarkup(<>{captured.props?.icons?.[key]}</>)).toContain("<svg");
    }
  });
});
