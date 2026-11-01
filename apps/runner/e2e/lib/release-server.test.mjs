import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { assetSetVersion, ReleaseServer, startReleaseServer } from "./release-server.mjs";

let release;
const scratch = mkdtempSync(join(tmpdir(), "byo-release-"));

before(async () => {
  release = await startReleaseServer();
});
after(async () => {
  await release.close();
  rmSync(scratch, { recursive: true, force: true });
});

test("assets are served under GitHub's download layout, latest = newest non-prerelease", async () => {
  const script = join(scratch, "install.sh");
  writeFileSync(script, '#!/bin/sh\nmain() { :; }\nmain "$@"\n');
  release.publish("v0.3.0", { "volli-runner-install.sh": script, "a.json": Buffer.from("{}") });
  release.publish(
    "v0.3.1-canary.1",
    { "a.json": Buffer.from('{"canary":true}') },
    { prerelease: true },
  );
  release.publish("v0.3.2", { "a.json": Buffer.from('{"draft":true}') }, { draft: true });

  assert.equal(
    release.downloadBase("v0.3.0"),
    `${release.origin}/hussainph/volli-code/releases/download/v0.3.0`,
  );
  const fetched = await fetch(release.assetUrl("v0.3.0", "volli-runner-install.sh"));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "text/x-shellscript");
  assert.match(await fetched.text(), /main "\$@"/u);
  const head = await fetch(release.assetUrl("v0.3.0", "a.json"), { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "2");

  const latest = await fetch(
    `${release.origin}/hussainph/volli-code/releases/latest/download/a.json`,
  );
  assert.equal(await latest.text(), "{}");
  // A draft is served by nothing; an unknown asset, tag or repo is a 404.
  assert.equal((await fetch(release.assetUrl("v0.3.2", "a.json"))).status, 404);
  assert.equal((await fetch(release.assetUrl("v0.3.0", "missing.json"))).status, 404);
  assert.equal(
    (await fetch(`${release.origin}/someone/else/releases/download/v0.3.0/a.json`)).status,
    404,
  );
  assert.equal((await fetch(release.assetUrl("v0.3.0", "a.json"), { method: "POST" })).status, 405);
  assert.throws(
    () => release.publish("v9", { "../escape": Buffer.from("") }),
    /not an asset name/u,
  );
});

test("the Releases API lists published releases newest first, with absolute asset URLs", async () => {
  const list = await (await fetch(`${release.apiUrl}/repos/hussainph/volli-code/releases`)).json();
  assert.deepEqual(
    list.map((entry) => [entry.tag_name, entry.prerelease, entry.draft]),
    [
      ["v0.3.1-canary.1", true, false],
      ["v0.3.0", false, false],
    ],
  );
  assert.equal(
    list[1].assets.find((asset) => asset.name === "a.json").browser_download_url,
    release.assetUrl("v0.3.0", "a.json"),
  );
  const latest = await (
    await fetch(`${release.apiUrl}/repos/hussainph/volli-code/releases/latest`)
  ).json();
  assert.equal(latest.tag_name, "v0.3.0");
  assert.ok(release.requests.length > 0);
});

test("an asset set's version comes from both tarballs, which must agree", () => {
  const x64 = "volli-runner-0.3.0-linux-x64.tar.gz";
  const arm = "volli-runner-0.3.0-linux-arm64.tar.gz";
  assert.equal(assetSetVersion([x64, `${x64}.sha256`, arm, `${arm}.sha256`]), "0.3.0");
  assert.equal(
    assetSetVersion([
      "volli-runner-0.3.1-canary.2-linux-x64.tar.gz",
      "volli-runner-0.3.1-canary.2-linux-arm64.tar.gz",
    ]),
    "0.3.1-canary.2",
  );
  assert.throws(() => assetSetVersion([x64]), /need both linux tarballs/u);
  assert.throws(
    () => assetSetVersion([x64, "volli-runner-0.3.1-linux-arm64.tar.gz"]),
    /one version/u,
  );
  assert.throws(() => assetSetVersion([]), /found: none/u);
});

test("mounted on another server, it answers only its own repository's release paths", async () => {
  const mounted = new ReleaseServer().mountedAt("https://github.byo.test:4443/");
  mounted.publish("v1.0.0", { "a.json": Buffer.from("{}") });
  assert.equal(
    mounted.downloadBase("v1.0.0"),
    "https://github.byo.test:4443/hussainph/volli-code/releases/download/v1.0.0",
  );
  assert.equal(mounted.serves("/hussainph/volli-code/releases/download/v1.0.0/a.json"), true);
  assert.equal(mounted.serves("/api/v3/repos/hussainph/volli-code/releases"), true);
  assert.equal(mounted.serves("/hussainph/volli-code.git/info/refs"), false);
  assert.equal(mounted.serves("/someone/else/releases/download/v1.0.0/a.json"), false);
  const sent = {};
  const response = {
    writeHead: (status, headers) => Object.assign(sent, { status, headers }),
    end: (body) => (sent.body = String(body)),
  };
  const request = { method: "GET", url: "/hussainph/volli-code/releases/download/v1.0.0/a.json" };
  assert.equal(mounted.handle(request, response), true);
  assert.deepEqual([sent.status, sent.body], [200, "{}"]);
  assert.equal(
    mounted.handle({ method: "GET", url: "/byo-person/demo.git/info/refs" }, response),
    false,
  );
});
