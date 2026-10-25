/**
 * N-1 compatibility of this Mac's sealed runner link (VC-895). It is one
 * more `host-private` record in `host-credentials.enc`, beside the saved
 * sign-in and remote hosts' device keys, which older builds open and parse
 * strictly (an unknown family or selector field would read as corrupt). The
 * inventory and family code older builds ship is pinned byte-identical to
 * this build's by `../account/session-store-n1.test.ts`, so driving this
 * build's inventory with their access is driving theirs.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ACCOUNT_SESSION_PURPOSE, inventoryAccountSessionStore } from "../account/session-store";
import { tempInventory } from "../account/test-support";
import { inventoryDeviceKeys } from "../remote-hosts";
import { inventoryRunnerLinkStore, runnerLinkPurpose } from "./identity-store";

const DANA = "11111111-1111-4111-8111-111111111111";
const unlock = async (): Promise<void> => {};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("the sealed runner link beside an older build's records", () => {
  it("leaves the file open, and the sign-in and device keys usable the way an older build uses them", async () => {
    const temp = tempInventory();
    cleanups.push(temp.dispose);
    const link = inventoryRunnerLinkStore(temp.inventory, unlock, DANA);
    const account = inventoryAccountSessionStore(temp.inventory, unlock);
    const deviceKeys = inventoryDeviceKeys(temp.inventory, unlock);
    await deviceKeys.put("box", "PEM-1");
    await account.save(
      {
        provider: "workos",
        refreshToken: "refresh-1",
        sessionId: null,
        profile: { displayName: "Dana", email: null },
      },
      null,
    );
    const sealed = {
      runnerId: "22222222-2222-4222-8222-222222222222",
      name: "danas-mac",
      credential: "vrc_1",
      generation: 1,
    };
    await link.save(sealed as never);

    expect(temp.inventory.status().state).toBe("ready");
    await expect(deviceKeys.get("box")).resolves.toBe("PEM-1");
    await deviceKeys.put("other", "PEM-2");
    await deviceKeys.remove("box");
    expect(temp.inventory.list("host-private").map(({ selector }) => selector.purpose)).toEqual(
      expect.arrayContaining([
        ACCOUNT_SESSION_PURPOSE,
        runnerLinkPurpose(DANA),
        "remote-host-device:other",
      ]),
    );
    await expect(link.load()).resolves.toEqual(sealed);
    await expect(account.load()).resolves.not.toBeNull();
  });
});
