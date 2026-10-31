import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { piOwnedModelAccess, type PiModelAccess } from "@volli/agent-runtime";
import { secretKeyFilePath } from "@volli/host-core/secrets";

import { RunnerCredentialStore } from "./credential-store";

export interface RunnerModelAccessOptions {
  readonly dataDir: string;
  readonly configDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The same model/credential collection is used by the daemon and login CLI. */
export function runnerModelAccess(options: RunnerModelAccessOptions): PiModelAccess {
  const keyPath = runnerModelKeyPath(options);
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  return piOwnedModelAccess({
    // Catalog caches are runner-local too; do not read or write ~/.pi.
    agentDir: join(options.dataDir, "models"),
    credentials: new RunnerCredentialStore(options.dataDir, keyPath),
  });
}

export function runnerModelKeyPath(options: RunnerModelAccessOptions): string {
  // Match the installed unit even when login is run from an ordinary shell
  // (sudo/runuser do not inherit the unit's environment). The daemon uses
  // this same path for its model store; explicit operator overrides win.
  return secretKeyFilePath(options.dataDir, {
    ...options.env,
    VOLLI_SECRET_KEY_FILE:
      options.env["VOLLI_SECRET_KEY_FILE"] || join(options.configDir, "session-secrets.key"),
  });
}
