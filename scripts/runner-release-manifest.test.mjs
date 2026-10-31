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
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { releaseVersion, repositoryRoot } from "./hostd-release-manifest.mjs";
import {
  checksumsName,
  defaultReleaseBase,
  generateRunnerReleaseManifest,
  installerName,
  installerTemplatePath,
  installerVersionPlaceholder,
  manifestName,
  minGlibc,
  provenanceName,
  runnerAssetName,
  runnerTargets,
  validateRunnerReleaseManifest,
} from "./runner-release-manifest.mjs";

const expectedTargets = [
  ["linux", "x64"],
  ["linux", "arm64"],
];

// Fixture roots live in the workspace's ignored .tmp/, never the shared OS
// temp dir, so a leaked directory is visible and easy to remove.
const fixtureParent = join(repositoryRoot, ".tmp", "runner-release-manifest-test");

const installerTemplate = `#!/bin/sh
# Fixture installer: the release it installs is stamped in by the manifest step.
version="${installerVersionPlaceholder}"
echo "installing volli-runner $version"
`;

function digestOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture(t, { version = "1.2.3", template = installerTemplate } = {}) {
  mkdirSync(fixtureParent, { recursive: true });
  const root = mkdtempSync(join(fixtureParent, `${version.replace(/[^\w.-]/g, "_")}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "apps/desktop"), { recursive: true });
  mkdirSync(join(root, "apps/runner/packaging"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "apps/desktop/package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, installerTemplatePath), template);
  const assets = join(root, "assets");
  mkdirSync(assets);
  // A distinct payload per version keeps the archives (and their digests)
  // different across fixtures, as real releases are.
  writeFileSync(join(root, "payload"), `runner payload ${version}\n`);
  const names = runnerTargets.map((target) => runnerAssetName(version, target));
  for (const name of names) {
    execFileSync("tar", ["-czf", join(assets, name), "-C", root, "payload"]);
    writeFileSync(join(assets, `${name}.sha256`), `${digestOf(join(assets, name))}  ${name}\n`);
  }
  return { root, assets, names };
}

// The C4 manifest, filled in independently of the generator: digests and sizes
// come from the bytes on disk, not from the module under test.
function expectedManifest({
  version,
  assets,
  names,
  releaseBase = defaultReleaseBase(version),
  minRunnerVersion = version,
}) {
  return {
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    minRunnerVersion,
    minGlibc,
    targets: runnerTargets.map(({ platform, arch }, index) => {
      const bytes = readFileSync(join(assets, names[index]));
      return {
        platform,
        arch,
        url: `${releaseBase}/${names[index]}`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
    provenance: { bundleUrl: `${releaseBase}/${provenanceName}` },
  };
}

function checksumLines(assets) {
  return readFileSync(join(assets, checksumsName), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => {
      const [sha256, name] = line.split("  ");
      return { sha256, name };
    });
}

function assertNoOutputs(assets) {
  for (const name of [manifestName, checksumsName, installerName]) {
    assert.equal(existsSync(join(assets, name)), false, `${name} must not be written`);
  }
}

test("runner targets are exactly linux x64 then linux arm64", () => {
  assert.deepEqual(
    runnerTargets.map(({ platform, arch }) => [platform, arch]),
    expectedTargets,
  );
  assert.ok(Object.isFrozen(runnerTargets));
  assert.equal(minGlibc, "2.31");
});

test("the public release base is the tag URL for this repository", () => {
  assert.equal(
    defaultReleaseBase("0.3.0-canary.1"),
    "https://github.com/hussainph/volli-code/releases/download/v0.3.0-canary.1",
  );
  assert.equal(defaultReleaseBase(releaseVersion()).endsWith(`/v${releaseVersion()}`), true);
});

for (const version of ["1.2.3", "1.2.3-canary.42", "1.2.3-beta.1"]) {
  test(`generates the exact C4 manifest for ${version}`, async (t) => {
    const { root, assets, names } = fixture(t, { version });
    const manifest = await generateRunnerReleaseManifest(assets, { root });
    assert.deepEqual(manifest, expectedManifest({ version, assets, names }));
    assert.deepEqual(Object.keys(manifest), [
      "schemaVersion",
      "version",
      "releaseTag",
      "minRunnerVersion",
      "minGlibc",
      "targets",
      "provenance",
    ]);
    assert.deepEqual(Object.keys(manifest.targets[0]), [
      "platform",
      "arch",
      "url",
      "size",
      "sha256",
    ]);
    assert.deepEqual(manifest.provenance, {
      bundleUrl: `${defaultReleaseBase(version)}/${provenanceName}`,
    });
    assert.equal(manifest.minGlibc, "2.31");
    assert.deepEqual(
      manifest.targets.map(({ url }) => url),
      names.map((name) => `${defaultReleaseBase(version)}/${name}`),
    );

    // The manifest on disk is exactly the returned, normalized one.
    assert.deepEqual(JSON.parse(readFileSync(join(assets, manifestName), "utf8")), manifest);

    // The installer is the template with the version stamped in, executable.
    const installed = join(assets, installerName);
    assert.equal(
      readFileSync(installed, "utf8"),
      installerTemplate.replaceAll(installerVersionPlaceholder, version),
    );
    assert.equal(readFileSync(installed, "utf8").includes(installerVersionPlaceholder), false);
    assert.equal(statSync(installed).mode & 0o777, 0o755);

    // Checksums cover both tarballs, the installer and the manifest — and
    // nothing else, so the provenance bundle stays outside the cycle.
    assert.deepEqual(checksumLines(assets), [
      ...names.map((name) => ({ sha256: digestOf(join(assets, name)), name })),
      { sha256: digestOf(installed), name: installerName },
      { sha256: digestOf(join(assets, manifestName)), name: manifestName },
    ]);

    // Re-running over an existing asset set is byte-identical.
    const bytes = [
      readFileSync(join(assets, manifestName)),
      readFileSync(join(assets, checksumsName)),
      readFileSync(join(assets, installerName)),
    ];
    assert.deepEqual(await generateRunnerReleaseManifest(assets, { root }), manifest);
    assert.deepEqual(
      [
        readFileSync(join(assets, manifestName)),
        readFileSync(join(assets, checksumsName)),
        readFileSync(join(assets, installerName)),
      ],
      bytes,
    );
    assert.equal(statSync(join(assets, installerName)).mode & 0o777, 0o755);
  });
}

test("fails on root/desktop version drift before writing outputs", async (t) => {
  const { root, assets } = fixture(t);
  writeFileSync(join(root, "apps/desktop/package.json"), JSON.stringify({ version: "1.2.4" }));
  await assert.rejects(generateRunnerReleaseManifest(assets, { root }), /Version drift/);
  assertNoOutputs(assets);
});

for (const [index, [platform, arch]] of expectedTargets.entries()) {
  for (const part of ["tarball", "sidecar"]) {
    test(`rejects missing ${platform}-${arch} ${part}`, async (t) => {
      const { root, assets, names } = fixture(t);
      rmSync(join(assets, names[index] + (part === "sidecar" ? ".sha256" : "")));
      await assert.rejects(
        generateRunnerReleaseManifest(assets, { root }),
        /Missing release asset/,
      );
      assertNoOutputs(assets);
    });
  }
}

test("rejects tarball tampering and emits neither output", async (t) => {
  const { root, assets, names } = fixture(t);
  writeFileSync(join(assets, names[1]), "tampered");
  await assert.rejects(generateRunnerReleaseManifest(assets, { root }), /SHA256 mismatch/);
  assertNoOutputs(assets);
});

test("rejects checksum tampering", async (t) => {
  const { root, assets, names } = fixture(t);
  writeFileSync(join(assets, `${names[0]}.sha256`), `${"0".repeat(64)}  ${names[0]}\n`);
  await assert.rejects(generateRunnerReleaseManifest(assets, { root }), /SHA256 mismatch/);
  assertNoOutputs(assets);
});

for (const sidecar of [
  "not a checksum",
  `${"a".repeat(64)}  wrong-name.tar.gz\n`,
  `${"a".repeat(64)}  NAME\nextra\n`,
]) {
  test(`rejects malformed/renamed sidecar: ${sidecar.slice(0, 20)}`, async (t) => {
    const { root, assets, names } = fixture(t);
    writeFileSync(join(assets, `${names[0]}.sha256`), sidecar.replace("NAME", names[0]));
    await assert.rejects(
      generateRunnerReleaseManifest(assets, { root }),
      /Invalid checksum sidecar/,
    );
    assertNoOutputs(assets);
  });
}

for (const extra of [
  "volli-runner-1.2.3-win32-x64.tar.gz",
  "volli-runner-1.2.3-darwin-arm64.tar.gz",
  "volli-runner-1.2.3-linux-universal.tar.gz",
]) {
  test(`rejects an unlisted target: ${extra}`, async (t) => {
    const { root, assets } = fixture(t);
    writeFileSync(join(assets, extra), "unexpected");
    await assert.rejects(
      generateRunnerReleaseManifest(assets, { root }),
      /Unexpected release asset/,
    );
    assertNoOutputs(assets);
  });
}

test("rejects a tarball for another version", async (t) => {
  const { root, assets, names } = fixture(t);
  renameSync(join(assets, names[0]), join(assets, "volli-runner-9.9.9-linux-x64.tar.gz"));
  await assert.rejects(generateRunnerReleaseManifest(assets, { root }), /Unexpected release asset/);
  assertNoOutputs(assets);
});

test("a provenance bundle beside the assets is allowed and never checksummed", async (t) => {
  const { root, assets, names } = fixture(t);
  writeFileSync(join(assets, provenanceName), '{"bundle":"signed after this step"}\n');
  const manifest = await generateRunnerReleaseManifest(assets, { root });
  assert.deepEqual(manifest, expectedManifest({ version: "1.2.3", assets, names }));
  assert.equal(
    checksumLines(assets).some(({ name }) => name === provenanceName),
    false,
  );
  assert.equal(checksumLines(assets).length, names.length + 2);
});

test("--release-base points every URL at the given release", async (t) => {
  const { root, assets, names } = fixture(t);
  const releaseBase = "https://mirror.example/volli/releases/v1.2.3/";
  const manifest = await generateRunnerReleaseManifest(assets, { root, releaseBase });
  assert.deepEqual(
    manifest,
    expectedManifest({
      version: "1.2.3",
      assets,
      names,
      releaseBase: "https://mirror.example/volli/releases/v1.2.3",
    }),
  );
});

test("http is accepted only on loopback", async (t) => {
  for (const base of [
    "http://localhost:8080/volli/releases/v1.2.3",
    "http://127.0.0.1:8080/v1.2.3",
    "http://[::1]:8080/v1.2.3",
  ]) {
    const { root, assets, names } = fixture(t);
    // A trailing slash still joins into exactly one URL prefix.
    const manifest = await generateRunnerReleaseManifest(assets, {
      root,
      releaseBase: `${base}/`,
    });
    assert.deepEqual(
      manifest,
      expectedManifest({ version: "1.2.3", assets, names, releaseBase: base }),
    );
  }
});

for (const [base, reason] of [
  ["http://example.com/v1.2.3", /https/],
  ["ftp://example.com/v1.2.3", /https/],
  ["releases/v1.2.3", /absolute URL/],
  ["https://user:secret@example.com/v1.2.3", /credentials/],
  ["https://example.com/v1.2.3?token=1", /query or fragment/],
  ["https://example.com/v1.2.3#tag", /query or fragment/],
  [" https://example.com/v1.2.3", /Invalid release base/],
  ["", /Invalid release base/],
]) {
  test(`rejects an unsafe release base: ${JSON.stringify(base)}`, async (t) => {
    const { root, assets } = fixture(t);
    await assert.rejects(
      generateRunnerReleaseManifest(assets, { root, releaseBase: base }),
      reason,
    );
    assertNoOutputs(assets);
  });
}

test("minRunnerVersion defaults to the release version and can be lowered", async (t) => {
  {
    const { root, assets, names } = fixture(t);
    const manifest = await generateRunnerReleaseManifest(assets, { root });
    assert.equal(manifest.minRunnerVersion, "1.2.3");
    assert.deepEqual(manifest, expectedManifest({ version: "1.2.3", assets, names }));
  }
  {
    const { root, assets, names } = fixture(t, { version: "1.4.0" });
    const manifest = await generateRunnerReleaseManifest(assets, {
      root,
      minRunnerVersion: "1.3.0",
    });
    assert.equal(manifest.minRunnerVersion, "1.3.0");
    assert.deepEqual(
      manifest,
      expectedManifest({ version: "1.4.0", assets, names, minRunnerVersion: "1.3.0" }),
    );
  }
});

for (const minRunnerVersion of ["1.2.4", "2.0.0", "1.2.4-canary.1"]) {
  test(`rejects a minRunnerVersion above the release: ${minRunnerVersion}`, async (t) => {
    const { root, assets } = fixture(t);
    await assert.rejects(
      generateRunnerReleaseManifest(assets, { root, minRunnerVersion }),
      /newer than the release/,
    );
    assertNoOutputs(assets);
  });
}

for (const minRunnerVersion of ["1.2", "v1.2.3", "1.2.3-", "1.2.3..4", "01.2.3.4", "../1.2.3"]) {
  test(`rejects an unsafe minRunnerVersion floor: ${JSON.stringify(minRunnerVersion)}`, async (t) => {
    const { root, assets } = fixture(t);
    await assert.rejects(
      generateRunnerReleaseManifest(assets, { root, minRunnerVersion }),
      /Unsafe minRunnerVersion/,
    );
    assertNoOutputs(assets);
  });
}

test("a prerelease floor below its release is accepted", async (t) => {
  const { root, assets, names } = fixture(t, { version: "1.2.3" });
  const manifest = await generateRunnerReleaseManifest(assets, {
    root,
    minRunnerVersion: "1.2.3-canary.1",
  });
  assert.equal(manifest.minRunnerVersion, "1.2.3-canary.1");
  assert.deepEqual(
    manifest,
    expectedManifest({ version: "1.2.3", assets, names, minRunnerVersion: "1.2.3-canary.1" }),
  );
});

test("rejects an installer template without the version placeholder", async (t) => {
  const { root, assets } = fixture(t, { template: "#!/bin/sh\necho no placeholder\n" });
  await assert.rejects(
    generateRunnerReleaseManifest(assets, { root }),
    /has no @VOLLI_RUNNER_VERSION@/,
  );
  assertNoOutputs(assets);
});

test("rejects a missing installer template", async (t) => {
  const { root, assets } = fixture(t);
  rmSync(join(root, installerTemplatePath));
  await assert.rejects(
    generateRunnerReleaseManifest(assets, { root }),
    /Missing runner installer template/,
  );
  assertNoOutputs(assets);
});

test("rejects a missing assets folder", async (t) => {
  const { root } = fixture(t);
  await assert.rejects(
    generateRunnerReleaseManifest(join(root, "not-there"), { root }),
    /Missing runner assets folder/,
  );
});

// The validator is the updater's read path: a published file is normalized, and
// anything this build would misread is refused with the field named.
function publishedManifest(version = "1.2.3") {
  const base = defaultReleaseBase(version);
  return {
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    minRunnerVersion: version,
    minGlibc,
    targets: runnerTargets.map(({ platform, arch }) => ({
      platform,
      arch,
      url: `${base}/${runnerAssetName(version, { platform, arch })}`,
      size: 1024,
      sha256: "a".repeat(64),
    })),
    provenance: { bundleUrl: `${base}/${provenanceName}` },
  };
}

test("normalizes a published manifest into target order", () => {
  const manifest = publishedManifest();
  const reversed = { ...manifest, targets: manifest.targets.toReversed() };
  const normalized = validateRunnerReleaseManifest(reversed, "1.2.3");
  assert.deepEqual(normalized, manifest);
  assert.deepEqual(Object.keys(normalized), Object.keys(manifest));
  assert.deepEqual(
    normalized.targets.map(({ arch }) => arch),
    ["x64", "arm64"],
  );
  assert.deepEqual(validateRunnerReleaseManifest(manifest, "1.2.3"), manifest);
});

for (const [label, mutate, reason] of [
  ["wrong schemaVersion", (m) => (m.schemaVersion = 2), /schemaVersion must be 1/],
  ["wrong version", (m) => (m.version = "1.2.4"), /version 1.2.4 is not 1.2.3/],
  ["wrong releaseTag", (m) => (m.releaseTag = "v1.2.4"), /releaseTag/],
  ["unknown field", (m) => (m.extra = true), /Unexpected field in runner manifest: extra/],
  ["missing field", (m) => delete m.provenance, /Missing field in runner manifest: provenance/],
  ["glibc floor", (m) => (m.minGlibc = "2.28"), /minGlibc must be 2.31/],
  ["newer min floor", (m) => (m.minRunnerVersion = "2.0.0"), /newer than the release/],
  [
    "extra target",
    (m) => m.targets.push({ ...m.targets[0], arch: "x64" }),
    /exactly these targets/,
  ],
  ["missing target", (m) => m.targets.pop(), /exactly these targets/],
  ["duplicate arch", (m) => (m.targets[1] = { ...m.targets[0] }), /Duplicate runner target/],
  ["unknown target field", (m) => (m.targets[0].extra = 1), /Unexpected field in runner target/],
  ["foreign platform", (m) => (m.targets[0].platform = "darwin"), /platform must be linux/],
  ["unknown arch", (m) => (m.targets[0].arch = "ia32"), /Unexpected runner target arch/],
  [
    "relative url",
    (m) => (m.targets[1].url = runnerAssetName("1.2.3", runnerTargets[1])),
    /URL must end with/,
  ],
  [
    "wrong asset url",
    (m) => (m.targets[0].url = m.targets[0].url.replace("x64", "arm64")),
    /URL must end with/,
  ],
  ["zero size", (m) => (m.targets[0].size = 0), /Invalid runner target size/],
  ["fractional size", (m) => (m.targets[0].size = 1.5), /Invalid runner target size/],
  [
    "uppercase digest",
    (m) => (m.targets[0].sha256 = "A".repeat(64)),
    /Invalid runner target sha256/,
  ],
  ["short digest", (m) => (m.targets[0].sha256 = "abc"), /Invalid runner target sha256/],
  [
    "http download url",
    (m) => (m.targets[0].url = m.targets[0].url.replace("https:", "http:")),
    /https/,
  ],
  [
    "split releases",
    (m) =>
      (m.targets[1].url = m.targets[1].url.replace("releases/download/v1.2.3", "elsewhere/v1.2.3")),
    /points at/,
  ],
  [
    "wrong provenance url",
    (m) => (m.provenance.bundleUrl = "https://example.com/other.json"),
    /bundleUrl/,
  ],
  [
    "unknown provenance field",
    (m) => (m.provenance.extra = 1),
    /Unexpected field in runner manifest provenance/,
  ],
]) {
  test(`validator rejects ${label}`, () => {
    const manifest = publishedManifest();
    mutate(manifest);
    assert.throws(() => validateRunnerReleaseManifest(manifest, "1.2.3"), reason);
  });
}

test("validator pins the release base when one is given", () => {
  const manifest = publishedManifest();
  assert.deepEqual(
    validateRunnerReleaseManifest(manifest, "1.2.3", { releaseBase: defaultReleaseBase("1.2.3") }),
    manifest,
  );
  assert.throws(
    () =>
      validateRunnerReleaseManifest(manifest, "1.2.3", {
        releaseBase: "https://mirror.example/v1.2.3",
      }),
    /not the release base/,
  );
});

test("CLI requires --assets", () => {
  const script = join(repositoryRoot, "scripts/runner-release-manifest.mjs");
  const missingArg = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(missingArg.status, 1);
  assert.match(missingArg.stderr, /Usage:/);
});

test("CLI writes the asset set for the requested release", (t) => {
  const script = join(repositoryRoot, "scripts/runner-release-manifest.mjs");
  const version = releaseVersion();
  // The fixture's tarballs carry the repository's own version, because the CLI
  // reads the release version from package.json exactly as the workflow does.
  // Its installer comes from the tree's real template, not the fixture's.
  const { assets, names } = fixture(t, { version });
  const releaseBase = `http://localhost:8080/releases/v${version}`;
  const success = spawnSync(
    process.execPath,
    [script, "--assets", assets, "--release-base", releaseBase, "--min-runner-version", "0.2.0"],
    { encoding: "utf8" },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout.includes(`v${version}`), true);
  assert.deepEqual(
    JSON.parse(readFileSync(join(assets, manifestName), "utf8")),
    expectedManifest({ version, assets, names, releaseBase, minRunnerVersion: "0.2.0" }),
  );
  // The shipped installer is the tree's template stamped with the version.
  const template = readFileSync(join(repositoryRoot, installerTemplatePath), "utf8");
  assert.equal(
    readFileSync(join(assets, installerName), "utf8"),
    template.replaceAll(installerVersionPlaceholder, version),
  );
  assert.equal(statSync(join(assets, installerName)).mode & 0o777, 0o755);
  assert.equal(checksumLines(assets).length, names.length + 2);

  const unsafeBase = spawnSync(
    process.execPath,
    [script, "--assets", assets, "--release-base", "http://example.com/v1.2.3"],
    { encoding: "utf8" },
  );
  assert.equal(unsafeBase.status, 1);
  assert.match(unsafeBase.stderr, /Release base must be https/);
});
