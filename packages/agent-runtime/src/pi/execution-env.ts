/**
 * The execution environment a Session's tools run in when the host injects
 * none, and both of the environments a child process can be handed: this
 * path's, and `ScopedExecutionEnv`'s.
 */

import {
  NodeExecutionEnv,
  type ExecutionEnv,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core/node";

export interface PiExecutionEnvOptions {
  /**
   * Directories prepended onto the sanitized environment's `PATH`, in order,
   * before every `exec`. See {@link piExecutionEnv} for why this exists.
   */
  pathPrefixes?: readonly string[];
}

/**
 * What a CLI needs to render text, and nothing that says who is running it.
 * Both environments below are this list plus what their own path can afford;
 * neither has a second copy of it.
 */
const BENIGN_VARIABLES = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TZ",
  "CI",
  "NO_COLOR",
] as const;

const UNSANDBOXED_VARIABLES = [...BENIGN_VARIABLES, "PATH", "HOME", "SSH_AUTH_SOCK"] as const;

function carriedOver(source: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function sanitizedPath(pathValue: string | undefined): string {
  const safeRoots = ["/opt/homebrew", "/usr/local", "/System", "/usr", "/bin", "/sbin"];
  const safe = (pathValue ?? "")
    .split(":")
    .filter((entry) => safeRoots.some((root) => entry === root || entry.startsWith(`${root}/`)));
  return [...new Set(safe)].join(":") || "/usr/bin:/bin:/usr/sbin:/sbin";
}

/**
 * Everything a child command is given behind `ScopedExecutionEnv`'s boundary: a
 * `PATH` filtered to system roots, the locale and terminal variables, and
 * nothing else. No `HOME`, and none of the host's own variables.
 *
 * The `PATH` filter costs a Session the toolchains it was pointed at — nvm,
 * pyenv, cargo, `~/Library/pnpm` — and that price is only worth paying where
 * something enforces the rest of the story. Behind Seatbelt the set of binaries
 * a command can reach is one clause of a boundary; on the default path it is a
 * suggestion, so {@link unsandboxedEnvironment} does not pay it.
 */
export function scopedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return { PATH: sanitizedPath(source.PATH), ...carriedOver(source, BENIGN_VARIABLES) };
}

/**
 * Everything a child command is given on the default, uncontained path: the
 * host's own `PATH`, `HOME` and `SSH_AUTH_SOCK`, the locale and terminal
 * variables, and nothing else the host process is holding.
 *
 * Those three extra names are not a grant of trust. Nothing contains this path,
 * so there is no trust to grant and none of them was ever what held a command
 * back; each is kept because dropping it only removes function.
 *
 * `PATH` unfiltered, because filtering it to system roots deletes nvm, pyenv,
 * cargo and `~/Library/pnpm` from a Session — the toolchains the repository it
 * was pointed at is actually built with. A command that wants an unlisted
 * binary names it by absolute path either way.
 *
 * `SSH_AUTH_SOCK`, because `git push` over an agent needs it, and without it
 * the last step of a Ticket fails in a way the model cannot diagnose.
 *
 * `HOME`, because it is a location and not a secret, and one the child can
 * trivially re-derive: bash with no `HOME` expands `~` from the password
 * database, so `~/.pi/agent/auth.json` is equally readable with it and without
 * — measured, not assumed. What its absence does reach is `~/.gitconfig`: no
 * `user.name`, no `user.email`, no commit. Withholding a location the process
 * can re-derive breaks tools and buys nothing.
 *
 * Everything outside these lists is still dropped, and that is the whole of
 * what this buys: a token that reached Electron is not in the environment a
 * subprocess is handed. It is not a boundary — see {@link piExecutionEnv}.
 */
function unsandboxedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return carriedOver(source, UNSANDBOXED_VARIABLES);
}

/**
 * `pathPrefixes` joined onto `path`, in order — skipping empty entries, and
 * never repeating one already sitting at the front. A prefix that only
 * appears LATER in `path` is still prepended: the point is that a session's
 * commands find it first, not that they find it at all.
 */
function prefixedPath(path: string, pathPrefixes: readonly string[]): string {
  const result = path.length === 0 ? [] : path.split(":");
  for (let i = pathPrefixes.length - 1; i >= 0; i -= 1) {
    const prefix = pathPrefixes[i];
    if (prefix === undefined || prefix.length === 0 || result[0] === prefix) continue;
    result.unshift(prefix);
  }
  return result.join(":");
}

class SanitizedEnvExecutionEnv extends NodeExecutionEnv {
  readonly #pathPrefixes: readonly string[];

  constructor(options: { cwd: string; pathPrefixes?: readonly string[] }) {
    super({ cwd: options.cwd });
    this.#pathPrefixes = options.pathPrefixes ?? [];
  }

  /** Pi's bash tool asks for the host environment; here is the only place that can decline. */
  override async exec(command: string, options?: ShellExecOptions) {
    const sanitized = unsandboxedEnvironment(process.env);
    const merged = { ...sanitized, ...options?.env };
    return super.exec(command, {
      ...options,
      env: {
        ...merged,
        PATH: prefixedPath(merged.PATH ?? "", this.#pathPrefixes),
      },
      inheritEnv: false,
    });
  }
}

/**
 * Pi's own environment, rooted at the Session workspace, spawning commands with
 * a sanitized set of environment variables.
 *
 * Uncontained, and that is the current product decision rather than an
 * oversight: Volli runs Pi at its defaults, so a Session's file and process
 * tools carry whatever authority the user running Volli has. The workspace is
 * where those tools are *pointed* — by `cwd`, and by the system prompt that
 * tells the model to stay inside it — not a limit they are held to.
 *
 * What sanitizing the environment buys is narrower than it sounds, and reading
 * containment into it would be worse than reading nothing: it keeps the host's
 * secrets out of the environment a subprocess is *handed*, so a token that
 * reached Electron is not sitting in the first command's `printenv`. It stops
 * nothing from going and reading the same secret off disk. The `PATH`, `HOME`
 * and `SSH_AUTH_SOCK` it does pass are what a toolchain needs, and none of them
 * was ever the thing holding a command back: `~` expands from the password
 * database whether or not `HOME` is set, so `~/.pi/agent/auth.json` was an
 * ordinary readable file before this passed `HOME` and is one after — measured,
 * not assumed. Only Seatbelt's `denyRead` ever answered that, and nothing
 * installs it today.
 *
 * `ScopedExecutionEnv` is the boundary that used to be installed here and the
 * one `docs/plans/authority-two-axis-rearchitecture.md` rebuilds on. It is kept
 * whole, with the stricter {@link scopedEnvironment} it was written against;
 * nothing wires it up.
 *
 * `pathPrefixes` exists for one caller: main hands in `<userData>/bin`, the
 * directory the CLI shim and every harness wrapper live in, so `volli` and a
 * detected toolchain resolve inside a structured Session exactly as they do
 * inside a Volli-started PTY (`agentSessionEnv`/`ticketSessionEnv` prepend the
 * same directory there). Prefixes are applied onto whatever PATH the merged
 * environment ended up with — including a caller-supplied one — because a
 * PATH that wipes them is how a Finder/Dock boot's `/usr/local/bin/volli`
 * (another profile's shim) wins. Without this a Session launched from a
 * Finder/Dock boot — launchd's bare `PATH`, proven by
 * `bare-path-env-smoke.mjs` — never sees the shim at all.
 */
export async function piExecutionEnv(
  workspacePath: string,
  options?: PiExecutionEnvOptions,
): Promise<ExecutionEnv> {
  return new SanitizedEnvExecutionEnv({ cwd: workspacePath, pathPrefixes: options?.pathPrefixes });
}
