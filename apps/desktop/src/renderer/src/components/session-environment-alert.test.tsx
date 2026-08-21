import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionEnvironmentNotice } from "./session-environment-alert";

describe("SessionEnvironmentNotice", () => {
  it("keeps a detected PATH failure on screen with a direct repair and route to its evidence", () => {
    const html = renderToStaticMarkup(
      <SessionEnvironmentNotice
        alert={{
          title: "Sessions couldn't read your login PATH",
          detail:
            "Commands available in your terminal may not run here. Run volli doctor --fix to re-run PATH adoption for new Sessions.",
        }}
        onReview={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(html).toContain("Sessions couldn&#x27;t read your login PATH");
    expect(html).toContain("Commands available in your terminal may not run here.");
    expect(html).toContain("volli doctor --fix");
    expect(html).toContain("Review CLI");
    // The escape hatch: a fault the user has read can be put away, so the
    // persistent notice never becomes a permanent one.
    expect(html).toContain("Dismiss");
    expect(html).toContain("bg-destructive/10");
    expect(html).toContain('role="status"');
  });
});
