import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionEnvironmentNotice } from "./session-environment-alert";

const FAULT = {
  fault: "login-path-unreadable" as const,
  key: "login-path-unreadable",
  title: "Volli couldn't read your terminal's PATH",
  detail: "Sessions can't find git.",
};

describe("SessionEnvironmentNotice", () => {
  it("offers the repair as a button, not as a command to type", () => {
    const html = renderToStaticMarkup(
      <SessionEnvironmentNotice
        alert={FAULT}
        onFix={() => undefined}
        onReview={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(html).toContain("Volli couldn&#x27;t read your terminal&#x27;s PATH");
    expect(html).toContain("Sessions can&#x27;t find git");
    expect(html).toContain("Fix now");
    const actions = (html.match(/<button[^>]+>/g) ?? []).filter((button) =>
      button.includes('data-variant="outline"'),
    );
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action).toContain("control-material");
      expect(action).toContain("shadow-control");
      expect(action).toContain("hover:shadow-control-hover");
    }
    expect(html).toContain("Review details");
    expect(html).not.toContain("volli doctor");
    // The escape hatch: a fault the user has read can be put away, so the
    // persistent notice never becomes a permanent one.
    expect(html).toContain('aria-label="Dismiss notice"');
    expect(html).toContain("bg-destructive/10");
    expect(html).toContain('role="status"');
  });

  it("says the repair is running and refuses a second press while it is", () => {
    const html = renderToStaticMarkup(
      <SessionEnvironmentNotice
        alert={FAULT}
        fixing
        onFix={() => undefined}
        onReview={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(html).toContain("Fixing");
    expect(html).toContain("disabled");
  });

  // A missing repository git is not repaired by re-reading the login PATH;
  // only the app-level PATH fault offers Fix now.
  it("drops Fix now for a notice with no app fault behind it", () => {
    const html = renderToStaticMarkup(
      <SessionEnvironmentNotice
        alert={{
          fault: null,
          key: "readiness:Acme:git",
          title: "Sessions aren't ready for Acme",
          detail: "Missing from the Session PATH: git",
        }}
        onReview={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(html).not.toContain("Fix now");
    expect(html).toContain("Review details");
    expect(html).toContain('aria-label="Dismiss notice"');
  });
});
