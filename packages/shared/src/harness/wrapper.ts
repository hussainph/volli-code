/**
 * The PATH shim that turns a harness invocation inside a Volli session into a
 * configured one, and leaves every other invocation alone.
 *
 * A wrapper is a passthrough. With `VOLLI_SESSION` unset it execs the real
 * binary unchanged, so a harness run from a normal terminal is untouched —
 * nothing is written to the user's harness configuration, ever. Volli's `bin/`
 * is already prepended to PATH for Volli's PTYs and nothing else
 * (`agentSessionEnv`), so these wrappers are only ever reachable from inside a
 * session in the first place.
 *
 * Everything that is true of ONE harness is rendered INTO its own wrapper — the
 * binary main resolved for it, and the configuration it reads out of its own
 * environment — because a wrapper runs one step before its own exec and nothing
 * else does. What travels in the session environment instead is only what has to
 * exist BEFORE a wrapper runs: `VOLLI_HARNESS_ARGV_<SLUG>`, the argv main
 * resolved (it names files on disk), and the `VOLLI_HARNESS_BIN_<SLUG>`
 * override. Those are namespaced per harness and read by the wrapper alone; a
 * harness's own configuration variable is not, and setting it session-wide would
 * tell every agent in the terminal about a harness that is not running.
 */
import { shellSingleQuote } from "../harness-command";
import { harnessEnvSuffix } from "./launch";
import type { HarnessAdapter } from "./types";

/**
 * Why a wrapper was declined. Three rules, one channel: whatever the reason, the
 * harness ends up unwrapped, and `volli doctor` has to say so rather than let a
 * silently missing wrapper read as a working install.
 *
 * `shadows-system-command` — the name is a system tool's.
 * `name-already-owned` — the name belongs to another harness's wrapper or to the
 * launcher, and `bin/` is one file per name.
 * `argv-not-transportable` — the argv could not survive the newline-delimited
 * hand-off the wrapper splits on (see {@link renderWrapperScript}).
 *
 * Lives here rather than beside the loop that applies the rules because the
 * refusal has two ends: main decides it, and `volli doctor` has to explain it.
 * A second union on the reporting end would drift the moment a fourth rule is
 * added, and the drift would show up as a refusal reported under the wrong
 * reason — the one failure mode a diagnostic must not have.
 */
export type WrapperRefusal =
  | "shadows-system-command"
  | "name-already-owned"
  | "argv-not-transportable";

export interface WrapperInput {
  /** Volli's own `bin/` — skipped while resolving, or the wrapper would exec itself. */
  binDir: string;
  /**
   * The binary this command resolved to when main wrote the wrapper, or `null`
   * when main could not resolve one. Pinning it is what makes the file a human
   * approved in the trust dialog the file that actually runs.
   */
  binaryPath: string | null;
  /**
   * This harness's own injected configuration, already resolved to real paths —
   * `CURSOR_CONFIG_DIR`, `OPENCODE_CONFIG`. Exported by the wrapper, in scope
   * for the harness it configures and nothing else.
   */
  env: Readonly<Record<string, string>>;
}

/**
 * A `case` pattern matching a resume token both bare (`--resume`) and with an
 * attached value (`--resume=abc`), since a harness may take either.
 */
function resumePattern(token: string): string {
  return `${shellSingleQuote(token)}|${shellSingleQuote(`${token}=`)}*`;
}

/**
 * The wrapper for `adapter`, to be written into `binDir`.
 *
 * **The harness session id IS `VOLLI_SESSION`.** There is no second id and no
 * mapping table: Volli session ids are already UUIDs, so they satisfy the
 * format harnesses like Claude Code demand, and `sessions.harness_session_id`
 * correlates to the Volli session by being the same string. Nothing else may
 * mint one — {@link buildLaunchConfig} deliberately cannot.
 *
 * The hazard that follows, recorded rather than engineered around: a harness
 * that rejects a session id it has already seen will fail if a Volli session id
 * is reused across launches without a resume flag.
 */
export function renderWrapperScript(adapter: HarnessAdapter, input: WrapperInput): string {
  const suffix = harnessEnvSuffix(adapter);
  const binVar = `VOLLI_HARNESS_BIN_${suffix}`;
  const argvVar = `VOLLI_HARNESS_ARGV_${suffix}`;
  const command = shellSingleQuote(adapter.command);
  const binDir = shellSingleQuote(input.binDir);

  const lines: string[] = [
    "#!/bin/sh",
    `# Volli wrapper for ${adapter.label}. Generated — edits are overwritten.`,
    "set -u",
    "",
    // Three ways to find the binary, in this order on purpose.
    //
    // First, an explicit override, ahead of everything else: it is the only way
    // to aim a wrapper at a binary main never saw, which is what an operator
    // debugging an install and the execution smoke both need.
    `volli_real=\${${binVar}:-}`,
  ];

  if (input.binaryPath !== null) {
    const binaryPath = shellSingleQuote(input.binaryPath);
    lines.push(
      // Second, the file main resolved when it wrote this wrapper — the same
      // walk, over the same login-shell PATH, that named a binary in the trust
      // dialog when a human approved this harness. Pinned here because PATH at
      // run time is whatever the user's own shell startup rebuilt, so re-walking
      // it could exec something nobody was shown.
      `if [ -z "$volli_real" ] && [ -x ${binaryPath} ]; then`,
      `  volli_real=${binaryPath}`,
      "fi",
    );
  }

  lines.push(
    // Third, the walk. Reached when main pinned nothing — a built-in that was
    // never trust-prompted on a host whose login shell PATH could not be read —
    // or when the pinned file is gone, which means the harness was uninstalled
    // or moved and our own "cannot find" is a better error than exec's.
    'if [ -z "$volli_real" ]; then',
    "  volli_saved_ifs=$IFS",
    "  IFS=:",
    // Unquoted $PATH is subject to pathname expansion; -f turns it off just
    // for the walk, so a PATH entry holding a glob character stays literal.
    "  set -f",
    "  for volli_dir in $PATH; do",
    // Volli's own bin dir holds this very script; walking into it would exec us.
    `    if [ "$volli_dir" = ${binDir} ] || [ -z "$volli_dir" ]; then continue; fi`,
    `    if [ -x "$volli_dir/${adapter.command}" ]; then`,
    `      volli_real="$volli_dir/${adapter.command}"`,
    "      break",
    "    fi",
    "  done",
    "  set +f",
    "  IFS=$volli_saved_ifs",
    "fi",
    "",
    'if [ -z "$volli_real" ]; then',
    `  printf 'volli: cannot find %s\\n' ${command} >&2`,
    "  exit 127",
    "fi",
    "",
    'if [ -z "${VOLLI_SESSION:-}" ]; then',
    '  exec "$volli_real" "$@"',
    "fi",
    "",
  );

  const envEntries = Object.entries(input.env);
  if (envEntries.length > 0) {
    lines.push(
      // In scope for the harness this wrapper execs, and for nothing else. Name
      // and value are quoted as ONE operand, so a name that is not a name at all
      // is an export that fails and says so, never a line of shell.
      "# Configuration this harness reads out of its own environment.",
      ...envEntries.map(([name, value]) => `export ${shellSingleQuote(`${name}=${value}`)}`),
      "",
    );
  }

  if (adapter.sessionId.kind === "argv" && adapter.resume.userResumeTokens.length > 0) {
    lines.push(
      "# The user is driving resume themselves — don't fight them for the session.",
      "volli_user_resume=0",
      'for volli_arg in "$@"; do',
      "  case $volli_arg in",
      `    ${adapter.resume.userResumeTokens.map((token) => resumePattern(token)).join("|")})`,
      "      volli_user_resume=1",
      "      break",
      "      ;;",
      "  esac",
      "done",
      "",
    );
  }

  const sessionArgs =
    adapter.sessionId.kind === "argv"
      ? [shellSingleQuote(adapter.sessionId.flag), '"$VOLLI_SESSION"']
      : [];
  /**
   * The configured argv, prepended to whatever the user typed.
   *
   * `${VAR}` is left unquoted deliberately, and that is the whole mechanism:
   * main joins the argv words with newlines, IFS is newline for exactly this
   * expansion, and the shell FIELD-SPLITS the value into one word per line. It
   * does not parse it. The result of an expansion is never rescanned, so a
   * `$(…)`, a backtick, a quote or a lone backslash inside a settings payload
   * reaches the harness as the characters it is — which is why nothing here is
   * quoted by us, and nothing here depends on our quoting being right.
   *
   * The invariant that buys it: no argv word may contain a newline or be empty
   * (newline is IFS whitespace, so runs of it collapse). `ensureHarnessRuntime`
   * refuses to write a wrapper whose argv would break it rather than hand the
   * harness a mangled command line.
   */
  const applyArgv = (indent: string, extra: readonly string[]): string =>
    [`${indent}set --`, `\${${argvVar}:-}`, ...extra, '"$@"'].join(" ");

  lines.push("volli_saved_ifs=$IFS", "IFS='", "'", "set -f");
  if (sessionArgs.length > 0 && adapter.resume.userResumeTokens.length > 0) {
    lines.push(
      'if [ "$volli_user_resume" = 1 ]; then',
      applyArgv("  ", []),
      "else",
      applyArgv("  ", sessionArgs),
      "fi",
    );
  } else {
    lines.push(applyArgv("", sessionArgs));
  }
  lines.push("set +f", "IFS=$volli_saved_ifs");

  lines.push("", 'exec "$volli_real" "$@"', "");
  return lines.join("\n");
}
