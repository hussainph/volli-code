/**
 * `volli-runner git-credential [--data-dir <dir>] <get|store|erase>`: Volli's
 * git credential helper on a runner box. Git runs it, never a person.
 *
 * A Session's commands install it as the GitHub host's only command-scope
 * credential helper ({@link gitCredentialHelperCommand}, through host-core's
 * `runnerSessionGitEnv`, which resets the box's helpers for that host), or,
 * while the owner is known to be disconnected, after the box's own helpers
 * with `--explain-only`, when it never prints a token. Git appends
 * the action and writes its request on stdin; this asks the running runner
 * over `<dataDir>/git-credential.sock` (0600), naming the Session by its
 * `VOLLI_SESSION` and `VOLLI_SESSION_TOKEN`, and prints the runner's answer:
 * the owner's GitHub token for that Session, or nothing.
 *
 * Quiet by default: stdout carries git's answer and nothing else. Stderr
 * (which git shows to whoever runs it) carries at most one line, and only
 * when the runner says why there is no token and the person can fix it:
 * GitHub not connected, needing a reconnect, Volli not installed on the
 * repository's account, or a rate limit. It never names a token. It always
 * exits 0: a runner that is down or has no token answers nothing, and git
 * moves on to the box's own credentials or fails without a prompt.
 */
import { join } from "node:path";

import {
  askGitCredentialDaemon,
  GIT_CREDENTIAL_EXPLAIN_ONLY_FLAG,
} from "@volli/host-core/cloud-runner";

import type { CommandContext, CommandInput } from "../commands";
import { PATH_OPTIONS, pathsFor } from "../shell/paths";

const EXPLAIN_ONLY = GIT_CREDENTIAL_EXPLAIN_ONLY_FLAG.replace(/^--/u, "");

/** The helper's options: the paths, and the explain-only mode host-core may append. */
export const GIT_CREDENTIAL_OPTIONS = {
  ...PATH_OPTIONS,
  [EXPLAIN_ONLY]: { type: "boolean" },
} as const;

/** The socket the running runner answers helper calls on. */
export function gitCredentialSocketPath(dataDir: string): string {
  return join(dataDir, "git-credential.sock");
}

/** One POSIX shell word. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The `credential.helper` value a Session's git runs: this command, for this data dir. */
export function gitCredentialHelperCommand(runnerExecutable: string, dataDir: string): string {
  return `!${shellWord(runnerExecutable)} git-credential --data-dir ${shellWord(dataDir)}`;
}

/** Reads a stream to its end as UTF-8. */
export async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runGitCredential(
  input: CommandInput,
  context: CommandContext,
): Promise<number> {
  const action = input.positionals[0];
  if (action === undefined) return 0;
  try {
    const paths = pathsFor(input.values, context);
    const reply = await askGitCredentialDaemon({
      socketPath: gitCredentialSocketPath(paths.dataDir),
      action,
      request: await context.readStdin(),
      env: context.env,
      explainOnly: input.values[EXPLAIN_ONLY] === true,
    });
    context.out(reply.answer);
    if (reply.stderr !== "") context.err(reply.stderr);
  } catch {
    // Nothing on stderr: a helper failure is not the person's to fix.
  }
  return 0;
}
