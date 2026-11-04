import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Switch } from "./switch";

describe("Switch material", () => {
  it.each([false, true])("draws a flat track and thumb when checked=%s", (checked) => {
    const html = renderToStaticMarkup(<Switch checked={checked} aria-label="Create more" />);
    const track = html.match(/<button[^>]*>/)?.[0] ?? "";
    const thumb = html.match(/<span[^>]*data-slot="switch-thumb"[^>]*>/)?.[0] ?? "";
    expect(track).toContain('role="switch"');
    expect(track).toContain(`aria-checked="${checked}"`);
    expect(track).toContain("border-glass-edge");
    expect(track).not.toContain("shadow-");
    expect(track).not.toContain("control-material");
    expect(thumb).not.toContain("shadow-");
    expect(thumb).not.toContain("control-material");
    expect(thumb).toContain("var(--control-light-paper)");
  });
});
