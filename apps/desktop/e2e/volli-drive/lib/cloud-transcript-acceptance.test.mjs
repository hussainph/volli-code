import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  presignS3Request,
  presignS3ListObjects,
} from "../../../../../packages/shared/src/cloud/s3-presign.ts";
import { startTranscriptStore } from "./cloud-transcript-acceptance.mjs";

const issueSignedRequest = async (signed, payload) => {
  const response = await fetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  return { response, body: await response.text() };
};

test("the fixture accepts real history and write-once move signatures, HEAD, listing and purge", async (t) => {
  const report = await mkdtemp(join(tmpdir(), "move-s3-boundary-"));
  t.after(() => rm(report, { recursive: true, force: true }));
  let environment;
  const configServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    environment = Object.fromEntries(
      JSON.parse(Buffer.concat(chunks).toString("utf8")).changes.map(({ name, value }) => [
        name,
        value,
      ]),
    );
    response.writeHead(200).end("{}");
  });
  await new Promise((resolve) => configServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => configServer.close(resolve)));
  const store = await startTranscriptStore(
    { convexUrl: `http://127.0.0.1:${configServer.address().port}`, adminKey: "fixture-only" },
    report,
  );
  let expectedRejections = 0;
  t.after(async () => {
    const closed = await store.close();
    assert.equal(closed.problems.length, expectedRejections);
  });
  // These are the throwaway store's generated keys, never a deployment credential.
  const config = {
    endpoint: store.endpoint,
    bucket: environment.VOLLI_S3_BUCKET,
    accessKeyId: environment.VOLLI_S3_ACCESS_KEY_ID,
    secretAccessKey: environment.VOLLI_S3_SECRET_ACCESS_KEY,
    region: "auto",
    expiresSeconds: 300,
    now: Date.now(),
  };
  const body = Buffer.from("history\n");
  const checksum = createHash("sha256").update(body).digest("base64");
  const key = "v1/p/project/s/session/tx/pack.zst";
  const headers = { "content-length": String(body.length), "x-amz-checksum-sha256": checksum };
  const once = presignS3Request({
    ...config,
    key,
    method: "PUT",
    headers: { ...headers, "if-none-match": "*" },
  });
  assert.equal((await issueSignedRequest(once, body)).response.status, 200);
  assert.equal(store.requests.at(-1).verification, "move");
  assert.equal((await issueSignedRequest(once, body)).response.status, 412);
  const head = await issueSignedRequest(
    presignS3Request({
      ...config,
      key,
      method: "HEAD",
      headers: { "x-amz-checksum-mode": "ENABLED" },
    }),
  );
  assert.equal(head.response.status, 200);
  assert.equal(head.response.headers.get("content-length"), String(body.length));
  assert.equal(head.response.headers.get("x-amz-checksum-sha256"), checksum);
  assert.equal(
    (await issueSignedRequest(presignS3Request({ ...config, key, method: "GET" }))).body,
    body.toString(),
  );
  const historyKey = "v1/p/project/s/session/tx/history.zst";
  assert.equal(
    (
      await issueSignedRequest(
        presignS3Request({ ...config, key: historyKey, method: "PUT", headers }),
        body,
      )
    ).response.status,
    200,
  );
  assert.equal(store.requests.at(-1).verification, "history");
  const page = await issueSignedRequest(
    presignS3ListObjects({
      ...config,
      prefix: "v1/p/project/",
      maxKeys: 1,
      continuationToken: null,
    }),
  );
  assert.equal(page.response.status, 200);
  assert.match(page.body, /<IsTruncated>true<\/IsTruncated>/u);
  const next = page.body.match(/<NextContinuationToken>(\d+)<\/NextContinuationToken>/u)?.[1];
  assert.equal(next, "1");
  const last = await issueSignedRequest(
    presignS3ListObjects({
      ...config,
      prefix: "v1/p/project/",
      maxKeys: 1,
      continuationToken: next,
    }),
  );
  assert.match(last.body, /<IsTruncated>false<\/IsTruncated>/u);
  assert.equal(
    (await issueSignedRequest(presignS3Request({ ...config, key, method: "DELETE" }))).response
      .status,
    204,
  );
  assert.equal(
    (
      await issueSignedRequest(
        presignS3Request({
          ...config,
          key,
          method: "HEAD",
          headers: { "x-amz-checksum-mode": "ENABLED" },
        }),
      )
    ).response.status,
    404,
  );
  assert.deepEqual(store.problems, []);
  const before = new Map(store.objects);
  const accepted = store.requests.length;
  const downgraded = { ...once, headers: { ...once.headers } };
  delete downgraded.headers["if-none-match"];
  const readSignature = presignS3Request({ ...config, key: historyKey, method: "GET" });
  const changedRoute = new URL(readSignature.url);
  changedRoute.searchParams.set("list-type", "2");
  const plain = presignS3Request({ ...config, key: historyKey, method: "PUT", headers });
  const invalid = [
    {
      signed: { url: `${store.endpoint}/${config.bucket}?list-type=2`, method: "GET", headers: {} },
    },
    { signed: { ...readSignature, method: "DELETE" } },
    { signed: downgraded, payload: body },
    { signed: { ...plain, headers: { ...plain.headers, "if-none-match": "*" } }, payload: body },
    { signed: { ...readSignature, url: changedRoute.toString() } },
  ];
  expectedRejections = invalid.length;
  for (const item of invalid)
    assert.equal((await issueSignedRequest(item.signed, item.payload)).response.status, 400);
  assert.deepEqual(
    store.objects,
    before,
    "unauthenticated routing cannot read, replace or purge objects",
  );
  assert.equal(store.requests.length, accepted, "no unauthenticated operation was accepted");
  assert.equal(store.problems.length, expectedRejections);
  assert.ok(store.problems[1].error.includes("Invalid S3 signature"));
  assert.ok(store.problems.every((item) => item.path?.startsWith(`/${config.bucket}`)));
});
