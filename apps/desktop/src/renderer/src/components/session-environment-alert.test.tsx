import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionEnvironmentNotice } from "./session-environment-alert";

describe("SessionEnvironmentNotice", () => {
  it("keeps a detected PATH failure on screen with a direct route to its evidence", () => {
    const html = renderToStaticMarkup(
      <SessionEnvironmentNotice
        alert={{
          title: "Sessions couldn't read your login PATH",
          detail: "Commands available in your terminal may not run here.",
        }}
        onReview={() => undefined}
      />,
    );

    expect(html).toContain("Sessions couldn&#x27;t read your login PATH");
    expect(html).toContain("Commands available in your terminal may not run here.");
    expect(html).toContain("Review CLI");
    expect(html).toContain("bg-destructive/10");
    expect(html).toContain('role="status"');
  });
});
