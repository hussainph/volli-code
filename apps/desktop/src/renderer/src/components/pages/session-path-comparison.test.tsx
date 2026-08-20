import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { CliToolStatus } from "../../../../ipc/contract";

import { SessionPathComparison } from "./session-path-comparison";

function environment(
  overrides: Partial<CliToolStatus["environment"]> = {},
): CliToolStatus["environment"] {
  return {
    loginPath: "/usr/bin:/opt/homebrew/bin:/Users/me/.local/bin",
    session: {
      path: "/Users/me/Library/Application Support/Volli Code/bin:/usr/bin:/opt/homebrew/bin:/Users/me/.local/bin",
      provenance: "adopted",
      interactiveProvenance: "already-complete",
      tools: {
        git: "/usr/bin/git",
        gh: "/opt/homebrew/bin/gh",
        node: "/opt/homebrew/bin/node",
        pnpm: "/opt/homebrew/bin/pnpm",
      },
      dependencies: null,
    },
    ...overrides,
  };
}

describe("SessionPathComparison", () => {
  it("puts the complete missing directory beside the Session consequence, without truncation", () => {
    const missing = "/Users/me/Library/Application Support/Acme Toolchains/versions/2026.08/bin";
    const html = renderToStaticMarkup(
      <SessionPathComparison
        environment={environment({
          loginPath: `/usr/bin:${missing}:/opt/homebrew/bin`,
          session: {
            path: "/Users/me/Library/Application Support/Volli Code/bin:/usr/bin:/opt/homebrew/bin",
            provenance: "probe-failed",
            interactiveProvenance: "pending",
            tools: { git: "/usr/bin/git", gh: null, node: null, pnpm: null },
            dependencies: null,
          },
        })}
      />,
    );

    expect(html).toContain('data-session-path-state="diverged"');
    expect(html).toContain("Login PATH");
    expect(html).toContain("Session PATH");
    expect(html).toContain(missing);
    expect(html).toContain("Missing the login directories beside this column.");
    expect(html).toContain("break-all");
    expect(html).toContain("grid-cols-1");
    expect(html).toContain("sm:grid-cols-2");
    expect(html).not.toContain("truncate");
  });

  it("keeps a healthy comparison compact while still offering both full paths", () => {
    const html = renderToStaticMarkup(<SessionPathComparison environment={environment()} />);

    expect(html).toContain('data-session-path-state="matching"');
    expect(html).toContain("Matches login shell");
    expect(html).toContain("Show all paths");
    expect(html).not.toContain("bg-destructive/10");
  });

  it("does not call an unavailable login PATH a match and keeps the Session value readable", () => {
    const sessionPath = "/Users/me/Library/Application Support/Volli Code/bin:/usr/bin";
    const html = renderToStaticMarkup(
      <SessionPathComparison
        environment={environment({
          loginPath: null,
          session: {
            path: sessionPath,
            provenance: "probe-failed",
            interactiveProvenance: "pending",
            tools: { git: "/usr/bin/git", gh: null, node: null, pnpm: null },
            dependencies: null,
          },
        })}
      />,
    );

    expect(html).toContain('data-session-path-state="unknown"');
    expect(html).toContain("The login shell did not provide a PATH.");
    expect(html).toContain(sessionPath.split(":")[0]!);
  });
});
