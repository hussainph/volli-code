/**
 * Where a runner keeps its state and its link, by install mode:
 *
 * | mode     | data dir                        | config dir                 |
 * | -------- | ------------------------------- | -------------------------- |
 * | `system` | `/var/lib/volli-runner`         | `/etc/volli-runner`        |
 * | `user`   | `$XDG_STATE_HOME/volli-runner`  | `$XDG_CONFIG_HOME/volli-runner` |
 *
 * `$XDG_STATE_HOME` defaults to `~/.local/state` and `$XDG_CONFIG_HOME` to
 * `~/.config`; a relative one is ignored, as the XDG spec says. Root means a
 * system install: agents never run as root, so root's runner is the system
 * one. The config dir holds the sealed link and its key and never goes into
 * the data dir, so a copied data dir or a backup does not carry the link.
 * `--data-dir` and `--config-dir` override either.
 */
import { isAbsolute, join, resolve } from "node:path";

import type { RunnerInstallMode } from "@volli/shared/cloud";

export interface RunnerPaths {
  readonly mode: Extract<RunnerInstallMode, "system" | "user">;
  readonly dataDir: string;
  readonly configDir: string;
}

export interface PathInputs {
  readonly uid: number;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function xdg(env: PathInputs["env"], name: string, fallback: string): string {
  const value = env[name];
  return value !== undefined && isAbsolute(value) ? value : fallback;
}

export function defaultRunnerPaths({ uid, home, env }: PathInputs): RunnerPaths {
  if (uid === 0) {
    return { mode: "system", dataDir: "/var/lib/volli-runner", configDir: "/etc/volli-runner" };
  }
  return {
    mode: "user",
    dataDir: join(xdg(env, "XDG_STATE_HOME", join(home, ".local", "state")), "volli-runner"),
    configDir: join(xdg(env, "XDG_CONFIG_HOME", join(home, ".config")), "volli-runner"),
  };
}

/** The agent socket a runner serves: `<dataDir>/volli.sock`, mode 0600. */
export function runnerSocketPath(dataDir: string): string {
  return join(dataDir, "volli.sock");
}

/** `--data-dir` and `--config-dir`, which every command that touches the box takes. */
export const PATH_OPTIONS = {
  "data-dir": { type: "string" },
  "config-dir": { type: "string" },
} as const;

export const PATH_USAGE = "[--data-dir <dir>] [--config-dir <dir>]";

/** A string option's value, or `undefined`. */
export function stringOption(
  values: Readonly<Record<string, string | boolean | undefined>>,
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

/** This box's paths: the install mode's defaults, then `--data-dir` and `--config-dir`. */
export function pathsFor(
  values: Readonly<Record<string, string | boolean | undefined>>,
  inputs: PathInputs & { readonly cwd: string },
): RunnerPaths {
  const defaults = defaultRunnerPaths(inputs);
  const absolute = (path: string | undefined, fallback: string): string =>
    path === undefined ? fallback : resolve(inputs.cwd, path);
  return {
    mode: defaults.mode,
    dataDir: absolute(stringOption(values, "data-dir"), defaults.dataDir),
    configDir: absolute(stringOption(values, "config-dir"), defaults.configDir),
  };
}
