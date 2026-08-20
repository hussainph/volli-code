import { describe, expect, it, vi } from "vite-plus/test";

import {
  DOTNET_CLI_TOOLS_LITERAL,
  PATHS_D_DIRECTORY,
  systemPathIssues,
} from "./system-path-diagnostics";

describe("systemPathIssues", () => {
  it("names the exact root-owned file when the .NET installer wrote its literal tilde entry", async () => {
    const readFile = vi.fn(async (path: string) =>
      path.endsWith("dotnet-cli-tools")
        ? DOTNET_CLI_TOOLS_LITERAL // The upstream file commonly has no final newline.
        : "/usr/local/bin\n",
    );

    await expect(
      systemPathIssues({
        pathsDirectory: PATHS_D_DIRECTORY,
        readDirectory: async () => ["other", "dotnet-cli-tools"],
        readFile,
      }),
    ).resolves.toEqual([
      {
        kind: "dotnet-cli-tools-literal-tilde",
        file: "/etc/paths.d/dotnet-cli-tools",
        entry: "~/.dotnet/tools",
      },
    ]);
    expect(readFile).toHaveBeenCalledWith("/etc/paths.d/dotnet-cli-tools");
  });

  it("finds the malformed installer value wherever it appears in paths.d", async () => {
    await expect(
      systemPathIssues({
        pathsDirectory: "/scratch/paths.d",
        readDirectory: async () => ["custom-dotnet-path"],
        readFile: async () => `  ${DOTNET_CLI_TOOLS_LITERAL}\n`,
      }),
    ).resolves.toEqual([
      {
        kind: "dotnet-cli-tools-literal-tilde",
        file: "/scratch/paths.d/custom-dotnet-path",
        entry: DOTNET_CLI_TOOLS_LITERAL,
      },
    ]);
  });

  it("ignores ordinary absolute entries", async () => {
    await expect(
      systemPathIssues({
        pathsDirectory: PATHS_D_DIRECTORY,
        readDirectory: async () => ["homebrew"],
        readFile: async () => "/opt/homebrew/bin\n",
      }),
    ).resolves.toEqual([]);
  });

  it("leaves an unreadable system directory undiagnosed", async () => {
    await expect(
      systemPathIssues({
        pathsDirectory: PATHS_D_DIRECTORY,
        readDirectory: async () => {
          throw new Error("permission denied");
        },
        readFile: async () => {
          throw new Error("unreachable");
        },
      }),
    ).resolves.toEqual([]);
  });
});
