/**
 * Harness mode's home containment (VC-703).
 *
 * A `volli-drive` instance runs beside the owner's real Volli on a shared Mac.
 * Its keychain is trapped (`keychain-guard.ts`); this module keeps its
 * FILESYSTEM out of the owner's world: every home-derived path main resolves
 * must sit inside the instance's scratch root, or the app refuses to boot.
 *
 * Main reaches "home" through exactly these doors, each pinned here:
 *
 * - `os.homedir()` (Node reads `$HOME` first): `fs-deps.ts`, host-core's
 *   worktree home fallback, agent-runtime's Pi model/auth paths, the CLI's
 *   operator token → `HOME`.
 * - Electron's `app.getPath("home")`, which ignores `$HOME` on macOS: the
 *   agent-tools home (`~/.agents/harnesses` registry, the skill pack,
 *   `~/.local/bin/volli`, `~/.zprofile`) → `VOLLI_AGENT_HOME`, which harness
 *   mode makes AUTHORITATIVE in index.ts (see {@link HarnessContainment}).
 * - Worktrees → `VOLLI_WORKTREE_HOME_DIR`; Pi's agent dir →
 *   `PI_CODING_AGENT_DIR`; the database → `VOLLI_DB_PATH`; userData (the bin
 *   shim, sockets, blobs) → `--user-data-dir`; the guard's own keys →
 *   `VOLLI_HARNESS_DIR`; XDG dirs; zsh's `ZDOTDIR`; git's global config.
 *
 * Plus the cheap credential bits a scratch fixture repo needs to stay inert:
 * no system git config, no git prompt, no inherited ssh-agent.
 *
 * Packaged builds are refused outright: harness mode is dev-build only until
 * a packed launch has its own validated gate (VC-705).
 *
 * Pure apart from `realpath`: unit-tested with temp dirs, no Electron.
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/** The instance's scratch root. Every path below must resolve inside it. */
export const HARNESS_SCRATCH_ENV = "VOLLI_HARNESS_SCRATCH";
/** Survives bundling, so volli-drive can tell a contained build before launch. */
export const HARNESS_CONTAINMENT_MARKER = "volli-harness-containment:v1";

/**
 * Every environment-named, home-derived path main (or what it spawns) reads.
 * Each must be set, absolute and inside the scratch root.
 */
export const HARNESS_SCRATCH_PATH_ENV = [
  "HOME",
  "VOLLI_AGENT_HOME",
  "VOLLI_WORKTREE_HOME_DIR",
  "PI_CODING_AGENT_DIR",
  "VOLLI_DB_PATH",
  "VOLLI_HARNESS_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "ZDOTDIR",
  "GIT_CONFIG_GLOBAL",
] as const;

/** Values harness mode requires exactly. */
export const HARNESS_REQUIRED_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** Names harness mode requires absent: an inherited ssh-agent is a credential. */
export const HARNESS_FORBIDDEN_ENV = ["SSH_AUTH_SOCK", "SSH_AGENT_PID"] as const;

export interface HarnessContainment {
  readonly scratch: string;
  /** The agent-tools home index.ts must use instead of `app.getPath("home")`. */
  readonly agentHome: string;
  readonly userDataDir: string;
  readonly paths: Readonly<Record<string, string>>;
}

export type ContainmentResult =
  | { readonly ok: true; readonly containment: HarnessContainment }
  | { readonly ok: false; readonly problems: readonly string[] };

export interface ContainmentInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `--user-data-dir`, from the command line (empty when absent). */
  readonly userDataDir: string | undefined;
  readonly isPackaged: boolean;
  /** The owner's passwd home (`os.userInfo().homedir`): a string, never read. */
  readonly ownerHome: string;
  readonly realpath?: (path: string) => string;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The real location of `path`: the nearest existing ancestor resolved through
 * symlinks, with the not-yet-created rest appended. A symlink inside scratch
 * pointing out of it therefore resolves out of it.
 */
function realLocation(path: string, realpath: (path: string) => string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpath(head), ...rest.toReversed());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      rest.push(head.slice(parent.length).replace(/^\/+/, ""));
      head = parent;
    }
  }
}

export function checkHarnessContainment(input: ContainmentInput): ContainmentResult {
  const realpath = input.realpath ?? ((path: string) => realpathSync.native(path));
  const { env } = input;
  const problems: string[] = [];
  if (input.isPackaged) {
    problems.push("harness mode is dev-build only; packaged builds are refused (VC-705)");
  }
  const rawScratch = env[HARNESS_SCRATCH_ENV];
  let scratch: string | null = null;
  if (rawScratch === undefined || !isAbsolute(rawScratch)) {
    problems.push(`${HARNESS_SCRATCH_ENV} must be an absolute scratch directory`);
  } else {
    try {
      scratch = realpath(rawScratch);
    } catch {
      problems.push(`${HARNESS_SCRATCH_ENV} (${rawScratch}) does not exist`);
    }
  }
  const ownerHome = resolve(input.ownerHome);
  if (scratch !== null) {
    if (scratch === "/" || within(ownerHome, scratch)) {
      problems.push(`scratch ${scratch} contains the owner's home ${ownerHome}`);
      scratch = null;
    } else if (within(scratch, ownerHome)) {
      problems.push(`scratch ${scratch} is inside the owner's home ${ownerHome}`);
      scratch = null;
    }
  }
  const paths: Record<string, string> = {};
  const contain = (label: string, value: string | undefined): void => {
    if (value === undefined || value === "" || !isAbsolute(value)) {
      problems.push(`${label} must be an absolute path inside the scratch root`);
      return;
    }
    if (scratch === null) return;
    const real = realLocation(value, realpath);
    if (!within(real, scratch)) {
      problems.push(`${label} (${value}) resolves outside the scratch root ${scratch}`);
      return;
    }
    paths[label] = real;
  };
  for (const name of HARNESS_SCRATCH_PATH_ENV) contain(name, env[name]);
  contain("--user-data-dir", input.userDataDir);
  for (const [name, value] of Object.entries(HARNESS_REQUIRED_ENV)) {
    if (env[name] !== value) problems.push(`${name} must be "${value}" in harness mode`);
  }
  for (const name of HARNESS_FORBIDDEN_ENV) {
    if (env[name] !== undefined) problems.push(`${name} must be unset in harness mode`);
  }
  if (problems.length > 0 || scratch === null) return { ok: false, problems };
  return {
    ok: true,
    containment: {
      scratch,
      agentHome: paths["VOLLI_AGENT_HOME"]!,
      userDataDir: paths["--user-data-dir"]!,
      paths,
    },
  };
}
