/**
 * What boot does with the login shell's PATH once `login-shell-path.ts` has
 * asked for it: merge it onto `process.env.PATH`, once, and say which of the
 * three things that happened happened.
 *
 * A macOS app opened from Finder or the Dock inherits launchd's bare
 * environment — `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — and main
 * carries that PATH over unfiltered into every structured Pi session's shell
 * tool (`SanitizedEnvExecutionEnv`, `packages/agent-runtime/src/pi/
 * execution-env.ts`). A spawned PTY session never had this problem:
 * `agentSessionEnv`/`ticketSessionEnv` already prepend Volli's own bin dir onto
 * whatever PATH the shell resolves for itself. This module is the structured
 * side's equivalent recovery — not for a wrapper's bin dir (see
 * `session-runtime/pi-adapter.ts`'s `pathPrefixes`), but for the rest of the
 * PATH: homebrew, nvm, pyenv, cargo, `~/Library/pnpm` — the toolchains a
 * Session's shell commands need to find at all.
 *
 * Which shell question boot asks, and why it is the non-interactive one, lives
 * with the probe: `ADOPTION_PROBE` in `login-shell-path.ts`. Adoption itself is
 * indifferent to how the answer was obtained, which is what lets VC-94's A3 run
 * the interactive probe after the first window and put its richer answer
 * through this same merge.
 *
 * Failure is `null`, never a thrown error: a profile that times out once costs
 * one attempt, and this module then preserves every current PATH entry while
 * still moving Volli's own bin to the front.
 */

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
  | { kind: "already-complete" }
  | { kind: "probe-failed" };

/**
 * The merge rule: login directories take precedence, and every current
 * directory remains reachable. The union deduplicates in login-then-current
 * order, which avoids replacing a dev boot's private bin directory with the
 * subset a non-interactive shell happens to export.
 *
 * The outcome is three-way rather than adopted/kept because the two `kept`
 * shapes are opposite facts: `already-complete` is the healthy answer for a
 * `pnpm dev` boot that already holds everything, while `probe-failed` is the
 * silent degradation VC-94 exists to make loud — the login shell was never
 * heard from, and the session runs on whatever the host process had. One
 * word for both is how the failure hid in `[volli] PATH kept` for months.
 */
export function decideLoginPathAdoption(
  currentPath: string | undefined,
  loginPath: string | null,
): LoginPathOutcome {
  if (loginPath === null || loginPath.length === 0) return { kind: "probe-failed" };
  const path = [...new Set([...entriesOf(loginPath), ...entriesOf(currentPath ?? "")])].join(":");
  if (path === (currentPath ?? "")) return { kind: "already-complete" };
  return { kind: "adopted", path, entryCount: entriesOf(path).length };
}

/** The one line main logs after resolving the outcome. */
export function loginPathLogLine(outcome: LoginPathOutcome): string {
  switch (outcome.kind) {
    case "adopted":
      return `[volli] PATH adopted from login shell (${outcome.entryCount} entries)`;
    case "already-complete":
      return "[volli] PATH kept (already complete)";
    case "probe-failed":
      return "[volli] PATH kept (login shell probe failed)";
  }
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
