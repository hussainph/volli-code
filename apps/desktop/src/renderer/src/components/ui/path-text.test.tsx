import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { PathText } from "./path-text";

describe("PathText", () => {
  it("offers a break after every separator and nowhere inside a name", () => {
    const html = renderToStaticMarkup(<PathText path="/Users/me/code/kintsugi" />);
    expect(html).toContain("/<wbr/>Users/<wbr/>me/<wbr/>code/<wbr/>kintsugi");
    expect(html).not.toMatch(/kin<wbr|<wbr\/?>tsugi/);
  });

  it("keeps the path's text exact and a name without separators whole", () => {
    expect(renderToStaticMarkup(<PathText path="kintsugi" />)).toContain(">kintsugi<");
    expect(renderToStaticMarkup(<PathText path="/srv/app/" className="text-ui" />)).toMatch(
      /class="[^"]*text-ui[^"]*">\/<wbr\/>srv\/<wbr\/>app\/<\/span>/,
    );
  });
});
