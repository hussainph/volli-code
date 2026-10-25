/**
 * The desktop's dev issuer (`apps/desktop/src/main/account/dev-issuer.ts`)
 * signs as this package's test issuer so an unpackaged desktop can sign in
 * against the fixture. It cannot import this package, so it carries copies of
 * the issuer, audience and key id; this holds the copies equal, so a change
 * here cannot quietly break dev sign-in.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { TEST_AUDIENCE, TEST_ISSUER } from "../functions/auth.config";
import { TEST_KEY_ID } from "../fixture/jwt";

const devIssuer = readFileSync(
  fileURLToPath(new URL("../../apps/desktop/src/main/account/dev-issuer.ts", import.meta.url)),
  "utf8",
);

describe("the desktop dev issuer", () => {
  test("signs as the fixture's test issuer, audience and key", () => {
    expect(devIssuer).toContain(`export const DEV_ISSUER = "${TEST_ISSUER}";`);
    expect(devIssuer).toContain(`export const DEV_AUDIENCE = "${TEST_AUDIENCE}";`);
    expect(devIssuer).toContain(`export const DEV_KEY_ID = "${TEST_KEY_ID}";`);
  });
});
