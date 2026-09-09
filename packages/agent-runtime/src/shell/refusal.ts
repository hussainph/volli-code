import { lexCommandLine, splitProgram, type LexedSegment } from "../authority/vendor/shell";

/**
 * The refusal a background shell port answers with when it judged an action
 * and declined it (VC-270) — {@link ../browser/refusal.BrowserRefusal}'s
 * bargain, spelled for shells, and typed here so the runtime's tools and the
 * desktop's host agree on what a refusal is without either importing the
 * other's internals.
 *
 * A refusal is the policy working, not the port failing: the action was
 * understood, judged and not performed, and the model is the party that can
 * act on that — by killing a shell it no longer needs, naming one it holds, or
 * continuing without. The tools translate it into readable text rather than a
 * failed call; anything else a port throws is a host that could not answer at
 * all, and fails the call as every broken port does.
 *
 * `rule` is an open string for the reason the browser's is: the rules belong
 * to the host that enforces them (`shell.limit`, `shell.unknown`,
 * `shell.exited`, `shell.cwd`), and the runtime's only obligation is to name
 * the rule in the transcript so a person can find the policy that produced it.
 */
export class ShellRefusal extends Error {
  readonly rule: string;

  constructor(rule: string, reason: string) {
    super(reason);
    this.name = "ShellRefusal";
    this.rule = rule;
  }
}

const DIRECT_DAEMONIZERS = new Set(["nohup", "setsid", "disown", "start-stop-daemon"]);
const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_SHELL_NESTING = 3;
const EXECUTE_BACKGROUND_RULE = "shell.execute-background";

/** The executable's basename, without changing case-sensitive shell semantics. */
function executableName(program: string): string {
  return program.slice(program.lastIndexOf("/") + 1);
}

/** The daemonising vocabulary a lexed command segment spells, when it does. */
function daemonizingForm(segment: LexedSegment): string | undefined {
  const { program, args } = splitProgram(segment.words);
  const executable = executableName(program);
  if (DIRECT_DAEMONIZERS.has(executable)) return executable;
  if (
    executable === "screen" &&
    args.some((arg) => arg === "-d" || arg === "-dm" || arg.startsWith("-dm"))
  ) {
    return "screen -d";
  }
  if (
    executable === "tmux" &&
    args.some((arg) => arg === "new" || arg === "new-session") &&
    args.some((arg) => arg === "-d" || arg.startsWith("-d"))
  ) {
    return "tmux new -d";
  }
  if (executable === "launchctl" && args.includes("submit")) return "launchctl submit";
  return undefined;
}

/**
 * Whether the last pipeline is put in the background with `&`.
 *
 * The lexer keeps a quoted or escaped ampersand in the final segment's text,
 * but consumes an operator that separates commands. Comparing those two views
 * avoids treating `printf '&'`, `printf \\&`, redirects, or a trailing `&&` as
 * background execution.
 */
function hasTrailingBackgroundOperator(
  command: string,
  segments: readonly LexedSegment[],
): boolean {
  const trimmed = command.trimEnd();
  const finalSegment = segments.at(-1);
  return (
    finalSegment !== undefined &&
    trimmed.endsWith("&") &&
    !trimmed.endsWith("&&") &&
    !finalSegment.text.trimEnd().endsWith("&")
  );
}

/** A script passed to a shell's `-c` option, including combined options such as `-lc`. */
function nestedShellScript(segment: LexedSegment): string | undefined {
  const { program, args } = splitProgram(segment.words);
  if (!SHELL_EXECUTABLES.has(executableName(program))) return undefined;
  const commandOption = args.findIndex((arg) => /^-[^-]*c/.test(arg));
  if (commandOption === -1) return undefined;
  const candidate = commandOption + 1;
  return args[candidate] === "--" ? args[candidate + 1] : args[candidate];
}

/** Find one refused form, following ordinary nested `sh -c` wrappers to a small bound. */
function daemonizingCommandForm(command: string, depth = 0): string | undefined {
  let segments: LexedSegment[];
  try {
    segments = lexCommandLine(command);
  } catch {
    // Let the shell describe malformed syntax; this policy only judges forms it
    // can identify as requests for background lifetime.
    return undefined;
  }
  if (hasTrailingBackgroundOperator(command, segments)) return "a trailing &";
  const direct = segments.map(daemonizingForm).find((match) => match !== undefined);
  if (direct !== undefined || depth >= MAX_SHELL_NESTING) return direct;
  for (const segment of segments) {
    const script = nestedShellScript(segment);
    if (script === undefined) continue;
    const nested = daemonizingCommandForm(script, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Refuse daemonising syntax at `execute`'s waited-process door.
 *
 * This is a usability guardrail, not process containment: like the small lexer
 * it uses, generated or deeply nested shell text can evade inspection. The
 * process-group cleanup in the execution environment is the lifecycle backstop.
 */
export function refuseDaemonizingExecute(command: string): ShellRefusal | undefined {
  const form = daemonizingCommandForm(command);
  if (form === undefined) return undefined;
  return new ShellRefusal(
    EXECUTE_BACKGROUND_RULE,
    `${form} can leave a process running after execute returns. Use shell_start for commands that must keep running.`,
  );
}
