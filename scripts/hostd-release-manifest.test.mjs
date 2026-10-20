import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  generateHostdReleaseManifest,
  releaseVersion,
  repositoryRoot,
  targets,
} from "./hostd-release-manifest.mjs";

const expectedTargets = [
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "arm64"],
  ["darwin", "x64"],
];

function fixture(t, version = "1.2.3") {
  const root = mkdtempSync(join(repositoryRoot, ".hostd-manifest-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "apps/desktop"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "apps/desktop/package.json"), JSON.stringify({ version }));
  const assets = join(root, "assets");
  mkdirSync(assets);
  writeFileSync(join(root, "payload"), "hostd test payload\n");
  const names = expectedTargets.map(
    ([platform, arch]) => `volli-hostd-${version}-${platform}-${arch}.tar.gz`,
  );
  for (const name of names) {
    execFileSync("tar", ["-czf", join(assets, name), "-C", root, "payload"]);
    const sha256 = createHash("sha256")
      .update(readFileSync(join(assets, name)))
      .digest("hex");
    writeFileSync(join(assets, `${name}.sha256`), `${sha256}  ${name}\n`);
  }
  return { root, assets, names };
}

for (const version of ["1.2.3", "1.2.3-canary.42", "1.2.3-beta.1"]) {
  test(`generates exact independently recomputed checksums and manifest for ${version}`, async (t) => {
    const { root, assets, names } = fixture(t, version);
    const manifest = await generateHostdReleaseManifest(assets, root);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.version, version);
    assert.equal(manifest.releaseTag, `v${version}`);
    assert.deepEqual(
      manifest.assets.map(({ platform, arch }) => [platform, arch]),
      expectedTargets,
    );
    const sums = names
      .map((name, index) => {
        const bytes = readFileSync(join(assets, name));
        const digest = createHash("sha256").update(bytes).digest("hex");
        assert.equal(manifest.assets[index].sha256, digest);
        assert.equal(manifest.assets[index].name, name);
        assert.equal(manifest.assets[index].size, bytes.length);
        return `${digest}  ${name}\n`;
      })
      .join("");
    assert.equal(readFileSync(join(assets, "SHA256SUMS"), "utf8"), sums);
    assert.deepEqual(
      JSON.parse(readFileSync(join(assets, "hostd-release-manifest.json"), "utf8")),
      manifest,
    );
    assert.deepEqual(await generateHostdReleaseManifest(assets, root), manifest);
  });
}

test("fails on root/desktop version drift before writing outputs", async (t) => {
  const { root, assets } = fixture(t);
  writeFileSync(join(root, "apps/desktop/package.json"), JSON.stringify({ version: "1.2.4" }));
  await assert.rejects(generateHostdReleaseManifest(assets, root), /Version drift/);
  assert.equal(existsSync(join(assets, "SHA256SUMS")), false);
});

test("release targets are exactly linux x64/arm64 then darwin arm64/x64", () => {
  assert.deepEqual(
    targets.map(({ platform, arch }) => [platform, arch]),
    expectedTargets,
  );
  assert.ok(Object.isFrozen(targets));
});

for (const [index, [platform, arch]] of expectedTargets.entries()) {
  for (const target of ["tarball", "sidecar"]) {
    test(`rejects missing ${platform}-${arch} ${target}`, async (t) => {
      const { root, assets, names } = fixture(t);
      rmSync(join(assets, names[index] + (target === "sidecar" ? ".sha256" : "")));
      await assert.rejects(generateHostdReleaseManifest(assets, root), /Missing release asset/);
      assert.equal(existsSync(join(assets, "SHA256SUMS")), false);
      assert.equal(existsSync(join(assets, "hostd-release-manifest.json")), false);
    });
  }
}

test("rejects tarball tampering and emits neither output", async (t) => {
  const { root, assets, names } = fixture(t);
  writeFileSync(join(assets, names[3]), "tampered");
  await assert.rejects(generateHostdReleaseManifest(assets, root), /SHA256 mismatch/);
  assert.equal(existsSync(join(assets, "SHA256SUMS")), false);
  assert.equal(existsSync(join(assets, "hostd-release-manifest.json")), false);
});

for (const sidecar of [
  "not a checksum",
  `${"a".repeat(64)}  wrong-name.tar.gz\n`,
  `${"a".repeat(64)}  NAME\nextra\n`,
]) {
  test(`rejects malformed/renamed sidecar: ${sidecar.slice(0, 20)}`, async (t) => {
    const { root, assets, names } = fixture(t);
    writeFileSync(join(assets, `${names[0]}.sha256`), sidecar.replace("NAME", names[0]));
    await assert.rejects(generateHostdReleaseManifest(assets, root), /Invalid checksum sidecar/);
  });
}

test("rejects checksum tampering", async (t) => {
  const { root, assets, names } = fixture(t);
  writeFileSync(join(assets, `${names[0]}.sha256`), `${"0".repeat(64)}  ${names[0]}\n`);
  await assert.rejects(generateHostdReleaseManifest(assets, root), /SHA256 mismatch/);
});

test("rejects extra/wrong-version filenames", async (t) => {
  const { root, assets, names } = fixture(t);
  renameSync(join(assets, names[0]), join(assets, "volli-hostd-9.9.9-linux-x64.tar.gz"));
  await assert.rejects(generateHostdReleaseManifest(assets, root), /Unexpected release asset/);
});

for (const extra of [
  "volli-hostd-1.2.3-darwin-universal.tar.gz",
  "volli-hostd-1.2.3-win32-x64.tar.gz",
]) {
  test(`rejects an unlisted target: ${extra}`, async (t) => {
    const { root, assets } = fixture(t);
    writeFileSync(join(assets, extra), "unexpected");
    await assert.rejects(generateHostdReleaseManifest(assets, root), /Unexpected release asset/);
    assert.equal(existsSync(join(assets, "SHA256SUMS")), false);
  });
}

test("CLI requires --assets and generates outputs at the requested path", (t) => {
  const script = join(repositoryRoot, "scripts/hostd-release-manifest.mjs");
  const missingArg = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(missingArg.status, 1);
  assert.match(missingArg.stderr, /Usage:/);
  const { assets } = fixture(t, releaseVersion());
  const success = spawnSync(process.execPath, [script, "--assets", assets], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(existsSync(join(assets, "SHA256SUMS")), true);
  const manifest = JSON.parse(readFileSync(join(assets, "hostd-release-manifest.json"), "utf8"));
  assert.equal(manifest.version, releaseVersion());
});
