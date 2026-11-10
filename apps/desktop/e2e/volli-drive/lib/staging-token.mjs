/**
 * A fresh staging WorkOS access token in a file, for the MOVE-11 rehearsal
 * (`VOLLI_MOVE_TOKEN_FILE`, re-read by the harness on every call). Volli is
 * quit for the whole rehearsal, so this process holds the sign-in instead:
 *
 *   • one browser sign-in through the desktop's own public-client flow —
 *     PKCE (`account/pkce.ts`), the loopback callback (`account/loopback.ts`)
 *     and the WorkOS adapter (`account/workos.ts`), imported, not copied;
 *   • the rotating refresh token stays in this process's memory, never on disk;
 *   • the access token is written atomically (temp file, mode 0600, fsync,
 *     rename) and replaced well before it expires;
 *   • stopping the process removes the file.
 *
 * Nothing here prints a token: log lines name only times and outcomes.
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// workos.ts imports its siblings without extensions, as the bundler allows;
// the hook resolves them to `.ts` (Node strips the types).
await import("../../../../../packages/host-core/src/secrets/test-support/ts-hooks.mjs");
const account = (name) =>
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../../../src/main/account", name))
    .href;
const { createPkcePair, newState } = await import(account("pkce.ts"));
const { listenForCallback } = await import(account("loopback.ts"));
const { isProviderRefused } = await import(account("provider.ts"));
const { workosProvider } = await import(account("workos.ts"));

export { workosProvider };

/** How long the person has to finish the browser sign-in. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
/** Refresh this long before expiry when the token lives long enough to allow it. */
const REFRESH_MARGIN_MS = 60 * 1000;
/** The wait after a transient refresh failure (offline, a 5xx). */
const RETRY_MS = 15 * 1000;
const MIN_DELAY_MS = 250;

/**
 * When to refresh a token that expires at `expiresAt`: a minute early, or
 * halfway through its remaining life when that is under two minutes.
 */
export function refreshDelayMs(expiresAt, now) {
  const remaining = expiresAt - now;
  const delay = remaining > 2 * REFRESH_MARGIN_MS ? remaining - REFRESH_MARGIN_MS : remaining / 2;
  return Math.max(MIN_DELAY_MS, Math.floor(delay));
}

/** The output path: absolute, and not a symlink or anything but a regular file. */
export async function assertTokenPath(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("--out must be an absolute path");
  const parent = await fs.stat(dirname(path)).catch(() => null);
  if (!parent?.isDirectory()) throw new Error("--out's directory does not exist");
  const existing = await fs.lstat(path).catch(() => null);
  if (existing !== null && !existing.isFile())
    throw new Error("--out exists and is not a regular file");
}

/**
 * Replaces `path` with `token` in one rename, so a reader sees the old token
 * or the new one, never a partial file. The temp file is created 0600 and
 * exclusive in the same directory (same volume, so the rename is atomic).
 */
export async function writeTokenFile(path, token) {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await fs.open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(token, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

const seconds = (ms) => `${Math.round(ms / 1000)}s`;
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

const abortable = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Signs in once, then keeps `out` holding a current access token until
 * `signal` aborts (returns normally, file removed) or the provider refuses
 * the refresh token (throws, file removed: the sign-in is dead).
 *
 * `openUrl` shows the authorization URL to the person (the browser);
 * `log` receives token-free progress lines.
 */
export async function runTokenFile({
  provider,
  out,
  connection,
  openUrl,
  log,
  signal,
  now = Date.now,
  retryMs = RETRY_MS,
  signInTimeoutMs = SIGN_IN_TIMEOUT_MS,
}) {
  if (connection !== "github" && connection !== "google")
    throw new Error("--connection must be github or google");
  await assertTokenPath(out);
  const pkce = createPkcePair();
  const state = newState();
  const callback = await listenForCallback({ state, timeoutMs: signInTimeoutMs, signal });
  // The loopback listener and its timer are unref'd (desktop main stays alive
  // on its own); this process has nothing else running while the person signs in.
  const hold = setInterval(() => {}, 1 << 30);
  let tokens;
  try {
    await openUrl(
      await provider.authorizationUrl({
        redirectUri: callback.redirectUri,
        state,
        codeChallenge: pkce.challenge,
        connection,
      }),
    );
    let result;
    try {
      result = await callback.result;
    } catch (error) {
      // Stopped before the browser came back: a normal stop, nothing written.
      if (signal?.aborted) return;
      throw error;
    }
    if (result.kind !== "code") throw new Error(`sign-in did not finish: ${result.error}`);
    tokens = await provider.exchangeCode({
      code: result.code,
      codeVerifier: pkce.verifier,
      redirectUri: callback.redirectUri,
    });
  } finally {
    clearInterval(hold);
    callback.close();
  }
  try {
    await writeTokenFile(out, tokens.accessToken);
    log(`signed in; token written, expires ${clock(tokens.accessExpiresAt)}`);
    let wait = refreshDelayMs(tokens.accessExpiresAt, now());
    for (;;) {
      await abortable(wait, signal);
      if (signal?.aborted) break;
      try {
        tokens = await provider.refresh(tokens.refreshToken);
      } catch (error) {
        if (isProviderRefused(error))
          throw new Error("the provider refused the refresh; sign in again", { cause: error });
        const left = tokens.accessExpiresAt - now();
        log(
          left > 0
            ? `refresh failed (transient); retrying, current token valid for ${seconds(left)}`
            : "refresh failed (transient); retrying, current token has EXPIRED",
        );
        wait = retryMs;
        continue;
      }
      await writeTokenFile(out, tokens.accessToken);
      log(`refreshed; expires ${clock(tokens.accessExpiresAt)}`);
      wait = refreshDelayMs(tokens.accessExpiresAt, now());
    }
  } finally {
    await fs.rm(out, { force: true });
  }
}
