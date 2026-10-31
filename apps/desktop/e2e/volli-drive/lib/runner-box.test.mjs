import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./runner-box.mjs", import.meta.url));
const token = "vrt_fixture_install_token";
const credential = "vrc_fixture_refresh_credential";
const rotated = "vrc_fixture_rotated_credential";
const jwt = "fixture.jwt.signature";

async function fixture(t, refuse = false) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    requests.push({ path: request.url, data, auth: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (refuse) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { code: "invalid_install_token", message: token } }));
    } else if (request.url === "/runner/link") {
      response.end(JSON.stringify({ runnerId: "box-id", name: "box", credential, generation: 1 }));
    } else if (request.url === "/runner/token") {
      response.end(
        JSON.stringify({
          token: jwt,
          credential: rotated,
          generation: 2,
          expiresAt: 2000,
          serverTime: 1000,
        }),
      );
    } else {
      response.end(
        JSON.stringify({
          status: "success",
          value:
            data.path === "runners:reportCapabilities" ? { changed: true } : { status: "online" },
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { requests, url };
}

function box(t, url) {
  const child = spawn(process.execPath, [script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      VOLLI_RUNNER_TOKEN: token,
      VOLLI_BOX_SITE_URL: url,
      VOLLI_BOX_CONVEX_URL: url,
      VOLLI_BOX_VERSION: "0.3.0",
    },
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  let stdout = "";
  let stderr = "";
  const events = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      events.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
      child.emit("box-event");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    exited,
    events,
    output: () => stdout + stderr,
    async event(name) {
      while (!events.some((event) => event.event === name)) await once(child, "box-event");
      return events.find((event) => event.event === name);
    },
  };
}

test(
  "simulated box uses the real HTTP envelopes, waits for release, and never logs credentials",
  { timeout: 10000 },
  async (t) => {
    const backend = await fixture(t);
    const running = box(t, backend.url);
    assert.equal((await running.event("linked")).runnerId, "box-id");
    assert.deepEqual(
      backend.requests.map((request) => request.path),
      ["/runner/link"],
    );
    assert.equal(backend.requests[0].data.installToken, token);
    assert.equal(backend.requests[0].data.name, null);
    assert.equal(backend.requests[0].data.host.platform.os, "linux");
    running.child.stdin.write("go\n");
    assert.equal((await running.event("token")).rotated, true);
    assert.equal((await running.event("reported")).version, "0.3.0");
    assert.equal((await running.event("online")).status, "online");
    assert.equal(backend.requests[1].data.credential, credential);
    assert.deepEqual(
      backend.requests.slice(2).map((request) => request.data.path),
      ["runners:reportCapabilities", "runners:heartbeat"],
    );
    assert.equal(backend.requests[2].auth, `Bearer ${jwt}`);
    running.child.kill("SIGTERM");
    assert.deepEqual(await running.exited, [0, null]);
    for (const secret of [token, credential, rotated, jwt])
      assert.equal(running.output().includes(secret), false);
  },
);

test(
  "backend rejection reports only the code, never the echoed body",
  { timeout: 10000 },
  async (t) => {
    const backend = await fixture(t, true);
    const running = box(t, backend.url);
    assert.deepEqual(await running.exited, [1, null]);
    assert.match(running.output(), /link: invalid_install_token/u);
    assert.equal(running.output().includes(token), false);
  },
);

test(
  "simulated box refuses a non-loopback target before linking",
  { timeout: 10000 },
  async (t) => {
    const running = box(t, "https://example.com");
    assert.deepEqual(await running.exited, [1, null]);
    assert.match(running.output(), /box: not_loopback/u);
  },
);
