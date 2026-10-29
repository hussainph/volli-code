/**
 * What a `test:backend` file (or a command under `with-backend.ts --deploy`)
 * uses: the deployed fixture backend, signed in as anyone.
 */

import { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { FunctionReference, FunctionReturnType, OptionalRestArgs } from "convex/server";

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
    /**
     * A WebSocket client signed in as `subject`: the transport a desktop
     * window writes the board through. Unlike the HTTP client, it answers a
     * mutation that exhausted the backend's concurrency retries by closing
     * the socket (1013) and resending the mutation once it reconnects. Each
     * socket runs its mutations in order, so concurrent writers need one
     * each. Close it when done.
     */
    socket(subject: string, options?: MintOptions): ConvexClient {
      const client = new ConvexClient(url);
      const token = mintTestToken(privateKeyPem, subject, options);
      client.setAuth(async () => token);
      return client;
    },
    /**
     * Calls an internal mutation with this backend's admin key: seeding, and
     * the internal steps no client may call. Only the throwaway fixture
     * backend hands its admin key to tests.
     */
    async admin<Mutation extends FunctionReference<"mutation", "internal">>(
      mutation: Mutation,
      ...args: OptionalRestArgs<Mutation>
    ): Promise<FunctionReturnType<Mutation>> {
      const client = new ConvexHttpClient(url);
      (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(
        required("VOLLI_CONVEX_ADMIN_KEY"),
      );
      return client.mutation(
        mutation as unknown as FunctionReference<"mutation">,
        ...(args as OptionalRestArgs<FunctionReference<"mutation">>),
      );
    },
  };
}
