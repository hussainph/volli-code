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
        npm: "/opt/homebrew/bin/npm",
        pnpm: "/opt/homebrew/bin/pnpm",
        yarn: null,
        bun: null,
      },
      requiredTools: ["git", "node", "pnpm"],
      dependencies: null,
      installCommand: null,
    },
    ...overrides,
    systemPathIssues: overrides.systemPathIssues ?? [],
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
            tools: {
              git: "/usr/bin/git",
              gh: null,
              node: null,
              npm: null,
              pnpm: null,
              yarn: null,
              bun: null,
            },
            requiredTools: ["git"],
            dependencies: null,
            installCommand: null,
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

  it("names the root-owned .NET installer defect and its remaining cost without offering a repair", () => {
    const html = renderToStaticMarkup(
      <SessionPathComparison
        environment={environment({
          systemPathIssues: [
            {
              kind: "dotnet-cli-tools-literal-tilde",
              file: "/etc/paths.d/dotnet-cli-tools",
              entry: "~/.dotnet/tools",
            },
          ],
        })}
      />,
    );

    expect(html).toContain("A system PATH entry is malformed");
    expect(html).toContain("/etc/paths.d/dotnet-cli-tools");
    expect(html).toContain("~/.dotnet/tools");
    expect(html).toContain(".NET CLI installer");
    expect(html).toContain("other tools can still reject that PATH");
    expect(html).toContain("Volli will not modify this root-owned file.");
    expect(html).not.toContain("Fix");
  });

  // VC-159/R8: `osxkeychain` is the STOCK macOS Git setup, so this pane used
  // to warn every reader about their own default. The diagnosis still exists
  // (`main/credential-helper-diagnostics.ts`) — it now rides the failed fetch
  // or push it can account for, where it is news rather than noise.
  it("says nothing about Git credential helpers", () => {
    const html = renderToStaticMarkup(<SessionPathComparison environment={environment()} />);

    expect(html).not.toContain("osxkeychain");
    expect(html).not.toContain("credential");
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
            tools: {
              git: "/usr/bin/git",
              gh: null,
              node: null,
              npm: null,
              pnpm: null,
              yarn: null,
              bun: null,
            },
            requiredTools: ["git"],
            dependencies: null,
            installCommand: null,
          },
        })}
      />,
    );

    expect(html).toContain('data-session-path-state="unknown"');
    expect(html).toContain("The login shell did not provide a PATH.");
    expect(html).toContain(sessionPath.split(":")[0]!);
  });
});
