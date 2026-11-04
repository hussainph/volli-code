import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { RailFaultBanner } from "./rail-panel-parts";

describe("RailFaultBanner", () => {
  it("passes the full error to the expandable, copyable message rather than only a hover title", () => {
    const error = "fatal: unable to read repository metadata. ".repeat(20);
    const html = renderToStaticMarkup(<RailFaultBanner error={error} onRetry={() => undefined} />);
    const message = html.slice(
      html.indexOf('role="status"'),
      html.indexOf("</div>", html.indexOf('role="status"')),
    );
    expect(message).toContain(error);
    expect(message).toContain("Updates paused");
    expect(message).not.toContain("<button");
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("Copy error");
    expect(html).toContain("Retry");
  });
});
