import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { ExecutionEnv } from "./harness-env";

/** Credential stores are never a structured file-read capability, even with
 * without per-call approvals. Project .env files join this list (VC-481).
 * This is not a shell sandbox: arbitrary programs can encode or send a value.
 * Common tool stores join it too (VC-840): netrc, git's plaintext store, gh,
 * docker, kube, gcloud and Claude Code's credentials file, and Volli's own
 * database, whose `secrets` table still holds Web Access keys in the clear
 * (`host-core/src/web/credential.ts`). `.npmrc` and `.pypirc` count only in
 * the home directory: a project's copy is ordinary registry config.
 */
export function credentialPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.startsWith("mcp-credentials.json") ||
    name.startsWith("session-secrets.enc") ||
    name.startsWith("session-secrets.key") ||
    name.startsWith("host-credentials.") ||
    name === "auth.json" ||
    name === "mcp-auth.json" ||
    /(?:^|\/)\.(?:ssh|aws|gnupg)(?:\/|$)/i.test(path) ||
    /(?:^|\/)(?:keychains|credentials)(?:\/|$)/i.test(path) ||
    name === ".netrc" ||
    name === "_netrc" ||
    name === ".git-credentials" ||
    name === ".credentials.json" ||
    name === "application_default_credentials.json" ||
    name.startsWith("volli.db") ||
    ((name === ".npmrc" || name === ".pypirc") && dirname(path) === resolve(homedir())) ||
    /(?:^|\/)gh\/hosts\.yml$/i.test(path) ||
    /(?:^|\/)\.docker\/config\.json$/i.test(path) ||
    /(?:^|\/)\.(?:kube|config\/gcloud)(?:\/|$)/i.test(path)
  );
}

export function refusingCredentialReads(env: ExecutionEnv, workspacePath: string): ExecutionEnv {
  const reads = new Set(["openTextLineReader", "readTextFile", "readTextLines", "readBinaryFile"]);
  return new Proxy(env, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (typeof member !== "function") return member;
      if (!reads.has(String(property))) return member.bind(target);
      return async (path: string, ...args: unknown[]) => {
        const absolute = resolve(workspacePath, path);
        let canonical = absolute;
        try {
          canonical = await realpath(absolute);
        } catch {
          /* The tool reports a missing file. */
        }
        if (credentialPath(absolute) || credentialPath(canonical)) {
          throw new Error(
            "Volli refuses credential-file reads. Ask the person with request_secret instead.",
          );
        }
        return member.call(target, canonical, ...args);
      };
    },
  });
}
