import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildHarnessInstallPlan, shellSingleQuote, type HarnessId } from "@volli/shared";

import { applyHarnessInstallPlan, type HarnessInstallResult } from "./harness-install";

const execFileAsync = promisify(execFile);
const harnessExecutables: ReadonlyArray<{ id: HarnessId; executable: string }> = [
  { id: "claude-code", executable: "claude" },
  { id: "codex", executable: "codex" },
  { id: "opencode", executable: "opencode" },
];

/** Finds first-class harness executables without invoking a shell or the harness itself. */
export async function detectInstalledHarnesses(pathValue: string): Promise<HarnessId[]> {
  const directories = pathValue.split(":").filter(Boolean);
  const detected: HarnessId[] = [];
  for (const harness of harnessExecutables) {
    let found = false;
    for (const directory of directories) {
      try {
        await access(join(directory, harness.executable), constants.X_OK);
        found = true;
        break;
      } catch {
        // Keep searching the remaining PATH entries.
      }
    }
    if (found) detected.push(harness.id);
  }
  return detected;
}

export type AgentToolsConsentStatus = "installed" | "deferred";

export async function runAgentToolsConsent(input: {
  current: AgentToolsConsentStatus | null;
  prompt(): Promise<"install" | "defer">;
  install(): Promise<void>;
  persist(status: AgentToolsConsentStatus): Promise<void>;
}): Promise<AgentToolsConsentStatus> {
  if (input.current !== null) return input.current;
  const choice = await input.prompt();
  if (choice === "install") {
    await input.install();
    await input.persist("installed");
    return "installed";
  }
  await input.persist("deferred");
  return "deferred";
}

/** Installs or refreshes the skill pack for currently detected harnesses. */
export async function installDetectedHarnessSkills(input: {
  home: string;
  pathValue: string;
}): Promise<HarnessInstallResult> {
  const detected = await detectInstalledHarnesses(input.pathValue);
  const plan = buildHarnessInstallPlan({ home: input.home, detected });
  const manifestPath = join(input.home, ".agents/skills/volli/.volli-managed.json");
  return applyHarnessInstallPlan(plan, manifestPath);
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The elevated shell command that links the generated shim to `/usr/local/bin`.
 * Fresh macOS (no Homebrew / Command Line Tools) ships without `/usr/local/bin`,
 * so `ln` alone fails permanently; `mkdir -p` runs first in the same elevated
 * shell so both happen under a single administrator prompt.
 */
export function globalCliLinkShellCommand(shimPath: string): string {
  return `/bin/mkdir -p /usr/local/bin && ln -sf ${shellSingleQuote(shimPath)} /usr/local/bin/volli`;
}

/** Uses the standard macOS administrator prompt to expose the generated shim outside Volli. */
export async function installGlobalCliLink(shimPath: string): Promise<void> {
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `do shell script ${appleScriptString(globalCliLinkShellCommand(shimPath))} with administrator privileges`,
  ]);
}
