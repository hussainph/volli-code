/**
 * The whole sign-in against a real backend: the dev issuer, the loopback
 * callback, the sealed store, and `accounts.ensureViewer` /
 * `requestDeletion` / `cancelDeletion` on the pinned local Convex backend.
 *
 * Runs only under the fixture, which hands it the backend's URL and the test
 * issuer's key: CI's `Convex (codegen + backend)` lane runs it so (and
 * requires it to run); it skips everywhere else, the desktop lanes included.
 *
 *   pnpm -C convex with-backend --deploy -- \
 *     pnpm -C apps/desktop exec vp test run src/main/account/convex.live.test.ts
 */
import { inviteTestEmail } from "../test-helpers/preview";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { convexAccountBackend } from "./backend";
import { devIssuerProvider } from "./dev-issuer";
import { createAccountService } from "./service";
import { inventoryAccountSessionStore } from "./session-store";
import { tempInventory } from "./test-support";

const url = process.env["VOLLI_CONVEX_URL"];
const privateKeyPem = process.env["VOLLI_CONVEX_TEST_PRIVATE_KEY"];

// CI's Convex lane sets this: there the test must run, never skip.
if (
  process.env["VOLLI_ACCOUNT_LIVE_REQUIRED"] === "1" &&
  (url === undefined || privateKeyPem === undefined)
) {
  throw new Error("The live sign-in test needs the fixture: run it under `with-backend --deploy`.");
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe.skipIf(url === undefined || privateKeyPem === undefined)(
  "sign-in against the pinned local backend",
  () => {
    it("signs in through the browser, creates the person, and schedules and restores deletion", async () => {
      const temp = tempInventory();
      cleanups.push(temp.dispose);
      const subject = `live-${randomUUID()}`;
      await inviteTestEmail(url!, `${subject}@example.com`);
      const service = createAccountService({
        enabled: () => true,
        provider: devIssuerProvider({
          privateKeyPem: privateKeyPem!,
          subject,
          displayName: "Live Dana",
          email: `${subject}@example.com`,
        }),
        backend: convexAccountBackend({ url: url! }),
        store: inventoryAccountSessionStore(temp.inventory, async () => {}),
        openBrowser: async (target) => {
          const location = (await fetch(target, { redirect: "manual" })).headers.get("location");
          if (location !== null) await fetch(location);
        },
      });
      cleanups.push(() => service.dispose());
      service.snapshot();
      await service.settled();
      await service.signIn("github");
      await service.settled();

      const signedIn = service.snapshot();
      expect(signedIn).toMatchObject({
        state: "signed-in",
        provider: "dev",
        failure: null,
        account: {
          displayName: "Live Dana",
          email: `${subject}@example.com`,
          backend: "synced",
          deletionPurgeAfter: null,
        },
      });
      expect(signedIn.account!.userId).toMatch(/^[0-9a-f-]{36}$/u);

      await service.requestDeletion();
      const pending = service.snapshot().account!;
      expect(pending.deletionPurgeAfter).toBeGreaterThan(Date.now());
      await service.cancelDeletion();
      expect(service.snapshot().account!.deletionPurgeAfter).toBeNull();
      // The same person on the next sign-in: ensureViewer finds, not creates.
      await service.signOut();
      await service.signIn("google");
      await service.settled();
      expect(service.snapshot().account!.userId).toBe(signedIn.account!.userId);
    });
  },
);
