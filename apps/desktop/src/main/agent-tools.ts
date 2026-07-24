import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildHarnessInstallPlan,
  harnessAdapters,
  HARNESS_IDS,
  shellSingleQuote,
  type HarnessId,
} from "@volli/shared";

import {
  applyHarnessInstallPlan,
  uninstallHarnessPlan,
  type HarnessInstallResult,
  type HarnessUninstallResult,
} from "./harness-install";

const execFileAsync = promisify(execFile);

/**
 * Finds first-class harness executables without invoking a shell or the harness
 * itself. Iterates the adapter registry so each harness's detection rule lives
 * in its own adapter module — adding a harness needs no edit here.
 */
export async function detectInstalledHarnesses(pathValue: string): Promise<HarnessId[]> {
  const directories = pathValue.split(":").filter(Boolean);
  const detected: HarnessId[] = [];
  for (const adapter of harnessAdapters) {
    let found = false;
    for (const directory of directories) {
      try {
        await access(join(directory, adapter.detection.executable), constants.X_OK);
        found = true;
        break;
      } catch {
        // Keep searching the remaining PATH entries.
      }
    }
    if (found) detected.push(adapter.id);
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

function managedManifestPath(home: string): string {
  return join(home, ".agents/skills/volli/.volli-managed.json");
}

/** Installs or refreshes the skill pack for currently detected harnesses. */
export async function installDetectedHarnessSkills(input: {
  home: string;
  pathValue: string;
}): Promise<HarnessInstallResult> {
  const detected = await detectInstalledHarnesses(input.pathValue);
  const plan = buildHarnessInstallPlan({ home: input.home, detected });
  return applyHarnessInstallPlan(plan, managedManifestPath(input.home));
}

/**
 * Removes the skill pack for every first-class harness. Detection is irrelevant
 * to removal — a harness the user has since uninstalled may still have Volli
 * files on disk — so the plan spans all {@link HARNESS_IDS}. Per-file hash
 * guards inside {@link uninstallHarnessPlan} keep hand-edited files.
 */
export async function uninstallAllHarnessSkills(input: {
  home: string;
}): Promise<HarnessUninstallResult> {
  const plan = buildHarnessInstallPlan({ home: input.home, detected: HARNESS_IDS });
  return uninstallHarnessPlan(plan, managedManifestPath(input.home));
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
export function globalCliLinkShellCommand(
  shimPath: string,
  managedReplacementTarget?: string,
): string {
  const quotedShimPath = shellSingleQuote(shimPath);
  const managedReplacement =
    managedReplacementTarget === undefined
      ? ""
      : `elif [ -L /usr/local/bin/volli ] && [ "$(/usr/bin/readlink /usr/local/bin/volli)" = ${shellSingleQuote(managedReplacementTarget)} ]; then /bin/ln -sfn ${quotedShimPath} /usr/local/bin/volli; `;
  // Never clobber an unrelated command under administrator privileges. The
  // existing link is accepted only when it already points at this exact shim;
  // `-n` and the absence of `-f` also prevent destination symlink traversal or
  // replacement in a check/create race. Absolute tools avoid PATH substitution.
  return (
    "/bin/mkdir -p /usr/local/bin && " +
    `if [ -L /usr/local/bin/volli ] && [ "$(/usr/bin/readlink /usr/local/bin/volli)" = ${quotedShimPath} ]; then :; ` +
    managedReplacement +
    "elif [ -e /usr/local/bin/volli ] || [ -L /usr/local/bin/volli ]; then echo 'Refusing to replace existing /usr/local/bin/volli' >&2; exit 1; " +
    `else /bin/ln -sn ${quotedShimPath} /usr/local/bin/volli; fi`
  );
}

/** Uses the standard macOS administrator prompt to expose the generated shim outside Volli. */
export async function installGlobalCliLink(
  shimPath: string,
  managedReplacementTarget?: string,
): Promise<void> {
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `do shell script ${appleScriptString(
      globalCliLinkShellCommand(shimPath, managedReplacementTarget),
    )} with administrator privileges`,
  ]);
}

/**
 * Removes `/usr/local/bin/volli` iff it is a symlink pointing at our own shim.
 * The ownership check (`readlink`) is a cheap, non-admin syscall done first, so
 * the administrator prompt only ever appears for a link we actually created —
 * never for a same-named link the user set up for something else, nor a plain
 * file. Returns whether the link was removed.
 */
export async function removeGlobalCliLinkIfOurs(shimPath: string): Promise<boolean> {
  let target: string;
  try {
    target = await readlink("/usr/local/bin/volli");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: nothing there. EINVAL: exists but not a symlink → not ours.
    if (code === "ENOENT" || code === "EINVAL") return false;
    throw error;
  }
  if (target !== shimPath) return false;
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `do shell script ${appleScriptString("/bin/rm -f /usr/local/bin/volli")} with administrator privileges`,
  ]);
  return true;
}
