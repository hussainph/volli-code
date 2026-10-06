import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { repositoryRoot } from "../../../scripts/hostd-release-manifest.mjs";
import { copyHostdManifest } from "./copy-hostd-manifest.mjs";

function fixture(t, version = "1.2.3") {
  const root = mkdtempSync(join(repositoryRoot, ".hostd-copy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "apps/desktop"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "apps/desktop/package.json"), JSON.stringify({ version }));
  const manifest = {
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    assets: [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "arm64"],
      ["darwin", "x64"],
    ].map(([platform, arch]) => ({
      platform,
      arch,
      name: `volli-hostd-${version}-${platform}-${arch}.tar.gz`,
      sha256: createHash("sha256").update(`test fixture ${platform} ${arch}`).digest("hex"),
      size: 42,
    })),
  };
  const manifestPath = join(root, "manifest.json");
  const destination = join(root, "apps/desktop/dist-electron/hostd-release-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath, destination, manifest };
}

for (const version of ["1.2.3", "1.2.3-canary.42"]) {
  test(`copies validated ${version} manifest into packaged runtime path`, (t) => {
    const { root, manifestPath, destination, manifest } = fixture(t, version);
    assert.deepEqual(copyHostdManifest({ root, manifestPath }), manifest);
    assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), manifest);
  });
}

test("uses VOLLI_HOSTD_MANIFEST input and overwrites stale packaged metadata", (t) => {
  const { root, manifestPath, destination, manifest } = fixture(t);
  const previous = process.env.VOLLI_HOSTD_MANIFEST;
  t.after(() => {
    if (previous === undefined) delete process.env.VOLLI_HOSTD_MANIFEST;
    else process.env.VOLLI_HOSTD_MANIFEST = previous;
  });
  delete process.env.VOLLI_HOSTD_MANIFEST;
  const local = copyHostdManifest({ root });
  assert.deepEqual(local.assets, []);
  process.env.VOLLI_HOSTD_MANIFEST = manifestPath;
  copyHostdManifest({ root });
  assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), manifest);
  delete process.env.VOLLI_HOSTD_MANIFEST;
  const unavailable = copyHostdManifest({ root });
  assert.equal(unavailable.version, manifest.version);
  assert.equal(unavailable.releaseTag, manifest.releaseTag);
  assert.equal(unavailable.schemaVersion, 1);
  assert.deepEqual(unavailable.assets, []);
  assert.match(unavailable.unavailableReason, /Local build.*not set/);
  assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), unavailable);
});

const mutations = {
  "wrong schema": (manifest) => {
    manifest.schemaVersion = 2;
  },
  "wrong version": (manifest) => {
    manifest.version = "1.2.4";
  },
  "wrong release tag": (manifest) => {
    manifest.releaseTag = "v1.2.4";
  },
  "missing arch": (manifest) => {
    manifest.assets.pop();
  },
  "missing darwin target (the Linux-only pair)": (manifest) => {
    manifest.assets = manifest.assets.filter((asset) => asset.platform === "linux");
  },
  "extra target": (manifest) => {
    manifest.assets.push({ ...manifest.assets[0], platform: "win32" });
  },
  "unavailable release input": (manifest) => {
    manifest.assets = [];
  },
  "duplicate arch": (manifest) => {
    manifest.assets[1] = manifest.assets[0];
  },
  "same arch on the other platform": (manifest) => {
    manifest.assets[3] = { ...manifest.assets[0] };
  },
  "wrong filename": (manifest) => {
    manifest.assets[0].name = "../hostd.tar.gz";
  },
  "wrong platform": (manifest) => {
    manifest.assets[0].platform = "darwin";
  },
  "darwin name on a linux entry": (manifest) => {
    manifest.assets[0].name = manifest.assets[3].name;
  },
  "invalid checksum": (manifest) => {
    manifest.assets[0].sha256 = "fabricated";
  },
  "invalid darwin checksum": (manifest) => {
    manifest.assets[2].sha256 = "A".repeat(64);
  },
  "invalid size": (manifest) => {
    manifest.assets[0].size = -1;
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`fails closed on ${name}`, (t) => {
    const { root, manifestPath, destination, manifest } = fixture(t);
    mutate(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => copyHostdManifest({ root, manifestPath }), /manifest|size/);
    assert.equal(existsSync(destination), false);
  });
}

test("fails rather than falling back for missing/invalid supplied input", (t) => {
  const { root, manifestPath, destination } = fixture(t);
  rmSync(manifestPath);
  assert.throws(() => copyHostdManifest({ root, manifestPath }), /ENOENT/);
  writeFileSync(manifestPath, "not JSON");
  assert.throws(() => copyHostdManifest({ root, manifestPath }), SyntaxError);
  assert.throws(() => copyHostdManifest({ root, manifestPath: "" }));
  assert.equal(existsSync(destination), false);
});

test("fails on root/desktop version drift", (t) => {
  const { root, manifestPath } = fixture(t);
  writeFileSync(join(root, "apps/desktop/package.json"), JSON.stringify({ version: "1.2.4" }));
  assert.throws(() => copyHostdManifest({ root, manifestPath }), /Version drift/);
});

test("CLI exits nonzero when VOLLI_HOSTD_MANIFEST points to a missing file", (t) => {
  const { root } = fixture(t);
  const outcome = spawnSync(
    process.execPath,
    [join(repositoryRoot, "apps/desktop/scripts/copy-hostd-manifest.mjs")],
    {
      env: { ...process.env, VOLLI_HOSTD_MANIFEST: join(root, "missing.json") },
      encoding: "utf8",
    },
  );
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /ENOENT/);
});

test("desktop build copies after pack/CLI and packaging includes dist-electron", () => {
  const config = readFileSync(join(repositoryRoot, "apps/desktop/vite.config.ts"), "utf8");
  assert.match(
    config,
    /vp pack && node scripts\/copy-cli\.mjs && node scripts\/copy-hostd-manifest\.mjs/,
  );
  const packaging = readFileSync(join(repositoryRoot, "apps/desktop/electron-builder.yml"), "utf8");
  assert.match(packaging, /^  - dist-electron\/\*\*$/m);
});
