import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Switch } from "./switch";

describe("Switch material", () => {
  it.each([false, true])("keeps a recessed track and lifted thumb when checked=%s", (checked) => {
    const html = renderToStaticMarkup(<Switch checked={checked} aria-label="Create more" />);
    const track = html.match(/<button[^>]*>/)?.[0] ?? "";
    const thumb = html.match(/<span[^>]*data-slot="switch-thumb"[^>]*>/)?.[0] ?? "";
    expect(track).toContain('role="switch"');
    expect(track).toContain(`aria-checked="${checked}"`);
    expect(track).toContain("shadow-control-pressed");
    expect(thumb).toContain("control-material");
    expect(thumb).toContain("shadow-control");
    expect(thumb).toContain("var(--control-light-paper)");
  });
});
