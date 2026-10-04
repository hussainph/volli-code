/**
 * What main does with a login shell's PATH once `login-shell-path.ts` has asked
 * for it: merge it onto `process.env.PATH` and say which of the three things
 * that happened happened.
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
 * indifferent to how the answer was obtained, and that is what lets this module
 * run TWO passes over the same merge (VC-94's A3):
 *
 * 1. **Boot**, non-interactive, on the critical path. zsh reads `.zshrc` only
 *    when interactive, so this pass cannot see anything a user's `.zshrc`
 *    exports. That is a deliberate trade and it stays: an rc file is free to
 *    prompt, and a boot that hangs with no window to answer in is worse than a
 *    PATH that is merely short.
 * 2. **After the first window**, interactive, off the critical path. Measured
 *    on the reporting host, the gap between the two is seven directories —
 *    `~/.bun/bin`, `~/.opencode/bin`, `~/.fly/bin`,
 *    `~/.antigravity/antigravity/bin`, `~/flutter/bin`,
 *    `/opt/homebrew/opt/ruby/bin` and
 *    `/opt/homebrew/lib/ruby/gems/4.0.0/bin`. nvm, bun, rbenv, pyenv and mise
 *    all conventionally initialise in `.zshrc`, so for a large fraction of
 *    users the boot pass succeeds and still leaves a structured session unable
 *    to reach the toolchain their own terminal reaches. A1 fixed adoption
 *    failing outright; this is the partial-failure case behind it.
 *
 * The second pass ADDS; it never replaces. Both passes go through the same
 * union merge, so no directory a session could reach before a pass is
 * unreachable after it, and Volli's own bin dir is put back in front every
 * time.
 *
 * Failure is `null`, never a thrown error: a profile that times out once costs
 * one attempt, and this module then preserves every current PATH entry while
 * still moving Volli's own bin to the front.
 */
import type { SessionEnvInteractiveProvenance, SessionEnvRepair } from "@volli/shared";

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
  | { kind: "adopted"; path: string; entryCount: number; added: readonly string[] }
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
  const currentEntries = entriesOf(currentPath ?? "");
  const current = new Set(currentEntries);
  const loginEntries = [...new Set(entriesOf(loginPath))];
  const path = [...new Set([...loginEntries, ...currentEntries])].join(":");
  if (path === (currentPath ?? "")) return { kind: "already-complete" };
  return {
    kind: "adopted",
    path,
    entryCount: entriesOf(path).length,
    added: loginEntries.filter((entry) => !current.has(entry)),
  };
}

/**
 * What the second, interactive pass did. The same three words as
 * {@link LoginPathOutcome}, answering a different question: not "was a login
 * PATH merged in" — boot already merged one — but "did asking an INTERACTIVE
 * shell change the PATH this app hands out".
 *
 * `already-complete` is therefore the honest answer for a host whose `.zshrc`
 * exports no PATH, which is the case the boot pass was always right about.
 * `adopted` carries the directories it gained, because the whole argument for
 * a second shell is that on some hosts that list is not empty, and a count
 * nobody can read back is not evidence.
 */
export type InteractivePathOutcome =
  | { kind: "adopted"; path: string; added: readonly string[] }
  | { kind: "already-complete" }
  | { kind: "probe-failed" };

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

/**
 * The second pass's line, which NAMES the directories rather than counting
 * them. When a session cannot find `node`, this line is the difference between
 * "the user's nvm directory was never adopted" and "nvm is not how they
 * installed it" — and the incident VC-94 was raised over cost hours to reach
 * exactly that sentence. It is also the only place the `.zshrc` delta is
 * measured on a host other than the reporting one.
 */
export function interactivePathLogLine(outcome: InteractivePathOutcome): string {
  switch (outcome.kind) {
    case "adopted":
      return outcome.added.length === 0
        ? "[volli] PATH reordered by interactive login shell"
        : `[volli] PATH extended by interactive login shell (+${outcome.added.length}: ${outcome.added.join(" ")})`;
    case "already-complete":
      return "[volli] PATH kept (interactive login shell adds nothing)";
    case "probe-failed":
      return "[volli] PATH kept (interactive login shell probe failed)";
  }
}

export interface LoginPathBootstrapDeps {
  binDir: string;
  readCurrentPath(): string | undefined;
  writePath(path: string): void;
  resolveLoginPath(): Promise<string | null>;
  /**
   * The interactive login shell's PATH, for the second pass — in production
   * `loginShellPath()`, the `DETECTION_PROBE` answer detection has already
   * paid for and cached. Called LAZILY, only once the second pass runs, so
   * constructing a bootstrap never costs a shell startup and an app that
   * never opens a window never asks.
   */
  resolveInteractiveLoginPath(): Promise<string | null>;
  log(line: string): void;
}

export interface LoginPathBootstrap {
  /** Applies the already-started initial probe exactly once. Every caller gets this same promise. */
  apply(): Promise<LoginPathOutcome>;
  /**
   * The initial second pass, run once after the first window has loaded.
   * Sequenced behind {@link apply} rather than racing it: `process.env.PATH` then has one
   * writer at a time, and the boot merge can never be the loser of a late
   * resolve. Every caller shares the one attempt, like {@link apply}.
   */
  applyInteractive(): Promise<InteractivePathOutcome>;
  /**
   * Re-runs both passes against fresh answers. The caller owns any resolver
   * cache and must clear it before supplying the interactive resolver, so a
   * repair never adopts a profile state it measured before changing it.
   * Concurrent callers share one repair; a later explicit repair probes again.
   */
  repair(
    resolveLoginPath: () => Promise<string | null>,
    resolveInteractiveLoginPath: () => Promise<string | null>,
  ): Promise<SessionEnvRepair>;
  /**
   * What the second pass has reported SO FAR — synchronous on purpose.
   * `volli identify` must never await this: the pass is deliberately off the
   * critical path, and an identify that blocked on a wedged `.zshrc` would
   * spend the interactive probe's whole timeout answering a question about the
   * environment. `pending` IS the answer until it is not.
   */
  interactiveProvenance(): SessionEnvInteractiveProvenance;
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

  /**
   * One answer merged onto the live PATH and installed, for either pass. Shared
   * so the two invariants are stated once and cannot drift: nothing is ever
   * REMOVED — the merge is a union, so a directory a session could reach before
   * a pass stays reachable after it — and `binDir` goes back in front
   * afterwards, which is what makes the wrappers resolve at all.
   */
  const install = (
    loginPath: string | null,
  ): { outcome: LoginPathOutcome; before: string; after: string } => {
    const before = deps.readCurrentPath() ?? "";
    const outcome = decideLoginPathAdoption(before, loginPath);
    const merged = outcome.kind === "adopted" ? outcome.path : before;
    const after = [...new Set([deps.binDir, ...entriesOf(merged)])].join(":");
    deps.writePath(after);
    return { outcome, before, after };
  };

  let applyAttempt: Promise<LoginPathOutcome> | undefined;
  const applyInitial = (): Promise<LoginPathOutcome> => {
    applyAttempt ??= probeAttempt.then((loginPath) => {
      const { outcome } = install(loginPath);
      deps.log(loginPathLogLine(outcome));
      return outcome;
    });
    return applyAttempt;
  };

  let interactiveAttempt: Promise<InteractivePathOutcome> | undefined;
  let interactiveKind: SessionEnvInteractiveProvenance = "pending";
  const applyInteractiveInitial = (): Promise<InteractivePathOutcome> => {
    interactiveAttempt ??= applyInitial()
      // A rejected interactive probe is the same fact as one that answered
      // nothing: we could not ask, so there is nothing to merge.
      .then(() => deps.resolveInteractiveLoginPath().catch(() => null))
      .then((interactivePath) => {
        const { before, after } = install(interactivePath);
        const outcome = decideInteractiveAdoption(interactivePath, before, after);
        interactiveKind = outcome.kind;
        deps.log(interactivePathLogLine(outcome));
        return outcome;
      });
    return interactiveAttempt;
  };

  let repairAttempt: Promise<SessionEnvRepair> | undefined;
  const repair = (
    resolveLoginPath: () => Promise<string | null>,
    resolveInteractiveLoginPath: () => Promise<string | null>,
  ): Promise<SessionEnvRepair> => {
    if (repairAttempt !== undefined) return repairAttempt;

    const attempt = (async (): Promise<SessionEnvRepair> => {
      // An interactive pass already in flight owns the one PATH writer until
      // it resolves. A repair that raced it could overwrite a newer answer
      // with an older one, precisely the drift this bootstrap prevents.
      await applyInitial();
      if (interactiveAttempt !== undefined) await interactiveAttempt;

      const loginPath = await Promise.resolve()
        .then(resolveLoginPath)
        .catch(() => null);
      const bootInstall = install(loginPath);
      const bootOutcome = bootInstall.outcome;
      deps.log(loginPathLogLine(bootOutcome));

      const interactivePath = await Promise.resolve()
        .then(resolveInteractiveLoginPath)
        .catch(() => null);
      const interactiveInstall = install(interactivePath);
      const interactiveOutcome = decideInteractiveAdoption(
        interactivePath,
        interactiveInstall.before,
        interactiveInstall.after,
      );
      interactiveKind = interactiveOutcome.kind;
      deps.log(interactivePathLogLine(interactiveOutcome));

      // Later readers must describe this fresh, repaired PATH, not retain the
      // boot pass's old result after the repair has changed process.env.
      applyAttempt = Promise.resolve(bootOutcome);
      interactiveAttempt = Promise.resolve(interactiveOutcome);
      return {
        path: interactiveInstall.after,
        provenance: bootOutcome.kind,
        added: bootOutcome.kind === "adopted" ? bootOutcome.added : [],
        interactiveProvenance: interactiveOutcome.kind,
        interactiveAdded: interactiveOutcome.kind === "adopted" ? interactiveOutcome.added : [],
      };
    })();
    repairAttempt = attempt;
    const clearAttempt = (): void => {
      if (repairAttempt === attempt) repairAttempt = undefined;
    };
    void attempt.then(clearAttempt, clearAttempt);
    return attempt;
  };

  const apply = (): Promise<LoginPathOutcome> => {
    const activeRepair = repairAttempt;
    return activeRepair === undefined
      ? applyInitial()
      : activeRepair.then(() => applyAttempt as Promise<LoginPathOutcome>);
  };
  const applyInteractive = (): Promise<InteractivePathOutcome> => {
    const activeRepair = repairAttempt;
    return activeRepair === undefined
      ? applyInteractiveInitial()
      : activeRepair.then(() => interactiveAttempt as Promise<InteractivePathOutcome>);
  };

  return {
    apply,
    applyInteractive,
    repair,
    interactiveProvenance: () => interactiveKind,
  };
}

/**
 * What the second pass amounts to, judged on the PATH that was actually
 * INSTALLED rather than on the merge in isolation.
 *
 * The distinction only bites here. At boot `binDir` is typically not on the
 * PATH yet, so {@link decideLoginPathAdoption}'s verdict and the installed
 * result agree. By the second pass `binDir` is always already leading, and the
 * union orders login entries first — so the merged string can never equal the
 * current one, and reusing that verdict would report `adopted` for a pass that
 * changed nothing at all. Comparing what was written is the only reading that
 * stays true for both.
 */
function decideInteractiveAdoption(
  interactivePath: string | null,
  before: string,
  after: string,
): InteractivePathOutcome {
  if (interactivePath === null || interactivePath.length === 0) return { kind: "probe-failed" };
  if (after === before) return { kind: "already-complete" };
  const had = new Set(entriesOf(before));
  return {
    kind: "adopted",
    path: after,
    // Empty for a pass that only REORDERED — an rc that prepends a directory
    // already further down the PATH. That is a real change (it decides which
    // copy of a tool wins) and still adds nothing, so the two are reported
    // apart rather than counted together.
    added: entriesOf(after).filter((entry) => !had.has(entry)),
  };
}
