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
 * The per-session half of the configuration arrives in the environment rather
 * than in the script, because the script is written once and a session id is
 * minted per launch: `VOLLI_HARNESS_ARGV_<SLUG>` holds shell-quoted argv from
 * `buildLaunchConfig`, and the session id is `VOLLI_SESSION` itself.
 */
import { shellSingleQuote } from "../harness-command";
import { harnessEnvSuffix } from "./launch";
import type { HarnessAdapter } from "./types";

export interface WrapperInput {
  /** Volli's own `bin/` — skipped while resolving, or the wrapper would exec itself. */
  binDir: string;
}

/**
 * A `case` pattern matching a resume token both bare (`--resume`) and with an
 * attached value (`--resume=abc`), since a harness may take either.
 */
function resumePattern(token: string): string {
  return `${shellSingleQuote(token)}|${shellSingleQuote(`${token}=`)}*`;
}

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
    `volli_real=\${${binVar}:-}`,
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
    `  printf 'volli: cannot find %s on PATH\\n' ${command} >&2`,
    "  exit 127",
    "fi",
    "",
    'if [ -z "${VOLLI_SESSION:-}" ]; then',
    '  exec "$volli_real" "$@"',
    "fi",
    "",
  ];

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
      ? ` ${shellSingleQuote(adapter.sessionId.flag)} \\"\\$VOLLI_SESSION\\"`
      : "";
  const setArgs = (extra: string): string => `eval "set -- \${${argvVar}:-}${extra} \\"\\$@\\""`;

  if (sessionArgs && adapter.resume.userResumeTokens.length > 0) {
    lines.push(
      'if [ "$volli_user_resume" = 1 ]; then',
      `  ${setArgs("")}`,
      "else",
      `  ${setArgs(sessionArgs)}`,
      "fi",
    );
  } else {
    lines.push(setArgs(sessionArgs));
  }

  lines.push("", 'exec "$volli_real" "$@"', "");
  return lines.join("\n");
}
