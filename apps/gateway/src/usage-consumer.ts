/**
 * The usage queue's consumer: hands each batch of metered calls to the backend.
 *
 * Records go through a queue rather than straight from the request because a
 * Worker's `waitUntil` outlives its response by seconds, and usage must not be
 * lost while the backend is unreachable. A batch the backend does not accept
 * is retried whole; ingest is idempotent on each record's `recordId`, so a
 * retry that repeats an accepted record is harmless. The endpoint should
 * accept a batch even when it rejects individual records (and report them),
 * since one malformed record would otherwise hold back the rest of its batch.
 *
 * Without `USAGE_INGEST_URL` (local development, before the backend's ingest
 * endpoint exists) the consumer is a stub that logs how many records it saw
 * and acknowledges them. It never logs a record's contents.
 */
import type { FetchFn, GatewayEnv, UsageBatch } from "./env.ts";

export async function consumeUsage(
  batch: UsageBatch,
  env: GatewayEnv,
  fetchFn: FetchFn,
): Promise<void> {
  const records = batch.messages.map((message) => message.body);
  if (!env.USAGE_INGEST_URL) {
    console.log(
      `[volli-gateway] usage stub: ${records.length} record(s) acknowledged, no ingest URL configured`,
    );
    batch.ackAll();
    return;
  }
  if (!env.USAGE_INGEST_TOKEN) {
    // Never post usage unauthenticated; hold it for the queue's retries.
    console.error(
      `[volli-gateway] usage ingest URL set without a token; retrying ${records.length} record(s)`,
    );
    batch.retryAll({ delaySeconds: 30 });
    return;
  }
  try {
    const response = await fetchFn(env.USAGE_INGEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.USAGE_INGEST_TOKEN}`,
      },
      body: JSON.stringify({ records }),
    });
    await response.body?.cancel();
    if (response.ok) {
      batch.ackAll();
      return;
    }
    console.error(
      `[volli-gateway] usage ingest answered ${response.status}; retrying ${records.length} record(s)`,
    );
  } catch (error) {
    console.error(
      `[volli-gateway] usage ingest unreachable (${String(error)}); retrying ${records.length} record(s)`,
    );
  }
  batch.retryAll({ delaySeconds: 30 });
}
