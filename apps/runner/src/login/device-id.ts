import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialLock } from "@volli/host-core/secrets";

import { durableWrite } from "../shell/write-file";

/** Stable Pi OAuth installation id, atomically created under a cross-process lock. */
export function runnerDeviceId(dataDir: string): string {
  const path = join(dataDir, "model-device-id");
  return new CredentialLock(join(dataDir, "model-device-id.lock")).withSync(() => {
    let id: string;
    try {
      id = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      id = randomUUID();
      durableWrite(path, id, 0o600);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new Error("Invalid model device id.");
    }
    return id;
  });
}
