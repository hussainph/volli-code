import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertTokenPath,
  refreshDelayMs,
  runTokenFile,
  workosProvider,
  writeTokenFile,
} from "./staging-token.mjs";

/** A stand-in for WorkOS `/user_management/authenticate`: short-lived opaque tokens. */
async function fakeWorkos({ ttlSeconds = 1, failRefreshes = [], refuseAfter = Infinity } = {}) {
  const requests = [];
  let refreshes = 0;
  let issued = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const reply = (status, json) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(json));
    };
    if (request.url !== "/user_management/authenticate" || body.client_id !== "client_staging")
      return reply(404, {});
    if (body.grant_type === "authorization_code") {
      if (body.code !== "the-code" || typeof body.code_verifier !== "string")
        return reply(400, { error: "invalid_grant" });
    } else if (body.grant_type === "refresh_token") {
      if (body.refresh_token !== `refresh-${issued}`) return reply(400, { error: "invalid_grant" });
      refreshes += 1;
      if (refreshes > refuseAfter) return reply(400, { error: "invalid_grant" });
      if (failRefreshes.includes(refreshes)) return reply(503, {});
    } else return reply(400, { error: "unsupported_grant_type" });
    issued += 1;
    reply(200, {
      access_token: `access-${issued}`,
      refresh_token: `refresh-${issued}`,
      expires_in: ttlSeconds,
      user: { email: "rehearsal@example.com" },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Plays the browser: follow the authorization URL's redirect with a code. */
const browser = async (url) => {
  const authorize = new URL(url);
  assert.equal(authorize.pathname, "/user_management/authorize");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("provider"), "GitHubOAuth");
  const callback = new URL(authorize.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", "the-code");
  callback.searchParams.set("state", authorize.searchParams.get("state"));
  setImmediate(() => void fetch(callback));
};

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "staging-token-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const waitFor = async (check, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("refreshes a minute early, or halfway through a short life", () => {
  assert.equal(refreshDelayMs(5 * 60_000, 0), 4 * 60_000);
  assert.equal(refreshDelayMs(60 * 60_000, 0), 59 * 60_000);
  assert.equal(refreshDelayMs(60_000, 0), 30_000);
  assert.equal(refreshDelayMs(1000, 0), 500);
  assert.equal(refreshDelayMs(0, 1000), 250, "an expired token refreshes at once");
});

test("the output path is absolute, in an existing directory, and never a symlink", async () => {
  await withDir(async (dir) => {
    await assert.rejects(assertTokenPath("token"), /absolute/);
    await assert.rejects(assertTokenPath(join(dir, "missing", "token")), /directory/);
    await symlink(join(dir, "elsewhere"), join(dir, "link"));
    await assert.rejects(assertTokenPath(join(dir, "link")), /not a regular file/);
    await writeFile(join(dir, "old"), "stale");
    await assertTokenPath(join(dir, "old"));
  });
});

test("writes atomically, mode 0600, replacing the old file and leaving no temp files", async () => {
  await withDir(async (dir) => {
    const out = join(dir, "token");
    await writeFile(out, "stale", { mode: 0o644 });
    await writeTokenFile(out, "fresh");
    assert.equal(await readFile(out, "utf8"), "fresh");
    assert.equal((await lstat(out)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ["token"]);
  });
});

test("signs in with PKCE, keeps the file fresh across refreshes, removes it on stop", async () => {
  const workos = await fakeWorkos({ ttlSeconds: 1, failRefreshes: [2] });
  const lines = [];
  const controller = new AbortController();
  try {
    await withDir(async (dir) => {
      const out = join(dir, "token");
      const running = runTokenFile({
        provider: workosProvider({ clientId: "client_staging", apiBase: workos.apiBase }),
        out,
        connection: "github",
        openUrl: browser,
        log: (line) => lines.push(line),
        signal: controller.signal,
        retryMs: 50,
      });
      // access-1 from the code; refresh 1 → access-2; refresh 2 fails (503)
      // and is retried → access-3; refresh 3 → access-4.
      await waitFor(async () => (await readFile(out, "utf8").catch(() => "")) === "access-4");
      assert.equal((await lstat(out)).mode & 0o777, 0o600);
      controller.abort();
      await running;
      await assert.rejects(lstat(out), { code: "ENOENT" });
      assert.deepEqual(await readdir(dir), []);
    });
    const [exchange, ...refreshes] = workos.requests;
    assert.equal(exchange.grant_type, "authorization_code");
    assert.match(exchange.code_verifier, /^[\w-]{43}$/u);
    assert.deepEqual(
      refreshes.slice(0, 4).map((request) => request.refresh_token),
      ["refresh-1", "refresh-2", "refresh-2", "refresh-3"],
      "every refresh uses the latest rotated refresh token",
    );
    assert.ok(lines.some((line) => line.includes("refresh failed (transient)")));
    for (const line of lines) assert.doesNotMatch(line, /access-|refresh-\d/u, "no token logged");
  } finally {
    await workos.close();
  }
});

test("a refused refresh ends the run and removes the file", async () => {
  const workos = await fakeWorkos({ ttlSeconds: 1, refuseAfter: 0 });
  try {
    await withDir(async (dir) => {
      const out = join(dir, "token");
      await assert.rejects(
        runTokenFile({
          provider: workosProvider({ clientId: "client_staging", apiBase: workos.apiBase }),
          out,
          connection: "github",
          openUrl: browser,
          log: () => {},
        }),
        /refused the refresh; sign in again/,
      );
      await assert.rejects(lstat(out), { code: "ENOENT" });
    });
  } finally {
    await workos.close();
  }
});

test("refuses an unknown connection before listening", async () => {
  await assert.rejects(
    runTokenFile({ provider: {}, out: "/tmp/x", connection: "okta", openUrl: () => {} }),
    /github or google/,
  );
});
