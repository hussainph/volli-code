/**
 * N-1 compatibility of the saved sign-in (VC-884). It is one more
 * `host-private` record in `host-credentials.enc`, a file the latest release
 * (`v0.2.2`) and canary (`v0.2.3-canary.4`) open for remote hosts' device
 * keys, and they parse it strictly: an unknown family or selector field
 * would read as corrupt. Both ship host-core's inventory and family code
 * byte-identical to this build's (pinned by git blob id below), so driving
 * this build's inventory with their remote-hosts access is driving theirs.
 * If either pin fails, the inventory changed: prove an older build still
 * opens a file holding the saved sign-in before updating it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { inventoryDeviceKeys } from "../remote-hosts";
import { ACCOUNT_SESSION_PURPOSE, inventoryAccountSessionStore } from "./session-store";
import { tempInventory } from "./test-support";

/** `git rev-parse v0.2.2:<path>`, equal at `v0.2.3-canary.4`. */
const SHIPPED_BLOBS: Readonly<Record<string, string>> = {
  "inventory.ts": "29d1a53132587dc0ede0de0dd1ca54c24f7c1ae0",
  "credential-families.ts": "53aa775347f80152d9c10d0bcaa6b05b629918b2",
};

function gitBlobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const unlock = async (): Promise<void> => {};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("the saved sign-in beside an older build's records", () => {
  it("is parsed by the inventory code the latest release and canary ship", () => {
    for (const [file, blob] of Object.entries(SHIPPED_BLOBS)) {
      const path = fileURLToPath(
        new URL(`../../../../../packages/host-core/src/secrets/${file}`, import.meta.url),
      );
      expect(gitBlobId(readFileSync(path)), file).toBe(blob);
    }
  });

  it("leaves the file open, and a device key readable and writable, the way an older build uses it", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const account = inventoryAccountSessionStore(temp.inventory, unlock);
    const deviceKeys = inventoryDeviceKeys(temp.inventory, unlock);
    await deviceKeys.put("box", "PEM-1");
    const saved = {
      provider: "workos" as const,
      refreshToken: "refresh-1",
      sessionId: "session_01",
      profile: { displayName: "Dana", email: "dana@example.com" },
    };
    await account.save(saved, null);

    expect(temp.inventory.status().state).toBe("ready");
    await expect(deviceKeys.get("box")).resolves.toBe("PEM-1");
    // An older build writing and removing its own records keeps the sign-in.
    await deviceKeys.put("other", "PEM-2");
    await deviceKeys.remove("box");
    expect(temp.inventory.list("host-private").map(({ selector }) => selector.purpose)).toEqual(
      expect.arrayContaining([ACCOUNT_SESSION_PURPOSE, "remote-host-device:other"]),
    );
    await expect(account.load()).resolves.toMatchObject({ session: saved });
  });
});
