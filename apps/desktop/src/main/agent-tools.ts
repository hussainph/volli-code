import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildHarnessInstallPlan,
  harnessAdapters,
  shellSingleQuote,
  type HarnessAdapter,
  type HarnessId,
} from "@volli/shared";

import {
  applyHarnessInstallPlan,
  uninstallHarnessPlan,
  type HarnessInstallResult,
  type HarnessUninstallResult,
} from "./harness-install";
import { loginShellPath, readLoginShellPath, type LoginShellDeps } from "./login-path";

const execFileAsync = promisify(execFile);

/**
 * The first executable named `executable` on `pathValue`, absolute — what a
 * shell would pick, resolved without invoking one.
 *
 * `skipDir` is Volli's own `bin/`. Inside a Volli PTY that directory is
 * PREPENDED to PATH and holds the generated wrapper, which is named after the
 * harness's own command; skipping it is how the wrapper finds the real binary,
 * and it is the same reason the trust confirmation has to skip it — naming
 * Volli's wrapper as "the binary this will run" would be a claim about the
 * wrong file.
 */
export async function resolveOnPath(
  pathValue: string,
  executable: string,
  skipDir?: string,
): Promise<string | null> {
  for (const directory of pathValue.split(":").filter(Boolean)) {
    if (directory === skipDir) continue;
    const candidate = join(directory, executable);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return null;
}

/**
 * Finds first-class harness executables on an explicit PATH, without invoking a
 * shell or the harness itself. Iterates the adapter registry, and resolves the
 * `command` each adapter already declares — adding a harness needs no edit here,
 * and there is no second name to keep in step with the one Volli launches.
 */
export async function detectInstalledHarnesses(pathValue: string): Promise<HarnessId[]> {
  const detected: HarnessId[] = [];
  for (const adapter of harnessAdapters) {
    if ((await resolveOnPath(pathValue, adapter.command)) !== null) {
      detected.push(adapter.id);
    }
  }
  return detected;
}

/**
 * What this host has, asked of the user's login shell rather than of main's own
 * environment — a Dock launch inherits launchd's four directories and would see
 * no harness at all (see {@link loginShellPath}).
 *
 * `null` means detection did not run: the shell could not be asked. It is not
 * an empty host, and nothing may treat it as one — an install whose PATH failed
 * to resolve once still has every harness it had a minute ago.
 */
export async function detectHarnesses(deps?: LoginShellDeps): Promise<HarnessId[] | null> {
  const pathValue = deps ? await readLoginShellPath(deps) : await loginShellPath();
  if (pathValue === null) return null;
  return detectInstalledHarnesses(pathValue);
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

/**
 * Installs or refreshes the skill pack for the harnesses this host is treated
 * as having. Which harnesses those are is the CALLER's answer, not this
 * function's: detection speaks for the built-ins, the registry speaks for
 * trusted manifests, and only the caller holds both. An empty set installs
 * nothing at all — not even the canonical files — which is how "we could not
 * find out" stays spelled the same as "there is nothing here", since the plan
 * writes into the user's dotfiles and a guess is worse than a skipped refresh.
 */
export async function installHarnessSkills(input: {
  home: string;
  adapters: readonly HarnessAdapter[];
}): Promise<HarnessInstallResult> {
  const plan = buildHarnessInstallPlan({ home: input.home, adapters: input.adapters });
  return applyHarnessInstallPlan(plan, managedManifestPath(input.home));
}

/**
 * Removes the skill pack for `adapters`. Detection is irrelevant to removal — a
 * harness the user has since uninstalled may still have Volli files on disk —
 * so the caller passes the widest span it can name (every built-in, plus every
 * currently-trusted manifest) rather than only what is present today. Per-file
 * hash guards inside {@link uninstallHarnessPlan} keep hand-edited files.
 */
export async function uninstallAllHarnessSkills(input: {
  home: string;
  adapters: readonly HarnessAdapter[];
}): Promise<HarnessUninstallResult> {
  const plan = buildHarnessInstallPlan({ home: input.home, adapters: input.adapters });
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
