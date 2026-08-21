import { constants } from "node:fs";
import { access, lstat, mkdir, readlink, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  buildHarnessInstallPlan,
  harnessAdapters,
  VOLLI_PATH_PROFILE_BLOCK,
  type HarnessAdapter,
  type HarnessId,
  type InstallAction,
} from "@volli/shared";

import {
  applyHarnessInstallPlan,
  uninstallHarnessPlan,
  type HarnessInstallResult,
  type HarnessUninstallResult,
} from "./harness-install";
import {
  DETECTION_PROBE,
  loginShellPath,
  probeLoginShellPath,
  resetLoginShellPathCache,
  type LoginShellProbeDeps,
} from "./login-shell-path";

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
export async function detectHarnesses(deps?: LoginShellProbeDeps): Promise<HarnessId[] | null> {
  const pathValue = deps
    ? await probeLoginShellPath(DETECTION_PROBE, deps)
    : await loginShellPath();
  if (pathValue === null) return null;
  return detectInstalledHarnesses(pathValue);
}

export function managedManifestPath(home: string): string {
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

/** Where the user-space CLI link lives — the same directory every peer harness links into. */
export function userCliLinkPath(home: string): string {
  return join(home, ".local", "bin", "volli");
}

export const LEGACY_GLOBAL_CLI_LINK = "/usr/local/bin/volli";

/** What `~/.local/bin/volli` looks like after an ensure pass. */
export type UserCliLinkResult =
  /** The link exists and points at this app's shim (`changed` says whether this pass wrote it). */
  | { state: "linked"; changed: boolean }
  /** Something that is not ours occupies the name; it was left exactly alone. */
  | { state: "kept"; target: string | null };

/**
 * Ensures `~/.local/bin/volli` → the generated shim — user-space, silent, no
 * elevation anywhere. The shim path inside `userData/bin` is stable and the
 * shim itself is regenerated every boot, so the link stays valid across
 * updates without ever being touched again.
 *
 * Never clobbers: an existing symlink is repointed only when its current
 * target is this exact shim or one of `managedTargets` (the sibling dev/
 * packaged profile's shim — the one other file this app may claim). A foreign
 * symlink or a regular file is kept, reported, and surfaced by the CLI pane
 * rather than replaced.
 */
export async function ensureUserCliLink(input: {
  home: string;
  shimPath: string;
  managedTargets?: readonly string[];
}): Promise<UserCliLinkResult> {
  const linkPath = userCliLinkPath(input.home);
  let target: string;
  try {
    const entry = await lstat(linkPath);
    if (!entry.isSymbolicLink()) return { state: "kept", target: null };
    target = await readlink(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(input.shimPath, linkPath);
    return { state: "linked", changed: true };
  }
  if (target === input.shimPath) return { state: "linked", changed: false };
  if ((input.managedTargets ?? []).includes(target)) {
    await rm(linkPath, { force: true });
    await symlink(input.shimPath, linkPath);
    return { state: "linked", changed: true };
  }
  return { state: "kept", target };
}

/**
 * Removes `~/.local/bin/volli` iff it is a symlink pointing at our own shim (or
 * a managed sibling's). Returns whether the link was removed.
 */
export async function removeUserCliLinkIfOurs(input: {
  home: string;
  shimPath: string;
  managedTargets?: readonly string[];
}): Promise<boolean> {
  const linkPath = userCliLinkPath(input.home);
  let target: string;
  try {
    target = await readlink(linkPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: nothing there. EINVAL: exists but not a symlink → not ours.
    if (code === "ENOENT" || code === "EINVAL") return false;
    throw error;
  }
  if (target !== input.shimPath && !(input.managedTargets ?? []).includes(target)) return false;
  await rm(linkPath, { force: true });
  return true;
}

/**
 * Best-effort cleanup of the retired admin-elevated `/usr/local/bin/volli`
 * link — removed only when it is a symlink pointing at our own shim (or a
 * managed sibling's), and only when an UNPRIVILEGED unlink succeeds. That
 * directory is normally root-owned, so on most hosts the unlink earns EACCES
 * and the stale link survives; "kept" is the honest report for that, and the
 * CLI pane states it rather than claiming a clean migration. No prompt, ever:
 * an admin dialog to delete a symlink that `~/.local/bin` now shadows anyway
 * is exactly the interruption this migration exists to remove.
 */
export async function cleanupLegacyGlobalCliLink(input: {
  shimPath: string;
  managedTargets?: readonly string[];
  /** Test seam; the real path is {@link LEGACY_GLOBAL_CLI_LINK}. */
  legacyLinkPath?: string;
}): Promise<"removed" | "kept" | "absent"> {
  const linkPath = input.legacyLinkPath ?? LEGACY_GLOBAL_CLI_LINK;
  let target: string;
  try {
    target = await readlink(linkPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    // EINVAL: exists but not a symlink → not ours; anything else unreadable →
    // leave it alone. Best-effort means no failure here is worth a boot error.
    return "kept";
  }
  if (target !== input.shimPath && !(input.managedTargets ?? []).includes(target)) return "kept";
  try {
    await unlink(linkPath);
    return "removed";
  } catch {
    return "kept"; // usually EACCES — root-owned directory, no elevation by design
  }
}

/**
 * The managed profile fence that puts `~/.local/bin` on the login-shell PATH —
 * zsh's `~/.zprofile`, hash-comment markers (an HTML comment is a zsh syntax
 * error). One deliberate reversal is worth naming: the shell-init integration
 * (`shell-init.ts`) never writes the user's dotfiles — it only reads them — and
 * this does, because there is no other way for a plain terminal Volli never
 * spawned to find the CLI. It rides the same managed-write machinery as every
 * other dotfile Volli touches: hash-guarded, conflict-preserving, excisable.
 */
export function userBinPathActions(home: string): InstallAction[] {
  return [
    {
      kind: "fenced",
      path: join(home, ".zprofile"),
      content: VOLLI_PATH_PROFILE_BLOCK,
      version: 1,
      comment: "hash",
      managed: true,
    },
  ];
}

export type UserBinPathState =
  /** `~/.local/bin` already reaches the login shell; nothing was written. */
  | "on-path"
  /** The managed block was written (or refreshed) into `~/.zprofile`. */
  | "written"
  /** The login shell could not be asked, so no dotfile was touched on a guess. */
  | "unknown"
  /** The user edited the managed block; their version was preserved. */
  | "conflict";

/** Whether `loginPath` already reaches `<home>/.local/bin`. */
export function loginPathHasUserBin(loginPath: string, home: string): boolean {
  const userBin = join(home, ".local", "bin").replace(/\/+$/, "");
  return loginPath.split(":").some((entry) => entry.replace(/\/+$/, "") === userBin);
}

/**
 * Appends the PATH block to `~/.zprofile` when the login shell cannot already
 * reach `~/.local/bin`. A `null` login PATH writes nothing: "we could not ask"
 * must not become a dotfile edit, the same stance {@link installHarnessSkills}
 * takes for an empty adapter census.
 *
 * A WRITE also drops the per-launch login-PATH cache ({@link loginShellPath}).
 * That cache was warmed before this ran — it is how `loginPath` was measured —
 * so after the profile changes it describes a shell that no longer exists.
 * Every later measurement (the Settings → CLI pane's Login PATH row, harness
 * detection, doctor) re-asks a fresh login shell, which reads the block this
 * just wrote and reports `~/.local/bin` reachable — the same answer a new
 * terminal gives. Without the drop, the pane would call the PATH "missing" for
 * the whole first launch, at the exact moment a plain terminal resolves
 * `volli` fine. A conflict preserves the user's bytes and writes nothing, so
 * the cached answer still holds and stays.
 */
export async function ensureUserBinOnPath(input: {
  home: string;
  loginPath: string | null;
}): Promise<{ state: UserBinPathState; conflicts: HarnessInstallResult["conflicts"] }> {
  if (input.loginPath === null) return { state: "unknown", conflicts: [] };
  if (loginPathHasUserBin(input.loginPath, input.home)) return { state: "on-path", conflicts: [] };
  const result = await applyHarnessInstallPlan(
    userBinPathActions(input.home),
    managedManifestPath(input.home),
  );
  if (result.conflicts.length > 0) return { state: "conflict", conflicts: result.conflicts };
  if (result.written.length > 0) resetLoginShellPathCache();
  return { state: "written", conflicts: [] };
}

/** Excises the managed PATH block from `~/.zprofile`; surrounding user content survives. */
export async function removeUserBinPathBlock(home: string): Promise<HarnessUninstallResult> {
  return uninstallHarnessPlan(userBinPathActions(home), managedManifestPath(home));
}
