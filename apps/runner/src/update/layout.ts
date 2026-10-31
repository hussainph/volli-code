/**
 * Where an update reads and writes, by install mode (n3 §2.3, §9):
 *
 * | | `system` (root) | `user` |
 * |---|---|---|
 * | install root | `/opt/volli-runner` (root's) | `$XDG_DATA_HOME/volli-runner` (`~/.local/share`) |
 * | releases, `current` | `<root>/releases/<version>`, `<root>/current` → `releases/<version>` | the same under the user's root |
 * | updater state | `<root>/update-state.json` (root's, world-readable) | the same |
 * | download cache | `<root>/.update-cache` (root's) | the same |
 * | `update --now` | `<root>/update-now.json` (written with sudo in system mode) | the same |
 * | request | `<dataDir>/update/request.json` (the daemon's) | the same |
 *
 * The install root is where the installer (`src/install`, BYO-10) puts each
 * release beside the others and moves `current` in one rename; the update
 * applier does the same. In system mode it is root-owned, so the daemon and
 * its agents (the `volli` account) can read it and never write it: only the
 * root update unit stages and activates there. The request lives in the
 * daemon's data dir because the daemon writes it, which is also why the
 * applier treats it as untrusted (`request.ts`). The updater's own state sits
 * in the install root for the opposite reason: the daemon only reads it.
 */
import { isAbsolute, join } from "node:path";

import type { RunnerPaths } from "../shell/paths";

export interface UpdateLayout {
  readonly mode: RunnerPaths["mode"];
  readonly installRoot: string;
  readonly releasesDir: string;
  readonly currentLink: string;
  readonly stateFile: string;
  readonly cacheDir: string;
  readonly dataDir: string;
  readonly requestFile: string;
  /** Where `update --now` asks the daemon to update now: the install root's owner writes it. */
  readonly nowFile: string;
  /** The daemon's own record of the outcomes it has reported to Volli. */
  readonly reportedFile: string;
}

/** The system install root, beside the other `/opt` software it is like. */
export const SYSTEM_INSTALL_ROOT = "/opt/volli-runner";

/** The runner's unit, which an activation restarts. */
export const RUNNER_UNIT = "volli-runner.service";

export function defaultInstallRoot(
  mode: RunnerPaths["mode"],
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (mode === "system") return SYSTEM_INSTALL_ROOT;
  const xdg = env["XDG_DATA_HOME"];
  return join(
    xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "share"),
    "volli-runner",
  );
}

export function updateLayout(
  mode: RunnerPaths["mode"],
  installRoot: string,
  dataDir: string,
): UpdateLayout {
  const updateDir = join(dataDir, "update");
  return {
    mode,
    installRoot,
    releasesDir: join(installRoot, "releases"),
    currentLink: join(installRoot, "current"),
    stateFile: join(installRoot, "update-state.json"),
    cacheDir: join(installRoot, ".update-cache"),
    dataDir,
    requestFile: join(updateDir, "request.json"),
    nowFile: join(installRoot, "update-now.json"),
    reportedFile: join(updateDir, "reported.json"),
  };
}
