import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";

/** Credential stores are never a structured file-read capability, even with
 * without per-call approvals. Project .env files join this list (VC-481).
 * This is not a shell sandbox: arbitrary programs can encode or send a value.
 */
export function credentialPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.startsWith("mcp-credentials.json") ||
    name.startsWith("session-secrets.enc") ||
    name === "auth.json" ||
    name === "mcp-auth.json" ||
    /(?:^|\/)\.(?:ssh|aws|gnupg)(?:\/|$)/i.test(path) ||
    /(?:^|\/)(?:keychains|credentials)(?:\/|$)/i.test(path)
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
