import assert from "node:assert/strict";
import { test } from "node:test";

import { ConvexCallError, convexCall, fixtureFromEnv, waitFor } from "./backend.mjs";

const ENV = {
  VOLLI_CONVEX_URL: "http://127.0.0.1:3210",
  VOLLI_CONVEX_SITE_URL: "http://127.0.0.1:3211/",
  VOLLI_CONVEX_TEST_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
  VOLLI_CONVEX_ADMIN_KEY: "admin",
};

test("the fixture is a loopback backend with a test issuer and an admin key, or nothing", () => {
  assert.deepEqual(fixtureFromEnv(ENV), {
    convexUrl: "http://127.0.0.1:3210",
    siteUrl: "http://127.0.0.1:3211",
    privateKeyPem: ENV.VOLLI_CONVEX_TEST_PRIVATE_KEY,
    adminKey: "admin",
  });
  assert.throws(
    () => fixtureFromEnv({ ...ENV, VOLLI_CONVEX_URL: "https://rosy-cardinal-131.convex.cloud" }),
    /loopback fixture backend/u,
  );
  assert.throws(
    () => fixtureFromEnv({ ...ENV, VOLLI_CONVEX_TEST_PRIVATE_KEY: "" }),
    /with-backend/u,
  );
  assert.throws(() => fixtureFromEnv({ ...ENV, VOLLI_CONVEX_ADMIN_KEY: "" }), /ADMIN_KEY/u);
  assert.throws(() => fixtureFromEnv({ ...ENV, VOLLI_CONVEX_SITE_URL: "nope" }), /not a URL/u);
});

function fakeFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status: 200 });
  };
  return { calls, impl };
}

test("a call posts the HTTP API's shape with the caller's credential and answers the value", async () => {
  const person = fakeFetch({ status: "success", value: [1, 2] });
  const value = await convexCall(
    "http://b",
    "query",
    "runners:list",
    {},
    { bearer: "tok" },
    person.impl,
  );
  assert.deepEqual(value, [1, 2]);
  assert.equal(person.calls[0].url, "http://b/api/query");
  assert.equal(person.calls[0].init.headers.authorization, "Bearer tok");
  assert.deepEqual(person.calls[0].body, { path: "runners:list", args: {}, format: "json" });

  const admin = fakeFetch({ status: "success", value: null });
  await convexCall(
    "http://b",
    "mutation",
    "previewAccess:set",
    { a: 1 },
    { admin: "k" },
    admin.impl,
  );
  assert.equal(admin.calls[0].init.headers.authorization, "Convex k");
  assert.equal(admin.calls[0].url, "http://b/api/mutation");

  await assert.rejects(convexCall("http://b", "delete", "x:y"), /not a function kind/u);
});

test("a failed call carries the ConvexError payload and code", async () => {
  const failing = fakeFetch({
    status: "error",
    errorMessage: "That runner does not exist.",
    errorData: { code: "not_found", message: "That runner does not exist." },
  });
  const error = await convexCall(
    "http://b",
    "mutation",
    "runners:remove",
    {},
    {},
    failing.impl,
  ).catch((caught) => caught);
  assert.ok(error instanceof ConvexCallError);
  assert.equal(error.code, "not_found");
  assert.match(error.message, /^runners:remove: That runner/u);
  const garbled = await convexCall(
    "http://b",
    "query",
    "x:y",
    {},
    {},
    fakeFetch("<html>").impl,
  ).catch((caught) => caught);
  assert.equal(garbled.code, null);
  assert.match(garbled.message, /HTTP 200: <html>/u);
});

test("waitFor answers the first truthy probe, retries through throws, and names a timeout", async () => {
  let calls = 0;
  const value = await waitFor(
    "the third try",
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("not yet");
      return calls === 3 ? "done" : null;
    },
    { intervalMs: 1 },
  );
  assert.equal(value, "done");
  await assert.rejects(
    waitFor("never", async () => false, { timeoutMs: 20, intervalMs: 5 }),
    /timed out after 20 ms waiting for never \(last: false\)/u,
  );
});
