/** Shared fixtures for the account module's tests: a P-256 key, a sealed inventory in a temp dir. */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CREDENTIAL_INVENTORY_FILE_NAME,
  fileCredentialKeyring,
  SealedInventory,
} from "@volli/host-core/secrets";

export function testKeyPair(): { privateKeyPem: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** The real sealed inventory over a file keyring, as harness mode runs it. */
export function tempInventory(): { inventory: SealedInventory; dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "volli-account-"));
  const inventory = new SealedInventory({
    path: join(dir, CREDENTIAL_INVENTORY_FILE_NAME),
    keyring: fileCredentialKeyring({ path: join(dir, "credential.key") }),
    families: ["host-private"],
  });
  return { inventory, dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
