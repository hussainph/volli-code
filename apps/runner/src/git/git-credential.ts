/**
 * `volli-runner git-credential [--data-dir <dir>] <get|store|erase>`: Volli's
 * git credential helper on a runner box. Git runs it, never a person.
 *
 * A Session's commands install it as the GitHub host's only command-scope
 * credential helper ({@link gitCredentialHelperCommand}, through host-core's
 * `runnerSessionGitEnv`, which resets the box's helpers for that host). Git appends
 * the action and writes its request on stdin; this asks the running runner
 * over `<dataDir>/git-credential.sock` (0600), naming the Session by its
 * `VOLLI_SESSION` and `VOLLI_SESSION_TOKEN`, and prints the runner's answer:
 * the owner's GitHub token for that Session, or nothing.
 *
 * Quiet by construction: stdout carries git's answer and nothing else, and
 * stderr stays empty (git shows a helper's stderr to whoever runs it). It
 * always exits 0: a runner that is down or has no token answers nothing, and
 * git moves on to the box's own credentials or fails without a prompt.
 */
import { join } from "node:path";

import { askGitCredentialDaemon } from "@volli/host-core/cloud-runner";

import type { CommandContext, CommandInput } from "../commands";
import { pathsFor } from "../shell/paths";

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
    context.out(
      await askGitCredentialDaemon({
        socketPath: gitCredentialSocketPath(paths.dataDir),
        action,
        request: await context.readStdin(),
        env: context.env,
      }),
    );
  } catch {
    // Nothing on stderr either: see the module comment.
  }
  return 0;
}
