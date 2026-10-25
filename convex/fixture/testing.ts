/**
 * What a `test:backend` file (or a command under `with-backend.ts --deploy`)
 * uses: the deployed fixture backend, signed in as anyone.
 */

import { ConvexHttpClient } from "convex/browser";

import { mintTestToken, type MintOptions } from "./jwt.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set; run under \`test:backend\` or \`with-backend.ts --deploy\``,
    );
  }
  return value;
}

export function connectBackend() {
  const url = required("VOLLI_CONVEX_URL");
  const privateKeyPem = required("VOLLI_CONVEX_TEST_PRIVATE_KEY");
  return {
    url,
    /** The HTTP actions origin (`/runner/*`). */
    siteUrl: required("VOLLI_CONVEX_SITE_URL"),
    /** An HTTP client, signed in as `subject` (through the test issuer) when given. */
    client(subject?: string, options?: MintOptions): ConvexHttpClient {
      const client = new ConvexHttpClient(url);
      if (subject !== undefined) client.setAuth(mintTestToken(privateKeyPem, subject, options));
      return client;
    },
  };
}
