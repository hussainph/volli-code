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
  // Same rule as openHeadlessSecrets: the service unit overrides this to
  // <configDir>/session-secrets.key; foreground runs default to <dataDir>.
  return secretKeyFilePath(options.dataDir, options.env);
}
