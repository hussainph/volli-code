import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CliCredentialHelperIssue } from "../ipc/contract";

const execFileAsync = promisify(execFile);

export interface CredentialHelperDiagnosticsDeps {
  /** Git's all-scope, origin-annotated credential-helper query. */
  readCredentialHelperConfig(cwd: string): Promise<string>;
}

interface CredentialHelperConfigEntry {
  scope: string;
  origin: string;
  helper: string;
}

function processDeps(): CredentialHelperDiagnosticsDeps {
  return {
    async readCredentialHelperConfig(cwd) {
      const { stdout } = await execFileAsync(
        "git",
        [
          "config",
          "--includes",
          "--null",
          "--show-scope",
          "--show-origin",
          "--get-all",
          "credential.helper",
        ],
        { cwd, encoding: "utf8" },
      );
      return stdout;
    },
  };
}

function parseCredentialHelperConfig(output: string): CredentialHelperConfigEntry[] {
  const fields = output.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  if (fields.length % 3 !== 0) return [];

  const entries: CredentialHelperConfigEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index];
    const origin = fields[index + 1];
    const helper = fields[index + 2];
    if (
      scope === undefined ||
      scope === "" ||
      origin === undefined ||
      origin === "" ||
      helper === undefined
    ) {
      return [];
    }
    entries.push({ scope, origin, helper });
  }
  return entries;
}

function effectiveCredentialHelpers(
  entries: readonly CredentialHelperConfigEntry[],
): CredentialHelperConfigEntry[] {
  const helpers: CredentialHelperConfigEntry[] = [];
  for (const entry of entries) {
    // Git keeps earlier values in `config --get-all`; an exactly empty helper
    // clears that accumulated chain before later helpers are appended.
    if (entry.helper === "") {
      helpers.length = 0;
    } else {
      helpers.push(entry);
    }
  }
  return helpers;
}

function issueScope(scope: string): CliCredentialHelperIssue["scope"] | null {
  if (scope === "system" || scope === "global" || scope === "command") return scope;
  if (scope === "local" || scope === "worktree") return "repo-local";
  return null;
}

function location(origin: string): string {
  return origin.startsWith("file:") ? origin.slice("file:".length) : origin;
}

/**
 * Finds known GUI-capable helpers in the chain Git itself assembled for a project.
 *
 * The query is read-only. It asks Git for every included config scope in its own
 * precedence order, then applies Git's empty-value reset before considering a
 * helper hazardous. A failed query establishes neither safety nor a diagnosis.
 */
export async function credentialHelperIssues(
  cwd: string | null,
  deps: CredentialHelperDiagnosticsDeps = processDeps(),
): Promise<CliCredentialHelperIssue[]> {
  if (cwd === null) return [];

  let output: string;
  try {
    output = await deps.readCredentialHelperConfig(cwd);
  } catch {
    return [];
  }

  return effectiveCredentialHelpers(parseCredentialHelperConfig(output)).flatMap((entry) => {
    const scope = issueScope(entry.scope);
    if (scope === null || !/^osxkeychain(?:\s|$)/.test(entry.helper)) return [];
    // A helper value can carry arbitrary command arguments; the UI only needs
    // the known helper name, never the raw configuration value.
    return [
      {
        kind: "osxkeychain-may-prompt-gui" as const,
        helper: "osxkeychain" as const,
        scope,
        location: location(entry.origin),
      },
    ];
  });
}
