/**
 * What is actually true of the CLI install right now, for the Settings → CLI
 * pane (VC-52). Every field is a MEASUREMENT taken at call time — the link is
 * re-read from disk, the login PATH re-asked (cached per launch by
 * `login-shell-path.ts`, and that cache is dropped the moment `ensureUserBinOnPath`
 * wires the profile, so the row reflects the wiring on the very launch that
 * performed it), the wrapper set read from what the last regeneration
 * resolved — because the pane exists to replace guessing with detection, and a
 * snapshot taken at boot would age exactly the way the guess did.
 *
 * This module holds no Electron imports: everything host-shaped arrives
 * through {@link CliStatusDeps}, injected once from `index.ts`, so the shape of
 * the answer is unit-testable against a scratch filesystem.
 */
import { lstat, readlink } from "node:fs/promises";
import { basename } from "node:path";

import type { CliToolStatus } from "../ipc/contract";
import { LEGACY_GLOBAL_CLI_LINK, loginPathHasUserBin, userCliLinkPath } from "./agent-tools";

export interface CliStatusDeps {
  home: string;
  /** Read at CALL time: the shim is regenerated after boot, and again by repair. */
  shimPath(): string;
  /** Sibling-profile shims (dev vs packaged) whose link we also count as ours. */
  managedTargets: readonly string[];
  socketPath: string;
  /** Measured at call time (`agentSocket.live()`) — never a boot latch. */
  socketLive(): boolean;
  loginShellPath(): Promise<string | null>;
  /** Wrapper command names the last harness-runtime regeneration produced. */
  wrapperCommands(): readonly string[];
  /** The user's login shell binary (`resolveShell`). */
  shellFile: string;
  /** Whether the generated zsh chain exists on disk right now. */
  shellChainActive(): boolean;
  /** The File → Remove tombstone: background install stands down until reinstall. */
  installSuppressed(): boolean;
  /** Test seam; the real path is {@link LEGACY_GLOBAL_CLI_LINK}. */
  legacyLinkPath?: string;
}

/** One symlink, read without following it. */
async function linkState(
  path: string,
  ours: (target: string) => boolean,
): Promise<{ state: "ours" | "missing" | "foreign" | "not-symlink"; target: string | null }> {
  try {
    const entry = await lstat(path);
    if (!entry.isSymbolicLink()) return { state: "not-symlink", target: null };
    const target = await readlink(path);
    return { state: ours(target) ? "ours" : "foreign", target };
  } catch {
    return { state: "missing", target: null };
  }
}

export async function readCliStatus(deps: CliStatusDeps): Promise<CliToolStatus> {
  const shimPath = deps.shimPath();
  const isOurs = (target: string): boolean =>
    target === shimPath || deps.managedTargets.includes(target);
  const link = await linkState(userCliLinkPath(deps.home), isOurs);
  const legacyPath = deps.legacyLinkPath ?? LEGACY_GLOBAL_CLI_LINK;
  const legacy = await linkState(legacyPath, isOurs);
  const loginPath = await deps.loginShellPath();
  const shellName = basename(deps.shellFile);
  return {
    link: { path: userCliLinkPath(deps.home), ...link },
    path: {
      binDir: userCliLinkPath(deps.home).replace(/\/volli$/, ""),
      state:
        loginPath === null
          ? "unknown"
          : loginPathHasUserBin(loginPath, deps.home)
            ? "reachable"
            : "missing",
    },
    socket: { path: deps.socketPath, live: deps.socketLive() },
    wrappers: { commands: [...deps.wrapperCommands()] },
    shell: {
      name: shellName,
      supported: shellName === "zsh",
      chainActive: deps.shellChainActive(),
    },
    // The stale admin-owned link most hosts cannot unlink without elevation —
    // reported so the pane can say so truthfully instead of claiming a clean
    // migration. "missing" is the good outcome and the pane hides it.
    legacy: {
      path: legacyPath,
      state: legacy.state === "missing" ? "absent" : legacy.state === "ours" ? "ours" : "foreign",
    },
    installSuppressed: deps.installSuppressed(),
  };
}
