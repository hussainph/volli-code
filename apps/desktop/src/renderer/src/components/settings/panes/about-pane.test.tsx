import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AboutPane } from "./about-pane";

describe("AboutPane support report", () => {
  it("does not offer a partial report before its facts have loaded", () => {
    const html = renderToStaticMarkup(<AboutPane />);

    expect(html).toContain("Preparing report…");
    expect(html).not.toContain("Copy report…");
  });
});
