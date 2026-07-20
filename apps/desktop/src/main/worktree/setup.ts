/**
 * Setup-command sentinel helpers (worktree-support §6). The setup command runs
 * NOT here but in the PTY after spawn (a later wiring stage), typed into the
 * session terminal — never the pane's primary process (cmux #5032). These two
 * pure helpers are the contract that stage consumes: one builds the wrapped
 * line to type, the other scans accumulated terminal output for its completion
 * marker. Kept pure and side-effect-free so both ends unit-test trivially.
 */
import { basename } from "node:path";

/**
 * The sentinel marker's shape: `__VOLLI_SETUP_DONE:<exit-code>__`. Chosen so
 * the ECHOED command line can never false-match — see {@link
 * buildSetupSentinelLine}.
 */
const SENTINEL_PATTERN = /__VOLLI_SETUP_DONE:(\d+)__/g;

/**
 * Wraps `setupCommand` so its exit code is emitted on a line the watcher can
 * detect. The wrapper is SHELL-AWARE — fish is not POSIX-compatible, so the
 * POSIX subshell + `$?` form is a parse error there and the sentinel would
 * never print (the ticket sticks `setting-up` forever). Detected by the shell's
 * basename:
 *
 *   POSIX (bash/zsh/sh/…):  ( <cmd> ); printf '\n__VOLLI_SETUP_DONE:%d__\n' $?
 *   fish:            begin; <cmd>; end; printf '\n__VOLLI_SETUP_DONE:%d__\n' $status
 *
 * The GROUPING is load-bearing: a setup script that itself calls `exit N` (a
 * plausible pattern, caught by the worktree e2e smoke) would otherwise
 * terminate the interactive shell at top level — the sentinel would never
 * print. Inside `( … )` / `begin … end` the `exit` only ends the group, whose
 * code lands in `$?` / `$status` for the following `printf`.
 *
 * Crucially, the literal `%d` is what the shell ECHOES when the line is typed —
 * only AFTER `printf` runs does `%d` expand to the actual exit digit. So the
 * echoed command contains `__VOLLI_SETUP_DONE:%d__` (a literal `%d`, no
 * digits), which {@link parseSetupSentinel}'s `\d+` can never match — the
 * marker is unambiguous even though the command text scrolls past in the same
 * output buffer.
 */
export function buildSetupSentinelLine(setupCommand: string, shellPath: string): string {
  const printf = "printf '\\n__VOLLI_SETUP_DONE:%d__\\n'";
  // Login shells present as `-fish`; strip the leading `-` before matching.
  const shell = basename(shellPath).replace(/^-/, "");
  if (shell === "fish") {
    return `begin; ${setupCommand}; end; ${printf} $status`;
  }
  return `( ${setupCommand} ); ${printf} $?`;
}

/**
 * Scans accumulated terminal output `tail` for the sentinel and returns the
 * LAST match's exit code, or `null` if none is present yet (installs are slow;
 * "no sentinel yet" is not an error). Taking the last match tolerates the
 * caller passing a growing buffer across chunks — the real, expanded marker
 * always follows the echoed command. Because the echo carries a literal `%d`,
 * only the post-execution `printf` output ever satisfies `\d+`.
 */
export function parseSetupSentinel(tail: string): number | null {
  let last: number | null = null;
  for (const match of tail.matchAll(SENTINEL_PATTERN)) {
    last = Number.parseInt(match[1]!, 10);
  }
  return last;
}
