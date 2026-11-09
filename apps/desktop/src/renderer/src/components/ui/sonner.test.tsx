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
    expect(captured.props?.position).toBe("bottom-right");
    expect(captured.props?.gap).toBe(6);
    expect(captured.props?.style).toMatchObject({ "--border-radius": "var(--radius-menu)" });
    expect(captured.props?.toastOptions?.classNames?.toast).toContain("material-floating");
    expect(captured.props?.toastOptions?.duration).toBe(6000);
    expect(captured.props?.toastOptions?.classNames?.description).toBe(
      "!text-muted-foreground custom-description",
    );
    for (const key of ["actionButton", "cancelButton", "closeButton"] as const) {
      expect(captured.props?.toastOptions?.classNames?.[key]).toContain("!cursor-default");
    }
  });

  it("reserves expanded ::after for Sonner's transparent hover bridge, not the glass rim", () => {
    renderToStaticMarkup(<Toaster toastOptions={{ classNames: { toast: "custom-toast" } }} />);
    const classes = captured.props?.toastOptions?.classNames?.toast;
    expect(classes).toContain("custom-toast");
    // Keep the real toast skin/border and do not clip the gap bridge or close
    // button. Hiding ::after would remove Sonner's hover continuity.
    expect(classes).toContain("material-floating !contain-none");
    for (const utility of [
      "bg-none",
      "mask-none",
      "p-0",
      "rounded-none",
      "top-auto",
      "pointer-events-auto",
    ]) {
      expect(classes).toContain(`data-[expanded=true]:after:!${utility}`);
    }
    expect(classes).not.toMatch(/after:!?hidden|border-0|after:!?content-none/);
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
