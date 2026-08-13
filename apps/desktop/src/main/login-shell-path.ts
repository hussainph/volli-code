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
 * profile that times out once costs this one attempt, and the current PATH
 * is left exactly as it was. There is no retry inside this module because
 * main calls it exactly once per launch, unlike `login-path.ts`'s repeated
 * detection callers.
 */
import { spawn } from "node:child_process";

import { resolveShell } from "@volli/shared";

/** Generous next to a shell's own startup, tight next to a boot. */
const SHELL_TIMEOUT_MS = 4000;

/** What a profile that spews can cost in memory before this stops listening. */
const MAX_OUTPUT_BYTES = 1 << 16;

/**
 * No marker, unlike `login-path.ts`: `.zprofile`/`.zshenv` run and finish
 * BEFORE the `-c` command ever starts, and nothing runs after it for a
 * non-interactive shell (`.zlogout` only fires for an interactive one on
 * exit) — so whatever a chatty profile printed is complete, newline-
 * terminated lines that precede this command's own output, never woven
 * through it. {@link parseLoginShellPathOutput} takes the position that
 * guarantees rather than a marker that would cost a second process argument.
 */
const PRINT_PATH_COMMAND = "printf '%s' \"$PATH\"";

export interface LoginShellPathDeps {
  env: Record<string, string | undefined>;
  /** Runs the shell and resolves its stdout, or `null` on any failure or timeout. */
  runShell(file: string, args: readonly string[]): Promise<string | null>;
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
async function runLoginShell(file: string, args: readonly string[]): Promise<string | null> {
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
    await new Promise<void>((resolve) => {
      // `close`, not `exit`: a foreground grandchild the timeout killed can
      // still hold the pipe open a moment after the shell itself is gone.
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
  } finally {
    clearTimeout(timer);
  }
  return failed ? null : output;
}

function processDeps(): LoginShellPathDeps {
  return { env: process.env, runShell: runLoginShell };
}

/**
 * What a login shell printed, or `null` when there was nothing usable in it.
 *
 * Reads everything after the LAST newline: `printf` adds none of its own, and
 * it is the last thing this shell ever runs, so a profile that greets the
 * user or logs a version-manager line lands in whole lines ahead of it —
 * never spliced into the value itself.
 */
export function parseLoginShellPathOutput(stdout: string): string | null {
  const lastNewline = stdout.lastIndexOf("\n");
  const value = (lastNewline === -1 ? stdout : stdout.slice(lastNewline + 1)).trim();
  return value.length === 0 ? null : value;
}

/**
 * Asks the user's login shell for its exported PATH, once. `null` on any
 * failure, timeout, or empty output — and on `null` the caller changes
 * nothing, which is what makes probing a real profile at boot safe to ship.
 */
export async function resolveLoginShellPath(
  deps: LoginShellPathDeps = processDeps(),
): Promise<string | null> {
  const { file, args } = resolveShell(deps.env);
  const stdout = await deps.runShell(file, [...args, "-c", PRINT_PATH_COMMAND]);
  return stdout === null ? null : parseLoginShellPathOutput(stdout);
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
 * The merge rule: adopt the login shell's PATH onto `currentPath` when there
 * is one to adopt — non-empty — and `currentPath` is missing something it
 * says. Anything else is `kept`, `currentPath` untouched: a `loginPath` that
 * failed to resolve, one identical to `currentPath`, or one that only
 * reorders or narrows what `currentPath` already has.
 */
export function decideLoginPathAdoption(
  currentPath: string | undefined,
  loginPath: string | null,
): LoginPathOutcome {
  if (loginPath === null || loginPath.length === 0) return { kind: "kept" };
  // Identical is its own case, ahead of the incomplete check: the bare
  // launchd set is "incomplete" by definition, but a login shell that
  // resolves to that SAME string changes nothing, and "adopted" would claim
  // it did.
  if (loginPath === (currentPath ?? "")) return { kind: "kept" };
  if (!currentPathIsIncomplete(currentPath, loginPath)) return { kind: "kept" };
  return { kind: "adopted", path: loginPath, entryCount: entriesOf(loginPath).length };
}

/** The one line main logs after resolving the outcome. */
export function loginPathLogLine(outcome: LoginPathOutcome): string {
  return outcome.kind === "adopted"
    ? `[volli] PATH adopted from login shell (${outcome.entryCount} entries)`
    : "[volli] PATH kept";
}
