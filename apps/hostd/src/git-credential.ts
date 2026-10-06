/**
 * `volli-hostd git-credential --data-dir <dir> <action>`: Volli's git
 * credential helper (VC-702).
 *
 * Git runs it, never a person: a Session's environment installs it as
 * command-scope `credential.helper` (`gitCredentialHelperEnv`, host-core),
 * and git appends the action (`get`, `store`, `erase`) and writes the request
 * on stdin. `get` answers from the push credentials a person sent this host
 * (`signIns.setGitCredential`), kept in `<dir>/credentials/git-push.json`;
 * `store` and `erase` change nothing, because the person decides what that
 * store holds, not git.
 *
 * Quiet by construction: it writes git's answer on stdout and nothing else,
 * anywhere. A store it cannot read answers nothing, so git moves on to its
 * next helper or prompt, exactly as if this one were absent.
 */
import { join } from "node:path";

import {
  answerGitCredential,
  fileGitCredentialStore,
  GIT_CREDENTIALS_FILE,
  parseGitCredentialRequest,
} from "@volli/host-core/session-runtime";

export interface GitCredentialCommand {
  readonly kind: "git-credential";
  readonly dataDir: string;
  readonly action: string;
}

export interface GitCredentialIo {
  /** The whole request git wrote on stdin. */
  readonly stdin: () => Promise<string>;
  readonly out: (text: string) => void;
}

/** Always exits 0: a helper that has nothing to say says nothing. */
export async function runGitCredential(
  command: GitCredentialCommand,
  io: GitCredentialIo,
): Promise<number> {
  try {
    const request = parseGitCredentialRequest(await io.stdin());
    const store = fileGitCredentialStore(join(command.dataDir, GIT_CREDENTIALS_FILE));
    io.out(await answerGitCredential(command.action, request, store));
  } catch {
    // Nothing on stderr either: git shows a helper's stderr to whoever runs it.
  }
  return 0;
}

/** Reads a stream to its end as UTF-8. */
export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}
