/**
 * The PATH the user actually has, as opposed to the one Electron was handed.
 *
 * A macOS app opened from Finder or the Dock inherits launchd's environment —
 * `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Every toolchain worth
 * finding installs somewhere else (`/opt/homebrew/bin`, `~/.local/bin`,
 * `~/.bun/bin`, `~/Library/pnpm`), so `process.env.PATH` in main is a launcher
 * accident rather than a fact about the host: it is right under `pnpm dev`,
 * where a terminal exported the login shell's environment, and wrong in every
 * real install. The login shell is the authority, and this module is the one
 * place that asks it.
 *
 * Two callers ask, for different reasons, and the reasons are PARAMETERS —
 * {@link DETECTION_PROBE} and {@link ADOPTION_PROBE}. Detection (harness
 * discovery, Settings → CLI, `volli doctor`) asks what a spawned PTY would
 * see, and a PTY is genuinely interactive. Boot adoption
 * (`login-path-adoption.ts`) asks what main may safely install as its own
 * PATH before any window exists. They differ in shell flags, in what they will
 * wait for, and in how far they trust a shell that left badly.
 *
 * Until VC-94's A2 they differed by living in two modules, and that is how they
 * came to disagree about what a valid PATH even is: one parser accepted the
 * string the other threw away whole, so every screen reported a healthy
 * environment that no session ever had, for months, with nothing anywhere
 * comparing the two answers. Two askers is a real requirement; two notions of a
 * valid PATH was never one. One parser now answers both, and a new difference
 * has to be written down as a field to exist at all.
 */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { resolveShell } from "@volli/shared";

/**
 * `printenv` rather than an `echo $PATH`: it prints what the shell *exports* to
 * a child process, which is the colon-joined string every caller here wants,
 * and it is the one spelling that survives fish — where `$PATH` is a list and
 * `echo` would join it with spaces.
 *
 * The marker is what makes the answer findable in a profile's chatter. A
 * profile is allowed to talk, and an interactive one talks on BOTH sides of us:
 * a `TRAPEXIT` or a job-control warning prints after `printenv` has already
 * run, which a "last non-empty line" read would happily return as the user's
 * PATH. Printed without a trailing newline, so the value follows on the same
 * line and no amount of noise around it can be mistaken for it.
 */
const PATH_MARKER = "__VOLLI_PATH__";
const PRINT_PATH_COMMAND = `printf ${PATH_MARKER}; printenv PATH`;

/** What turns `$SHELL -l` into the interactive login shell a tty would make it. */
const INTERACTIVE_FLAG = "-i";

/**
 * What separates one asker from the other. Everything not named here — the
 * marker, the spawn hygiene, the parser, what counts as a usable entry — is
 * shared on purpose, because every one of those was a place the two probes
 * drifted apart while both looked correct in isolation.
 */
export interface LoginShellProbe {
  /**
   * Ask an interactive login shell (`-l -i`) rather than a plain one (`-l`).
   *
   * zsh reads `.zshrc` only when interactive: measured against a probe
   * `ZDOTDIR`, a PATH entry added there is invisible to `-lc` and present under
   * `-lic`. `.zshrc` is where nvm, bun, rbenv, pyenv and mise all
   * conventionally initialise, so interactive is by some margin the more
   * complete answer — and the more dangerous one, because an rc file is free to
   * prompt, and a prompt with nobody in front of it is a hang rather than a
   * slow answer. Which risk is affordable depends on who is asking and when.
   */
  interactive: boolean;
  /** How long a profile may take before its process group is killed. */
  timeoutMs: number;
  /** What a profile that spews can cost in memory before this stops listening. */
  maxOutputBytes: number;
  /**
   * Refuse the answer of a shell that did not exit cleanly, rather than
   * trusting the marked line it printed on the way out.
   *
   * The marker vouches for the value either way; what differs is the cost of
   * being wrong. See both probes below — this is the field where their stances
   * are opposite, and deliberately so.
   *
   * What makes the marker's guarantee stronger than it looks: our command runs
   * with `-c`, AFTER the shell has read its rc files. A shell killed mid-
   * profile therefore never printed a marker at all and parses to `null`. The
   * "killed, but it had printed something plausible first" case the strict
   * stance fears cannot present as a short-but-valid PATH; it presents as no
   * answer. That is why {@link DETECTION_PROBE} can be forgiving without being
   * reckless — and why VC-94's A3 can adopt from it. See there.
   */
  requireCleanExit: boolean;
}

/** The limits {@link LoginShellProbeDeps.runShell} enforces on one spawn. */
export type ShellRunLimits = Pick<LoginShellProbe, "timeoutMs" | "maxOutputBytes">;

/**
 * What a spawned PTY would see. `resolveShell` puts `$SHELL -l` onto a tty and
 * a tty on stdin is what makes zsh interactive, so detection asks the
 * interactive question: a harness Volli reports is then a harness a session PTY
 * could actually run, which is the only question detection is asking. Asking
 * without `-i` would drop a harness the user can plainly type from detection,
 * from wrapper generation and from every hook that follows.
 *
 * The interactive hazard is affordable here precisely because nothing is
 * blocked on the answer and a failure is re-asked — see {@link loginShellPath}.
 * Three seconds is generous next to a shell's own startup and tight next to a
 * boot; a megabyte is what a chatty profile may cost before this stops reading.
 *
 * A shell that exits nonzero is still believed. What it printed before it left
 * is what the marker vouches for, and a login shell exiting nonzero is
 * ordinary — a `.zlogout` ending in a failing command does not make the PATH
 * that shell exported a lie. Only an unusable answer becomes `null`.
 *
 * VC-94's A3 puts this forgiving answer through a PATH MUTATION — the second,
 * post-window adoption pass in `login-path-adoption.ts` — which is the one
 * thing {@link ADOPTION_PROBE}'s opposite stance exists to refuse. Three
 * reasons that is sound here and not there, in decreasing order of weight:
 *
 * 1. **The second pass only ADDS.** Boot adoption REPLACES: if its answer is
 *    short, the app runs short, which is why it may not gamble. The second
 *    pass merges onto an already-adopted PATH and removes nothing, so
 *    believing a degraded answer costs strictly less than not asking at all.
 * 2. **A dirty exit cannot mean a truncated PATH.** See
 *    {@link LoginShellProbe.requireCleanExit}: the marked value is printed
 *    after the rc files, so a shell killed in them yields `null` rather than
 *    a plausible-looking subset.
 * 3. **PTY equivalence is the point.** A session PTY runs `$SHELL -l` on a tty
 *    and takes whatever PATH the rc files leave behind, whatever status the
 *    shell later exits with. Refusing an answer here for a nonzero exit would
 *    make structured sessions disagree with PTY sessions in exactly the way
 *    A3 exists to stop.
 *
 * What the second pass requires INSTEAD of a clean exit is stated where it
 * runs: that boot adoption has already been applied (one writer at a time),
 * that the answer parsed at all, and that the merge is the same additive,
 * `binDir`-first union boot uses.
 */
export const DETECTION_PROBE: LoginShellProbe = {
  interactive: true,
  timeoutMs: 3000,
  maxOutputBytes: 1 << 20,
  requireCleanExit: false,
};

/**
 * What main may install as `process.env.PATH` at boot. Deliberately NOT
 * interactive: this runs before any window exists, and an rc file that stops to
 * ask something would block with nothing on screen to answer it. A boot that
 * can hang is a worse trade than a PATH that is merely incomplete, and it stays
 * this way. The `.zshrc` directories that trade costs are recovered by the
 * SECOND pass (VC-94's A3, `login-path-adoption.ts`), which asks the
 * interactive question once the first window exists and there is somewhere for
 * a prompt to hang harmlessly. Until that pass lands, the answer here is not
 * the whole environment and `volli identify` says so — `env.interactiveProvenance`
 * reads `pending`.
 *
 * Four seconds because this one is on the boot path and gets no retry — main
 * asks exactly once per launch. 64KB because nothing downstream needs a
 * profile's greeting, only the marked line at the end of it.
 *
 * And unlike detection, a shell that did not exit cleanly is not believed at
 * all. This answer becomes the PATH of the whole app and of every structured
 * session's shell tool downstream of it; "killed mid-profile, but it had
 * printed something plausible first" is not a basis for that. Detection can
 * afford to be wrong for one launch and ask again. Adoption cannot.
 */
export const ADOPTION_PROBE: LoginShellProbe = {
  interactive: false,
  timeoutMs: 4000,
  maxOutputBytes: 1 << 16,
  requireCleanExit: true,
};

/** How one shell run ended, and what it managed to print. */
export interface LoginShellRun {
  stdout: string;
  exitCode: number | null;
  /** Set for a timeout too: this module's own SIGKILL is still a signal death. */
  signal: NodeJS.Signals | null;
}

export interface LoginShellProbeDeps {
  env: Record<string, string | undefined>;
  /** Runs the shell. `null` when it could not be run at all. */
  runShell(
    file: string,
    args: readonly string[],
    limits: ShellRunLimits,
  ): Promise<LoginShellRun | null>;
}

/**
 * Spawns the shell and returns what it printed and how it ended.
 *
 * Spawned rather than `execFile`d, because under `-i` the file being read is
 * the user's `.zshrc`, and a `.zshrc` does things that are ordinary in a
 * terminal and hostile in a probe. Both hazards were measured, and both are
 * worse than the timeout they look like:
 *
 * **stdin is `/dev/null`, never a pipe.** An rc that reads stdin — a prompt
 * framework asking a question, a version manager confirming an install — blocks
 * on a pipe nothing will ever write to. `execFile` leaves one open: the same rc
 * answers in 200ms against `/dev/null`.
 *
 * **The timeout kills the process GROUP.** A killed shell whose profile left a
 * foreground command running (`sleep`, `exec tmux`) does not end the read: the
 * grandchild inherits the stdout pipe and holds it open, so the call never
 * completes at all — a hang with no timeout, and a stray process per launch.
 * `detached` puts the shell in its own group; killing the group takes down
 * whatever the profile started along with it.
 *
 * A timeout is then reported as the SIGKILL it was, whatever `close` says the
 * shell's own exit was. The shell that prints its PATH and then leaves a
 * grandchild holding the pipe is exactly the case where `close` can arrive
 * carrying an exit code of 0 — and a caller that requires a clean exit is
 * asking about the whole probe, not about the first process in it.
 */
async function runLoginShell(
  file: string,
  args: readonly string[],
  limits: ShellRunLimits,
): Promise<LoginShellRun | null> {
  const child = spawn(file, [...args], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  let killedByTimeout = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (output.length < limits.maxOutputBytes) output += chunk;
  });
  const timer = setTimeout(() => {
    killedByTimeout = true;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone, which is the outcome the kill was after.
    }
  }, limits.timeoutMs);
  try {
    const ended = await new Promise<Omit<LoginShellRun, "stdout"> | null>((resolve) => {
      // `close`, not `exit`: the pipe outliving the shell is the whole hazard,
      // so the read is done when nothing is holding it any more.
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
      child.once("error", () => resolve(null));
    });
    if (ended === null) return null;
    return killedByTimeout
      ? { stdout: output, exitCode: null, signal: "SIGKILL" }
      : { stdout: output, ...ended };
  } finally {
    clearTimeout(timer);
  }
}

function processDeps(): LoginShellProbeDeps {
  return { env: process.env, runShell: runLoginShell };
}

/**
 * Whether a shell could actually run a command out of this PATH entry.
 *
 * ABSOLUTE, because a shell resolves a relative entry against the cwd of
 * whatever it happens to be running in, which is not a directory anyone chose.
 * NON-EMPTY, because an empty entry means the current directory to a shell, and
 * a PATH that runs commands out of the cwd is never safe to adopt. And NO
 * CONTROL CHARACTERS: a directory name carries none, so an entry with one was
 * written by something other than our own `printf` — an interactive shell's
 * colour codes landing on the same stream — and names a path nobody has.
 */
function isUsableEntry(entry: string): boolean {
  return (
    entry.length > 0 &&
    isAbsolute(entry) &&
    ![...entry].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}

/**
 * The PATH out of one shell's output, or `null` when nothing usable was in it.
 *
 * The LAST usable marker wins. A shell run with `xtrace` echoes the command
 * itself — marker and all — before running it, and the echo necessarily
 * precedes the run; an rc file is free to print our marker too. Ours runs last.
 * Earlier markers are retried rather than abandoned, so a decoy that yields
 * nothing usable does not cost the real answer behind it.
 *
 * Entries are FILTERED, never judged as a set: a PATH is a list of independent
 * directories, and one malformed member has no business invalidating its
 * neighbours. The measured case (VC-94): `/etc/paths.d/dotnet-cli-tools`
 * contributes the literal text `~/.dotnet/tools` — an unexpanded tilde, written
 * by Microsoft's .NET CLI installer — to every login shell on the host, and the
 * old all-or-nothing rule discarded 20 good entries along with it, leaving
 * structured sessions on launchd's bare four. `null` means only that NO entry
 * survived.
 *
 * That filter is now what DETECTION reports too (VC-94's A2). It used to accept
 * the tilde entry and report it as part of the host's PATH, which made the
 * Settings pane describe a directory no shell would ever search: detection has
 * no more business reporting an entry a shell cannot use than adoption has
 * adopting it.
 */
export function parseLoginShellPathOutput(stdout: string): string | null {
  let markerIndex = stdout.lastIndexOf(PATH_MARKER);
  while (markerIndex !== -1) {
    const valueStart = markerIndex + PATH_MARKER.length;
    const lineEnd = stdout.indexOf("\n", valueStart);
    const value = stdout.slice(valueStart, lineEnd === -1 ? undefined : lineEnd).trim();
    const entries = value.split(":").filter(isUsableEntry);
    if (entries.length > 0) return entries.join(":");
    markerIndex = markerIndex === 0 ? -1 : stdout.lastIndexOf(PATH_MARKER, markerIndex - 1);
  }
  return null;
}

/**
 * Asks one login shell for its exported PATH, the way `probe` says to ask.
 *
 * `null` is "we could not ask", and is never an empty PATH — the two lead to
 * opposite decisions downstream, where one means keep what you have and the
 * other would mean the host has nothing.
 */
export async function probeLoginShellPath(
  probe: LoginShellProbe,
  deps: LoginShellProbeDeps = processDeps(),
): Promise<string | null> {
  const { file, args } = resolveShell(deps.env);
  const shellArgs = [
    ...args,
    ...(probe.interactive ? [INTERACTIVE_FLAG] : []),
    "-c",
    PRINT_PATH_COMMAND,
  ];
  let run: LoginShellRun | null;
  try {
    run = await deps.runShell(file, shellArgs, probe);
  } catch {
    // A missing shell, a rejected spawn: we could not ask.
    return null;
  }
  if (run === null) return null;
  if (probe.requireCleanExit && (run.exitCode !== 0 || run.signal !== null)) return null;
  return parseLoginShellPathOutput(run.stdout);
}

let cached: Promise<string | null> | undefined;

/**
 * The {@link DETECTION_PROBE} answer, resolved once per launch. Detection runs
 * on the boot path and again on every skill refresh, and none of them should
 * pay for a second shell startup.
 *
 * An ANSWER is what is cached — never a failure. A profile that hangs once past
 * the probe's timeout is a transient, and latching its `null` would make it
 * permanent: detection stays unanswerable, the adapter census stays `partial`,
 * no stale wrapper is ever reconciled, and `volli doctor --fix` cannot repair it
 * because repair re-asks the same latched cache. Only quitting the app would. So
 * a failed attempt drops itself and the next caller pays for one more shell —
 * the cost of a retry, against an app that is wrong until it is restarted.
 *
 * The retry is also what makes probing an INTERACTIVE shell safe to ship, so the
 * two are not separable: `-i` runs the user's `.zshrc`, and an rc file that
 * wedges the probe is now a boot that costs three seconds rather than a launch
 * that never detects anything again. Removing this as redundant would put that
 * back.
 *
 * In-flight attempts are still shared, so the boot fan-out spawns one shell and
 * not five. That sharing is what VC-94's A3 rides: the post-window interactive
 * pass asks THIS function, so closing the `.zshrc` gap costs no second shell
 * and introduces no second notion of the truth — on a boot that has already
 * detected harnesses, the pass is a cache read.
 */
export function loginShellPath(deps: LoginShellProbeDeps = processDeps()): Promise<string | null> {
  if (cached !== undefined) return cached;
  const attempt = probeLoginShellPath(DETECTION_PROBE, deps);
  cached = attempt;
  // Compared by identity, so a `reset` (or a retry that already started) is
  // never clobbered by a straggler resolving late.
  const forget = (): void => {
    if (cached === attempt) cached = undefined;
  };
  void attempt.then((value) => {
    if (value === null) forget();
  }, forget);
  return attempt;
}

/**
 * Drops the per-launch cache so the next call resolves against a fresh shell.
 * Called by tests, and by `ensureUserBinOnPath` (agent-tools.ts) the moment it
 * writes the PATH block into `~/.zprofile` — the cached answer was measured
 * against the profile as it was BEFORE that write, and holding it would leave
 * every later reader (the Settings → CLI pane's Login PATH row above all)
 * describing a shell that no longer exists.
 */
export function resetLoginShellPathCache(): void {
  cached = undefined;
}
