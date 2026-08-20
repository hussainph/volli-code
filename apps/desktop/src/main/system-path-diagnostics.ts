import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CliSystemPathIssue } from "../ipc/contract";

/** macOS `path_helper` reads every file in this root into a login shell's PATH. */
export const PATHS_D_DIRECTORY = "/etc/paths.d";

/** The literal, unexpanded value the Microsoft .NET CLI installer writes. */
export const DOTNET_CLI_TOOLS_LITERAL = "~/.dotnet/tools";

export interface SystemPathDiagnosticsDeps {
  pathsDirectory: string;
  readDirectory(path: string): Promise<readonly string[]>;
  readFile(path: string): Promise<string>;
}

function processDeps(): SystemPathDiagnosticsDeps {
  return {
    pathsDirectory: PATHS_D_DIRECTORY,
    readDirectory: (path) => readdir(path),
    readFile: (path) => readFile(path, "utf8"),
  };
}

/**
 * Finds the known .NET installer defect without touching the root-owned file.
 *
 * `path_helper` accepts a file with no trailing newline, so lines are split
 * rather than requiring one. An unreadable directory or entry is not evidence
 * that it is healthy; it is simply not a diagnosis Volli can make.
 */
export async function systemPathIssues(
  deps: SystemPathDiagnosticsDeps = processDeps(),
): Promise<CliSystemPathIssue[]> {
  let names: readonly string[];
  try {
    names = await deps.readDirectory(deps.pathsDirectory);
  } catch {
    return [];
  }

  const issues: CliSystemPathIssue[] = [];
  for (const name of [...names].sort()) {
    let contents: string;
    try {
      contents = await deps.readFile(join(deps.pathsDirectory, name));
    } catch {
      continue;
    }
    if (!contents.split(/\r?\n/).some((line) => line.trim() === DOTNET_CLI_TOOLS_LITERAL)) continue;
    issues.push({
      kind: "dotnet-cli-tools-literal-tilde",
      file: join(deps.pathsDirectory, name),
      entry: DOTNET_CLI_TOOLS_LITERAL,
    });
  }
  return issues;
}
