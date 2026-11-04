import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionEnvironmentNotice } from "./session-environment-alert";

const FAULT = {
  fault: "login-path-unreadable" as const,
  key: "login-path-unreadable",
  title: "Volli couldn't read your terminal's PATH",
  detail: "Sessions can't find gh and node.",
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
    expect(html).toContain("Sessions can&#x27;t find gh and node");
    expect(html).toContain("Fix now");
    const actions = (html.match(/<button[^>]+>/g) ?? []).filter((button) =>
      button.includes('data-variant="outline"'),
    );
    expect(actions).toHaveLength(2);
    // The shared flat-glass outline: no lift, rest or hover (docs/DESIGN.md).
    for (const action of actions) {
      expect(action).toContain("bg-glass-1");
      expect(action).not.toMatch(/\bshadow-/);
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

  // A project's uninstalled dependencies are not Volli's to repair, so the
  // notice that reports them offers no repair button at all.
  it("drops Fix now for a notice with no app fault behind it", () => {
    const html = renderToStaticMarkup(
      <SessionEnvironmentNotice
        alert={{
          fault: null,
          key: "readiness:Acme::absent",
          title: "Sessions aren't ready for Acme",
          detail: "Dependencies are not installed. Run pnpm install before starting a Session.",
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
