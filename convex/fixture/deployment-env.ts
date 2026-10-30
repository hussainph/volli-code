/** File-scoped deployment settings on the serial, throwaway backend. */
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { connectBackend } from "./testing.ts";

/**
 * Snapshot only the settings this fixture owns, then restore their exact values
 * (including absent vs empty). Call in beforeAll and restore in afterAll, before
 * closing the server those settings point at. Not a lock: backend files MUST
 * remain serial, since scheduled actions also read this deployment's settings.
 * Nested scopes must restore in LIFO order. A killed worker cannot restore;
 * global teardown still stops and discards the throwaway backend.
 */
export async function scopeDeploymentEnv(values: Record<string, string | null>) {
  const { url } = connectBackend();
  const adminKey = process.env["VOLLI_CONVEX_ADMIN_KEY"];
  if (!adminKey) throw new Error("Run with the pinned backend fixture");
  const client = new ConvexHttpClient(url);
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
  const get = makeFunctionReference<
    "query",
    { name: string },
    { name: string; value: string } | null
  >("_system/cli/queryEnvironmentVariables:get");
  const previous: Record<string, string | null> = Object.fromEntries(
    await Promise.all(
      Object.keys(values).map(async (name) => [
        name,
        (await client.query(get, { name }))?.value ?? null,
      ]),
    ),
  );
  async function update(settings: Record<string, string | null>) {
    const response = await fetch(`${url}/api/update_environment_variables`, {
      method: "POST",
      headers: { authorization: `Convex ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        changes: Object.entries(settings).map(([name, value]) => ({ name, value })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Updating fixture deployment env: ${response.status}`);
  }
  try {
    await update(values);
  } catch (error) {
    // The update may have landed even when its acknowledgement was lost.
    try {
      await update(previous);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Fixture deployment env setup failed and restoring previous settings failed",
      );
    }
    throw error;
  }
  return { previous, restore: () => update(previous) };
}
