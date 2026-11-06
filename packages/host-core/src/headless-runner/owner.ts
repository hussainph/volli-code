/**
 * Whose runner this box is. A box links with an install token or a device
 * code, and neither grant names the person (`RunnerLinkGrant` carries the
 * runner's id, name and credential), but every runner token does: the
 * backend signs the owner into its `own` claim (`convex/functions/runnerHttp.ts`).
 *
 * The cloud product store scopes its local ledger to that person, so the
 * composition must know them before it builds the store. The first token
 * this process exchanges answers; the answer is then kept beside the data
 * (`runner-owner.json`, keyed by runner id), so a restart while the backend
 * is unreachable still recovers and resumes its own Sessions offline. A
 * runner linked again is a new runner id, so a kept answer never names the
 * wrong person for it.
 *
 * Reading the claim needs no signature check: the token is this runner's
 * own, fetched over TLS from its own deployment, and the backend still
 * authorizes every call it carries. The owner here only scopes local state.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The file beside the data that remembers whose runner this is. Never a secret. */
export const RUNNER_OWNER_FILE = "runner-owner.json";

/** The owner a runner token names (its `own` claim), or `null` when it names none. */
export function runnerTokenOwner(token: string): string | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof claims !== "object" || claims === null) return null;
    const own = (claims as { own?: unknown }).own;
    return typeof own === "string" && own.length > 0 ? own : null;
  } catch {
    return null;
  }
}

/** The kept owner for `runnerId`, or `null` when none is kept for that runner. */
export function readRunnerOwner(dataDir: string, runnerId: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(dataDir, RUNNER_OWNER_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as { v?: unknown; runnerId?: unknown; ownerUserId?: unknown };
    return value.v === 1 &&
      value.runnerId === runnerId &&
      typeof value.ownerUserId === "string" &&
      value.ownerUserId.length > 0
      ? value.ownerUserId
      : null;
  } catch {
    return null;
  }
}

/** Keeps the owner for `runnerId`: temp file, then rename, so a crash leaves the old one or the new. */
export function writeRunnerOwner(dataDir: string, runnerId: string, ownerUserId: string): void {
  const path = join(dataDir, RUNNER_OWNER_FILE);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ v: 1, runnerId, ownerUserId })}\n`, {
      mode: 0o600,
      flush: true,
    });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** The first wait between token attempts while the backend cannot be reached, doubling to the cap. */
export const RUNNER_OWNER_RETRY = { firstMs: 1_000, maxMs: 60_000 } as const;

export type RunnerOwnerOutcome =
  | { readonly kind: "owner"; readonly ownerUserId: string }
  /** The link ended before any token named the owner (revoked, or its credential is gone). */
  | { readonly kind: "lost" }
  /** Stopped while waiting. */
  | { readonly kind: "stopped" };

/**
 * The runner's owner: the kept answer for this runner, else the first token's
 * claim (kept for next time). A token that cannot be fetched now is retried
 * with a doubling wait (1 s → 60 s) until it arrives, the link ends, or
 * `signal` aborts.
 */
export async function resolveRunnerOwner(input: {
  dataDir: string;
  runnerId: string;
  token(): Promise<string | null>;
  signal: AbortSignal;
  onRetry?(error: unknown, waitMs: number): void;
  wait?(ms: number, signal: AbortSignal): Promise<void>;
}): Promise<RunnerOwnerOutcome> {
  if (input.signal.aborted) return { kind: "stopped" };
  const kept = readRunnerOwner(input.dataDir, input.runnerId);
  if (kept !== null) return { kind: "owner", ownerUserId: kept };
  const wait = input.wait ?? abortableDelay;
  let waitMs: number = RUNNER_OWNER_RETRY.firstMs;
  while (!input.signal.aborted) {
    let token: string | null;
    try {
      token = await input.token();
    } catch (error) {
      input.onRetry?.(error, waitMs);
      await wait(waitMs, input.signal);
      waitMs = Math.min(waitMs * 2, RUNNER_OWNER_RETRY.maxMs);
      continue;
    }
    if (token === null) return { kind: "lost" };
    const ownerUserId = runnerTokenOwner(token);
    // A token without the claim is a backend this build cannot run under.
    if (ownerUserId === null) throw new Error("The runner token does not name its owner.");
    writeRunnerOwner(input.dataDir, input.runnerId, ownerUserId);
    return { kind: "owner", ownerUserId };
  }
  return { kind: "stopped" };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
