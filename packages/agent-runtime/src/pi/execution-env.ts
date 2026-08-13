/**
 * The execution environment a Session's tools run in when the host injects
 * none, and the environment variables it and `ScopedExecutionEnv` both hand a
 * child process.
 */

import {
  NodeExecutionEnv,
  type ExecutionEnv,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core/node";

function sanitizedPath(pathValue: string | undefined): string {
  const safeRoots = ["/opt/homebrew", "/usr/local", "/System", "/usr", "/bin", "/sbin"];
  const safe = (pathValue ?? "")
    .split(":")
    .filter((entry) => safeRoots.some((root) => entry === root || entry.startsWith(`${root}/`)));
  return [...new Set(safe)].join(":") || "/usr/bin:/bin:/usr/sbin:/sbin";
}

/**
 * Everything a child command is given: a `PATH` filtered to system roots, the
 * locale and terminal variables a CLI needs to render, and nothing else. No
 * `HOME`, and none of the host's own variables.
 */
export function sanitizedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = { PATH: sanitizedPath(source.PATH) };
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TZ", "CI", "NO_COLOR"]) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}

class SanitizedEnvExecutionEnv extends NodeExecutionEnv {
  /** Pi's bash tool asks for the host environment; here is the only place that can decline. */
  override async exec(command: string, options?: ShellExecOptions) {
    return super.exec(command, {
      ...options,
      env: { ...sanitizedEnvironment(process.env), ...options?.env },
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
 * What the sanitized environment buys is narrower than it sounds, and reading
 * containment into it would be worse than reading nothing: it keeps the host's
 * secrets out of the environment a subprocess is *handed*, so a token that
 * reached Electron is not sitting in the first command's `printenv`. It stops
 * nothing from going and reading the same secret off disk. `PATH` still
 * resolves binaries under `/usr/local`, and bash with no `HOME` still expands
 * `~` from the password database, so `~/.pi/agent/auth.json` remains an
 * ordinary readable file — both measured, not assumed. Only Seatbelt's
 * `denyRead` ever answered that, and nothing installs it today.
 *
 * `ScopedExecutionEnv` is the boundary that used to be installed here and the
 * one `docs/plans/authority-two-axis-rearchitecture.md` rebuilds on. It is kept
 * whole; nothing wires it up.
 */
export async function piExecutionEnv(workspacePath: string): Promise<ExecutionEnv> {
  return new SanitizedEnvExecutionEnv({ cwd: workspacePath });
}
