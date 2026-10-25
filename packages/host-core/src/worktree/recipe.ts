/**
 * A working copy's ENVIRONMENT RECIPE (VC-584): the two scripts that make a
 * fresh working copy ready to work in, and what they run with.
 *
 *  - `.agents/setup` runs once per new working copy, before its first work
 *    starts (installs, codegen). Whether it is owed is the worktree's
 *    first-run record (`first-run.ts`); this module only says WHAT runs.
 *  - `.agents/resume` runs when this runner first uses the working copy since
 *    it started or woke (services, short-lived auth). See `resume-exec.ts`.
 *
 * The paths are the ones other agent products use, so a repository prepared
 * for one works in the other. The repository is canonical: a recipe changes
 * with the code, on the branch that needs it. When the working copy has no
 * repository file, the project's stored command runs instead — today that is
 * Configure → Worktrees → Then run, which keeps its exact semantics
 * (`<shell> -c <command>`). The two are never combined: a repository file
 * wins.
 *
 * Behind the `cloud` experimental flag. With it off nothing here is reached
 * and "Then run" runs exactly as before.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Which of the recipe's two scripts. */
export type RecipeScript = "setup" | "resume";

/**
 * Why a setup run happened. Only `new-working-copy` is produced today;
 * snapshot builds, verification and manual runs arrive with their doors.
 */
export type SetupReason = "new-working-copy" | "retry";

/** Why a resume run happened. `unpause` belongs to Volli Cloud runners. */
export type ResumeReason = "runner-start" | "wake";

/** The runner kinds a script can tell apart through `VOLLI_RUNNER_KIND`. */
export type RunnerKind = "mac" | "linux" | "cloud";

/**
 * The script one run executes.
 *
 * `repo`: the working copy's own `.agents/<script>`. An executable file that
 * names its interpreter (`#!`) runs directly, so any interpreter works;
 * anything else runs as `bash <file>`, which forgives a missing exec bit.
 *
 * `legacyCommand`: the project's stored setup command, run as today.
 *
 * `sha` is a digest of what runs (the file's bytes, or the command), so a
 * later reader can tell the recipe changed since a working copy was set up.
 */
export type ResolvedRecipe =
  | {
      source: "repo";
      script: RecipeScript;
      file: string;
      form: "exec" | "bash";
      sha: string;
    }
  | { source: "legacyCommand"; script: "setup"; command: string; sha: string };

/** `<workingCopy>/.agents/<script>`. */
function recipeFile(workingCopy: string, script: RecipeScript): string {
  return join(workingCopy, ".agents", script);
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The file's bytes and whether anyone may execute it, read through one open
 * descriptor so what is judged is what was read; `null` when there is no file
 * there, or something other than a regular file.
 */
function readRegularFile(file: string): { content: Buffer; executable: boolean } | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    return { content: readFileSync(fd), executable: (stat.mode & 0o111) !== 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * The script `script` resolves to in `workingCopy`: the repository file when
 * there is one, otherwise (setup only) the project's stored command, otherwise
 * `null` — "not configured", which is not a failure.
 *
 * Synchronous: one stat and, when the file exists, one small read. A file that
 * exists but cannot be read throws, so a caller reports it rather than
 * silently running the stored command in its place.
 */
export function resolveRecipe(
  workingCopy: string,
  script: RecipeScript,
  storedCommand: string | null,
): ResolvedRecipe | null {
  const file = recipeFile(workingCopy, script);
  const bytes = readRegularFile(file);
  if (bytes !== null) {
    const form =
      bytes.executable && bytes.content.subarray(0, 2).toString("latin1") === "#!"
        ? "exec"
        : "bash";
    return { source: "repo", script, file, form, sha: digest(bytes.content) };
  }
  if (script !== "setup") return null;
  const command = storedCommand?.trim() ?? "";
  if (command.length === 0) return null;
  return { source: "legacyCommand", script, command, sha: digest(command) };
}

/** This machine's runner kind. A Volli Cloud runner names itself when it lands. */
export function localRunnerKind(platform: NodeJS.Platform = process.platform): RunnerKind {
  return platform === "darwin" ? "mac" : "linux";
}

/** What a recipe script is told about where and why it runs. */
export interface RecipeContext {
  runnerKind: RunnerKind;
  projectId: string;
  /** The ticket's display id (`VC-12`), the same value a Session's `VOLLI_TICKET` carries. */
  ticket: string;
  workingCopy: string;
  reason: { script: "setup"; why: SetupReason } | { script: "resume"; why: ResumeReason };
}

/**
 * The variables a recipe script runs with, layered over the runner's own
 * environment. `VOLLI_RUNNER_KIND` is what lets one script guard the steps
 * that only make sense on some runners (system installs on a disposable cloud
 * machine, never on someone's Mac).
 */
export function recipeEnvironment(context: RecipeContext): Record<string, string> {
  return {
    VOLLI: "1",
    VOLLI_RUNNER_KIND: context.runnerKind,
    VOLLI_PROJECT: context.projectId,
    VOLLI_TICKET: context.ticket,
    VOLLI_WORKING_COPY: context.workingCopy,
    ...(context.reason.script === "setup"
      ? { VOLLI_SETUP_REASON: context.reason.why }
      : { VOLLI_RESUME_REASON: context.reason.why }),
    DEBIAN_FRONTEND: "noninteractive",
  };
}

/**
 * The program and arguments a child-process run spawns for `recipe`.
 * `shellPath` runs the stored command, exactly as it always has.
 */
export function recipeInvocation(
  recipe: ResolvedRecipe,
  shellPath: string,
): { file: string; args: string[] } {
  if (recipe.source === "legacyCommand") return { file: shellPath, args: ["-c", recipe.command] };
  return recipe.form === "exec"
    ? { file: recipe.file, args: [] }
    : { file: "bash", args: [recipe.file] };
}

/**
 * Quotes `value` for the shell a terminal runs: single quotes for POSIX
 * shells; fish also reads `\\` and `\'` inside them, so both are escaped there.
 */
function quoteFor(shell: "posix" | "fish", value: string): string {
  if (shell === "fish") return `'${value.replace(/[\\']/g, (c) => `\\${c}`)}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line a terminal types to run a REPOSITORY recipe: the script under the
 * recipe's variables, with nothing to read on stdin. `env` sets the
 * variables the same way in every shell, fish included; the caller wraps the
 * line in its exit-code sentinel.
 */
export function recipeCommandLine(
  recipe: Extract<ResolvedRecipe, { source: "repo" }>,
  environment: Record<string, string>,
  shell: "posix" | "fish",
): string {
  const assignments = Object.entries(environment).map(
    ([name, value]) => `${name}=${quoteFor(shell, value)}`,
  );
  const program =
    recipe.form === "exec" ? quoteFor(shell, recipe.file) : `bash ${quoteFor(shell, recipe.file)}`;
  return `env ${assignments.join(" ")} ${program} < /dev/null`;
}
