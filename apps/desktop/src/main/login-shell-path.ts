/**
 * The login shell's PATH, adopted onto `process.env.PATH` once at boot.
 *
 * A macOS app opened from Finder or the Dock inherits launchd's bare
 * environment — `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — and main
 * carries that PATH over unfiltered into every structured Pi session's shell
 * tool (`SanitizedEnvExecutionEnv`, `packages/agent-runtime/src/pi/
 * execution-env.ts`). A spawned PTY session never had this problem:
 * `agentSessionEnv`/`ticketSessionEnv` already prepend Volli's own bin dir
 * onto whatever PATH the shell resolves for itself. This module is the
 * structured side's equivalent recovery — not for a wrapper's bin dir (see
 * `session-runtime/pi-adapter.ts`'s `pathPrefixes`), but for the rest of the
 * PATH: homebrew, nvm, pyenv, cargo, `~/Library/pnpm` — the toolchains a
 * Session's shell commands need to find at all.
 *
 * Deliberately NOT `login-path.ts`'s interactive shell (`-i`): that module
 * asks what a spawned PTY would see, and a PTY is genuinely interactive.
 * This module asks once, at boot, before any window exists — an interactive
 * shell can block on an rc file's prompt (a version manager confirming an
 * install, a prompt framework asking a question) with nothing watching to
 * answer it. A plain login shell (`-l`, no `-i`) sources `.zprofile`/
 * `.zshenv` and not `.zshrc`, which is a real gap next to what a PTY would
 * export, but a boot that can hang is a worse trade than a PATH that is
 * merely incomplete.
 *
 * Failure is `null`, never a thrown error and never a latched cache: a
 * profile that times out once costs this one attempt. The boot coordinator
 * then preserves every current PATH entry while still moving Volli's own bin
 * to the front. There is no retry inside this module because main calls it
 * exactly once per launch, unlike `login-path.ts`'s repeated detection callers.
 */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { resolveShell } from "@volli/shared";

/** Generous next to a shell's own startup, tight next to a boot. */
const SHELL_TIMEOUT_MS = 4000;

/** What a profile that spews can cost in memory before this stops listening. */
const MAX_OUTPUT_BYTES = 1 << 16;

/**
 * A profile is allowed to talk, and `xtrace` can echo our command before it
 * runs. The marker lets {@link parseLoginShellPathOutput} find the final PATH
 * even when that chatter does not end in a newline.
 */
const PATH_MARKER = "__VOLLI_PATH__";
const PRINT_PATH_COMMAND = `printf ${PATH_MARKER}; printenv PATH`;

export interface LoginShellPathResult {
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface LoginShellPathDeps {
  env: Record<string, string | undefined>;
  /** Runs the shell, or returns `null` on a spawn failure or timeout. */
  runShell(file: string, args: readonly string[]): Promise<LoginShellPathResult | null>;
}

/**
 * Spawns the shell and returns what it printed, or `null` on any failure —
 * a missing shell, a nonzero exit, a hang past {@link SHELL_TIMEOUT_MS}.
 *
 * `detached: true` plus a process-GROUP kill on timeout, exactly like
 * `login-path.ts`'s `runLoginShell`: a profile that left a foreground
 * command running would otherwise hold the stdout pipe open past the parent
 * shell's own death, and the read would never complete at all. `stdin` is
 * `/dev/null`, never a pipe, for the same reason that module gives: a
 * profile that reads stdin blocks on a pipe nothing will ever write to.
 */
async function runLoginShell(
  file: string,
  args: readonly string[],
): Promise<LoginShellPathResult | null> {
  const child = spawn(file, [...args], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  let failed = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (output.length < MAX_OUTPUT_BYTES) output += chunk;
  });
  child.once("error", () => {
    failed = true;
  });
  const timer = setTimeout(() => {
    failed = true;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone, which is the outcome the kill was after.
    }
  }, SHELL_TIMEOUT_MS);
  try {
    const result = await new Promise<Omit<LoginShellPathResult, "stdout"> | null>((resolve) => {
      // `close`, not `exit`: a foreground grandchild the timeout killed can
      // still hold the pipe open a moment after the shell itself is gone.
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
      child.once("error", () => resolve(null));
    });
    return failed || result === null ? null : { stdout: output, ...result };
  } finally {
    clearTimeout(timer);
  }
}

function processDeps(): LoginShellPathDeps {
  return { env: process.env, runShell: runLoginShell };
}

/**
 * What a login shell printed, or `null` when there was nothing usable in it.
 *
 * The final usable marker wins. `xtrace` can echo a command carrying the
 * marker before the command runs, and a profile can print chatter without a
 * trailing newline. Only a colon-separated sequence of non-empty absolute
 * directories is a safe PATH to adopt.
 */
export function parseLoginShellPathOutput(stdout: string): string | null {
  let markerIndex = stdout.lastIndexOf(PATH_MARKER);
  while (markerIndex !== -1) {
    const valueStart = markerIndex + PATH_MARKER.length;
    const lineEnd = stdout.indexOf("\n", valueStart);
    const value = stdout.slice(valueStart, lineEnd === -1 ? undefined : lineEnd).trim();
    if (
      value.length > 0 &&
      value.split(":").every((entry) => entry.length > 0 && isAbsolute(entry))
    ) {
      return value;
    }
    markerIndex = markerIndex === 0 ? -1 : stdout.lastIndexOf(PATH_MARKER, markerIndex - 1);
  }
  return null;
}

/**
 * Asks the user's login shell for its exported PATH, once. `null` on any
 * failure, timeout, or empty output. A `null` result never replaces the
 * current PATH with profile data that could not be verified.
 */
export async function resolveLoginShellPath(
  deps: LoginShellPathDeps = processDeps(),
): Promise<string | null> {
  const { file, args } = resolveShell(deps.env);
  try {
    const result = await deps.runShell(file, [...args, "-c", PRINT_PATH_COMMAND]);
    if (result === null || result.exitCode !== 0 || result.signal !== null) return null;
    return parseLoginShellPathOutput(result.stdout);
  } catch {
    return null;
  }
}

/**
 * launchd's bare four-directory PATH — what a Finder/Dock launch hands a
 * macOS process with no shell profile ever consulted. Proven by
 * `apps/desktop/e2e/bare-path-env-smoke.mjs`.
 */
export const BARE_LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function entriesOf(path: string): string[] {
  return path.split(":").filter((entry) => entry.length > 0);
}

/**
 * True when `currentPath` shows the shape a boot without a login shell's
 * export leaves behind: it IS launchd's bare set verbatim, or it is missing
 * at least one directory the login shell's own PATH carries.
 *
 * False for a PATH that already holds everything the login shell would
 * add — even when the two strings still differ, because one carries extra
 * entries of its own or lists the shared ones in a different order.
 * `pnpm dev` inherits a terminal's already-rich PATH (script-local
 * `node_modules/.bin` directories the login shell was never asked about),
 * and reordering or truncating that PATH to match a freshly spawned shell
 * would cost a working dev boot something real to fix a launch mode it was
 * never in.
 */
export function currentPathIsIncomplete(
  currentPath: string | undefined,
  loginPath: string,
): boolean {
  const current = currentPath ?? "";
  if (current === BARE_LAUNCHD_PATH) return true;
  const currentEntries = new Set(entriesOf(current));
  return entriesOf(loginPath).some((entry) => !currentEntries.has(entry));
}

export type LoginPathOutcome =
  | { kind: "adopted"; path: string; entryCount: number }
  | { kind: "kept" };

/**
 * The merge rule: login directories take precedence, and every current
 * directory remains reachable. The union deduplicates in login-then-current
 * order, which avoids replacing a dev boot's private bin directory with the
 * subset a non-interactive shell happens to export.
 */
export function decideLoginPathAdoption(
  currentPath: string | undefined,
  loginPath: string | null,
): LoginPathOutcome {
  if (loginPath === null || loginPath.length === 0) return { kind: "kept" };
  const path = [...new Set([...entriesOf(loginPath), ...entriesOf(currentPath ?? "")])].join(":");
  if (path === (currentPath ?? "")) return { kind: "kept" };
  return { kind: "adopted", path, entryCount: entriesOf(path).length };
}

/** The one line main logs after resolving the outcome. */
export function loginPathLogLine(outcome: LoginPathOutcome): string {
  return outcome.kind === "adopted"
    ? `[volli] PATH adopted from login shell (${outcome.entryCount} entries)`
    : "[volli] PATH kept";
}

export interface LoginPathBootstrapDeps {
  binDir: string;
  readCurrentPath(): string | undefined;
  writePath(path: string): void;
  resolveLoginPath(): Promise<string | null>;
  log(line: string): void;
}

export interface LoginPathBootstrap {
  /** Applies the already-started probe exactly once. Every caller gets this same promise. */
  apply(): Promise<LoginPathOutcome>;
}

/**
 * Starts the login-shell probe now, but defers every observable effect until
 * {@link LoginPathBootstrap.apply}. Main can therefore overlap the slow shell
 * with boot without putting an await, PATH mutation, or PATH log ahead of the
 * first window. The first post-load callback and every Pi execution env share
 * the one memoized apply promise.
 */
export function createLoginPathBootstrap(deps: LoginPathBootstrapDeps): LoginPathBootstrap {
  let probeAttempt: Promise<string | null>;
  try {
    probeAttempt = Promise.resolve(deps.resolveLoginPath()).catch(() => null);
  } catch {
    probeAttempt = Promise.resolve(null);
  }

  let applyAttempt: Promise<LoginPathOutcome> | undefined;
  return {
    apply: () => {
      applyAttempt ??= probeAttempt.then((loginPath) => {
        const currentPath = deps.readCurrentPath();
        const outcome = decideLoginPathAdoption(currentPath, loginPath);
        const mergedPath = outcome.kind === "adopted" ? outcome.path : (currentPath ?? "");
        const path = [...new Set([deps.binDir, ...entriesOf(mergedPath)])].join(":");
        deps.writePath(path);
        deps.log(loginPathLogLine(outcome));
        return outcome;
      });
      return applyAttempt;
    },
  };
}
