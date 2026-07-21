/**
 * Fake-harness scaffolding for the composer-kickoff smoke.
 *
 * The kickoff flow ("Create & start") is meant to auto-launch a coding-agent CLI
 * — `claude` by default (or `codex` / `opencode`) — *inside the ticket session's
 * PTY shell*, passing the ticket title+body as the initial prompt argument. The
 * terminal renders to a WebGPU canvas, so we can't read what it launched from the
 * DOM. Instead we make the launched binary itself testable: this module writes a
 * scratch bin dir whose `claude`/`codex`/`opencode` are tiny shell scripts that
 * append their argv to a probe file and exit 0. The smoke then polls that probe
 * file and asserts the recorded argv — proof of *which* binary ran and *with what
 * prompt*.
 *
 * Deterministic shadowing — the hard part
 * ---------------------------------------
 * The app's PTY spawns the user's `$SHELL` as a LOGIN shell (`zsh -l`, see
 * src/main/pty.ts). A login zsh sources, in order: /etc/zshenv, $ZDOTDIR/.zshenv,
 * /etc/zprofile (runs `path_helper`), $ZDOTDIR/.zprofile, /etc/zshrc,
 * $ZDOTDIR/.zshrc, … The two things that can reorder PATH and let a *real*
 * `claude` win over our fake are:
 *   1. the user's own ~/.zshrc (homebrew shellenv, manual PATH prepends, etc.),
 *   2. macOS `path_helper` in /etc/zprofile.
 * We defeat (1) by pointing ZDOTDIR at a scratch dir whose `.zshrc` deliberately
 * does NOT touch PATH — the user's real dotfiles are never sourced. We survive
 * (2) because `path_helper` rebuilds PATH as {/etc/paths entries} ++ {original
 * PATH, de-duped, order preserved}: our bin dir is *prepended* to PATH before
 * launch, and it lives in none of the /etc/paths files, so it stays ahead of any
 * real `claude` further down PATH (e.g. ~/.local/bin/claude). See the sanity
 * check below.
 *
 * The smoke launches Electron with:
 *   PATH = `${binDir}:${process.env.PATH}`
 *   ZDOTDIR = zdotDir
 *   VOLLI_FAKE_HARNESS_PROBE = probe
 *
 * Sanity check (run manually, outside the app — RESULT recorded here):
 *   Building the harness under a scratch dir and running
 *     zsh -lic 'which claude'
 *   with those env vars resolves to the fake `${binDir}/claude`, NOT the real
 *   ~/.local/bin/claude — confirming the shadow holds through a login shell's
 *   path_helper pass. `runShadowSanityCheck()` below performs exactly this and is
 *   invoked by the kickoff smoke as a precondition (its own numbered check), so a
 *   broken shadow is reported rather than silently passing a false negative.
 *
 * Interactive (stay-alive) mode — interrupt/resume smoke
 * --------------------------------------------------------
 * The kickoff smoke's fakes exit immediately (exit 0) — fine for proving WHAT
 * launched, useless for proving a live agent process receives/survives an Esc
 * byte (issue #78's backward-move interrupt). Passing `opts.interactiveDir` to
 * {@link buildFakeHarness} makes every fake ALSO, after recording argv, check
 * for `VOLLI_FAKE_HARNESS_INTERACTIVE_DIR` at runtime: when set (and the app's
 * own per-session `VOLLI_SESSION` env var is present — real ticket sessions
 * always carry it, see `volli-dir.ts`), the fake puts the pty in raw mode
 * (`stty raw -echo`, so a lone Esc arrives immediately instead of waiting on a
 * line-buffered newline) and `exec`s into `cat`, blocking forever while it
 * copies every stdin byte verbatim into `<dir>/<VOLLI_SESSION>.stdin` — keyed
 * by the app's own session id so concurrent sessions in one run never collide.
 * It never exits on its own; the smoke ends the session itself
 * (`window.api.terminal.kill`) once it's done asserting against the live
 * process. Without `interactiveDir` (the default), behavior is unchanged.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Build the scratch bin dir (fake claude/codex/opencode), the scratch ZDOTDIR
 * (PATH-neutral .zshrc), and return the paths the smoke feeds into Electron's env.
 *
 * @param {string} scratchDir  A writable scratch directory owned by the smoke.
 * @param {string} [probePath] Where the fakes append argv; defaults to
 *                             `<scratchDir>/harness-probe.txt`.
 * @param {{interactiveDir?: string}} [opts] `interactiveDir` opts every fake
 *   into stay-alive raw-stdin-capture mode (see the module header) instead of
 *   exiting immediately — the interrupt/resume smoke's needed shape.
 * @returns {Promise<{ binDir: string, zdotDir: string, probe: string,
 *                     binaries: string[], interactiveDir: string|null }>}
 */
export async function buildFakeHarness(scratchDir, probePath, opts = {}) {
  const binDir = join(scratchDir, "fake-bin");
  const zdotDir = join(scratchDir, "zdot");
  const probe = probePath ?? join(scratchDir, "harness-probe.txt");
  const interactiveDir = opts.interactiveDir ?? null;
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(zdotDir, { recursive: true });
  if (interactiveDir) await fs.mkdir(interactiveDir, { recursive: true });

  const binaries = ["claude", "codex", "opencode"];
  for (const name of binaries) {
    // POSIX sh (not zsh) so the fake is shell-agnostic. Records, on each launch:
    //   line 1: "$0 $@"  — the whole argv on one line ("<path>/claude <args…>")
    //   then:   one line per positional arg (a multi-line prompt arg spans lines)
    // The smoke asserts substrings against the file, so multi-line args are fine.
    // When VOLLI_FAKE_HARNESS_INTERACTIVE_DIR is set (interrupt/resume smoke
    // only — see the module header), the fake then puts the pty in raw mode and
    // blocks forever copying stdin verbatim into a per-session log instead of
    // exiting; otherwise (every other smoke) it exits 0 right after recording.
    const script = `#!/bin/sh
# Fake "${name}" harness for e2e kickoff / interrupt-resume probes. Records
# argv, then either exits 0 (default) or blocks copying raw stdin (interactive
# mode) — see fake-harness.mjs's module doc comment.
probe="\${VOLLI_FAKE_HARNESS_PROBE:-${probe}}"
{
  echo "$0 $@"
  for arg in "$@"; do
    echo "$arg"
  done
} >> "$probe"
if [ -n "$VOLLI_FAKE_HARNESS_INTERACTIVE_DIR" ] && [ -n "$VOLLI_SESSION" ]; then
  stty raw -echo 2>/dev/null
  exec cat >> "$VOLLI_FAKE_HARNESS_INTERACTIVE_DIR/$VOLLI_SESSION.stdin"
fi
exit 0
`;
    const file = join(binDir, name);
    await fs.writeFile(file, script, { mode: 0o755 });
    await fs.chmod(file, 0o755); // umask can strip the exec bits off the mode above
  }

  // A minimal login-shell rc that intentionally leaves PATH untouched, so the
  // prepended fake bin dir keeps priority (see the module header's rationale).
  await fs.writeFile(
    join(zdotDir, ".zshrc"),
    "# e2e scratch zshrc — deliberately does NOT modify PATH (see fake-harness.mjs)\n",
  );

  return { binDir, zdotDir, probe, binaries, interactiveDir };
}

/**
 * The env additions the smoke must merge over `process.env` when launching
 * Electron so the fake harness deterministically shadows any real one.
 * Adds `VOLLI_FAKE_HARNESS_INTERACTIVE_DIR` only when `buildFakeHarness` was
 * given an `interactiveDir` — every other smoke's fakes keep exiting immediately.
 */
export function harnessEnv({ binDir, zdotDir, probe, interactiveDir }) {
  return {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    ZDOTDIR: zdotDir,
    VOLLI_FAKE_HARNESS_PROBE: probe,
    ...(interactiveDir ? { VOLLI_FAKE_HARNESS_INTERACTIVE_DIR: interactiveDir } : {}),
  };
}

/**
 * Read one session's raw stdin-capture log (interactive mode only), or `null`
 * if it doesn't exist yet (the fake hasn't reached its capture loop, or never
 * ran). Returns a Buffer (not a string) — the whole point is catching a raw
 * control byte like Esc (`0x1b`), which a naive utf8 round-trip could mangle.
 *
 * @param {string} interactiveDir
 * @param {string} sessionId
 */
export async function readStdinLog(interactiveDir, sessionId) {
  try {
    return await fs.readFile(join(interactiveDir, `${sessionId}.stdin`));
  } catch {
    return null;
  }
}

/**
 * Verify the shadow OUTSIDE Electron: launch a login+interactive zsh with the
 * harness env and resolve `which <bin>`. Mirrors exactly the shell the app's PTY
 * spawns (`zsh -l`), so a pass here is strong evidence the in-app launch will hit
 * the fake. Returns `{ ok, resolved }` where `resolved` is the absolute path zsh
 * picked for `bin`.
 *
 * @param {{binDir:string, zdotDir:string, probe:string}} env
 * @param {string} [bin="claude"]
 */
export async function runShadowSanityCheck(env, bin = "claude") {
  const expected = join(env.binDir, bin);
  try {
    const { stdout } = await execFileAsync("/bin/zsh", ["-lic", `which ${bin}`], {
      env: { ...process.env, ...harnessEnv(env) },
    });
    const resolved = stdout.trim().split("\n").pop()?.trim() ?? "";
    return { ok: resolved === expected, resolved, expected };
  } catch (error) {
    return { ok: false, resolved: `threw: ${error?.message ?? error}`, expected };
  }
}
