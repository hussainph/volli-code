import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";

const script = fileURLToPath(new URL("./release-publication.mjs", import.meta.url));
const workflow = parse(
  readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
);

// Execute the production CLI with a filesystem-backed GitHub double. Every
// command outside this small protocol fails closed; no real gh or network is
// reachable. Uploads/downloads copy actual bytes, not canned verification flags.
const mockGh = `#!${process.execPath}
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.RELEASE_STATE, 'utf8'));
const save = () => writeFileSync(process.env.RELEASE_STATE, JSON.stringify(state));
const fail = (message) => { save(); console.error(message); process.exit(1); };
const event = (message) => { state.events.push(message); save(); };
const assertDraft = () => { if (!state.release?.draft) fail('attempt to mutate a live release'); };
if (args[0] === 'api' && args[1] === '--paginate' && args[3] === '--jq') {
  event('lookup');
  if (process.env.RELEASE_FAULT === 'lookup') fail('API unavailable');
  if (!args[4].includes(JSON.stringify(process.env.REF_NAME))) fail('lookup must filter exact tag');
  if (state.release) console.log(JSON.stringify(state.release));
} else if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
  const body = JSON.parse(readFileSync(0, 'utf8'));
  if (body.draft !== true || state.release) fail('unsafe/duplicate create');
  state.release = { ...body, assets: [], body: 'owner release notes' };
  event('create-draft');
} else if (args[0] === 'release' && args[1] === 'delete-asset') {
  assertDraft();
  state.release.assets = state.release.assets.filter(asset => asset.name !== args[3]);
  event('delete:' + args[3]);
} else if (args[0] === 'release' && args[1] === 'upload') {
  assertDraft();
  for (const path of args.slice(3, args.indexOf('--repo'))) {
    const name = basename(path);
    copyFileSync(path, join(process.env.RELEASE_REMOTE, name));
    state.release.assets = state.release.assets.filter(asset => asset.name !== name);
    state.release.assets.push({ name });
    event('upload:' + name);
    if (process.env.RELEASE_FAULT === 'upload') fail('upload interrupted');
  }
} else if (args[0] === 'release' && args[1] === 'download') {
  const target = args[args.indexOf('--dir') + 1];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--pattern') continue;
    const name = args[++i];
    event('download:' + name);
    if (process.env.RELEASE_FAULT === 'missing:' + name) fail('missing remote asset');
    copyFileSync(join(process.env.RELEASE_REMOTE, name), join(target, name));
    if (process.env.RELEASE_FAULT === 'corrupt:' + name) writeFileSync(join(target, name), 'corrupt remote bytes');
  }
} else if (args[0] === 'release' && args[1] === 'edit') {
  assertDraft();
  if (!state.release.prerelease || !args.includes('--draft=false') || !args.includes('--prerelease')) fail('unsafe publish');
  if (process.env.RELEASE_FAULT === 'publish') fail('publish refused');
  state.release.draft = false;
  event('publish');
} else {
  fail('unexpected gh command: ' + args.join(' '));
}
`;

const mockPublicFeed = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://github.com/owner/repo/releases/download/' + process.env.REF_NAME + '/latest-mac.yml');
  assert.equal(options.headers, undefined, 'updater feed must be checked unauthenticated');
  const state = JSON.parse(readFileSync(process.env.RELEASE_STATE, 'utf8'));
  assert.equal(state.release.draft, false, 'public fetch cannot precede publication');
  state.events.push('public-feed');
  writeFileSync(process.env.RELEASE_STATE, JSON.stringify(state));
  if (process.env.RELEASE_FAULT === 'public-404') return { ok: false, status: 404 };
  const data = process.env.RELEASE_FAULT === 'public-corrupt' ? Buffer.from('wrong public feed') :
    readFileSync(process.env.RELEASE_REMOTE + '/latest-mac.yml');
  return { ok: true, arrayBuffer: async () => data };
};
`;

function fixture(t, { stable = false, existing = false } = {}) {
  const scratch = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "release-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = join(root, "assets");
  const remote = join(root, "remote");
  const bin = join(root, "bin");
  for (const directory of [assets, remote, bin]) mkdirSync(directory);
  writeFileSync(join(bin, "gh"), mockGh, { mode: 0o755 });
  const preload = join(root, "mock-public-feed.mjs");
  writeFileSync(preload, mockPublicFeed);
  const version = stable ? "1.2.3" : "1.2.3-canary.2";
  const tag = `v${version}`;
  const dmg = `Volli-Code-${version}-arm64.dmg`;
  const zip = `Volli-Code-${version}-arm64-mac.zip`;
  const files = [dmg, `${dmg}.blockmap`, zip, `${zip}.blockmap`, "latest-mac.yml"];
  for (const product of ["hostd", "runner"]) {
    for (const platform of product === "hostd" ? ["linux", "darwin"] : ["linux"]) {
      for (const arch of ["x64", "arm64"]) {
        const tar = `volli-${product}-${version}-${platform}-${arch}.tar.gz`;
        files.push(tar, `${tar}.sha256`);
      }
    }
  }
  files.push(
    "SHA256SUMS",
    "hostd-release-manifest.json",
    "hostd-provenance.sigstore.json",
    "volli-runner-SHA256SUMS",
    "volli-runner-manifest.json",
    "volli-runner-install.sh",
    "volli-runner-provenance.sigstore.json",
  );
  for (const file of files) writeFileSync(join(assets, file), `completed artifact: ${file}`);
  const entry = (name) => {
    const data = readFileSync(join(assets, name));
    return {
      url: name,
      sha512: createHash("sha512").update(data).digest("base64"),
      size: data.length,
    };
  };
  const zipEntry = entry(zip);
  writeFileSync(
    join(assets, "latest-mac.yml"),
    stringify({
      version,
      files: [zipEntry, entry(dmg)],
      path: zip,
      sha512: zipEntry.sha512,
    }),
  );
  const statePath = join(root, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      release: existing
        ? {
            tag_name: tag,
            draft: true,
            prerelease: !stable,
            body: "owner release notes",
            assets: [{ name: "stale.zip" }, { name: "canary-peer.json" }],
          }
        : null,
      events: [],
    }),
  );
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const run = (command, fault = "") =>
    spawnSync(
      process.execPath,
      ["--import", preload, script, command, ...(command === "upload" ? [assets, ...files] : [])],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 25_000,
        env: {
          ...process.env,
          PATH: `${bin}:${dirname(process.execPath)}`,
          GH_TOKEN: "",
          NODE_OPTIONS: "",
          REF_NAME: tag,
          GITHUB_REPOSITORY: "owner/repo",
          RELEASE_STATE: statePath,
          RELEASE_REMOTE: remote,
          RELEASE_FAULT: fault,
        },
      },
    );
  return { assets, files, statePath, state, run, dmg, zip };
}

function succeeded(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("workflow wires draft preparation and the verified upload after local gates", () => {
  const steps = workflow.jobs.release.steps;
  const prepare = steps.findIndex((step) => step.name === "Pre-create GitHub release");
  const pack = steps.findIndex((step) => step.name === "Package, sign, notarize, staple");
  const gate = steps.findIndex((step) => step.name === "Gate: artifacts complete and notarized");
  const upload = steps.findIndex((step) => step.name === "Publish artifacts to the release");
  assert.ok(prepare < pack && pack < gate && gate < upload);
  assert.equal(steps[prepare].run, "node scripts/release-publication.mjs prepare");
  assert.match(
    steps[upload].run,
    /node \.\.\/\.\.\/\.\.\/scripts\/release-publication\.mjs upload \. "\$\{files\[@\]\}"/,
  );
  for (const step of [steps[prepare], steps[upload]]) {
    assert.equal(step.if, undefined);
    assert.notEqual(step["continue-on-error"], true);
  }
});

test("canary uploads every asset and verifies remote bytes before publishing and checking the public feed", (t) => {
  const f = fixture(t);
  succeeded(f.run("prepare"));
  assert.equal(f.state().release.draft, true);
  assert.equal(f.state().release.prerelease, true);
  // A build/sign/staple failure here cannot expose a partial release.
  assert.deepEqual(f.state().events, ["lookup", "create-draft"]);
  succeeded(f.run("upload"));
  const { release, events } = f.state();
  assert.equal(release.draft, false);
  assert.equal(release.body, "owner release notes");
  assert.deepEqual(
    release.assets.map((asset) => asset.name),
    f.files,
  );
  const published = events.indexOf("publish");
  for (const name of f.files) {
    assert.ok(events.indexOf(`upload:${name}`) < events.indexOf(`download:${name}`));
    assert.ok(events.indexOf(`download:${name}`) < published);
  }
  assert.equal(events.at(-1), "public-feed");
  const before = events.length;
  succeeded(f.run("prepare"));
  succeeded(f.run("upload"));
  assert.equal(f.state().release.draft, false);
  assert.ok(
    f
      .state()
      .events.slice(before)
      .every((event) => !/^(create|upload|delete|publish)/.test(event)),
  );
});

test("stable releases remain manual drafts after full remote verification", (t) => {
  const f = fixture(t, { stable: true });
  succeeded(f.run("prepare"));
  succeeded(f.run("upload"));
  assert.equal(f.state().release.draft, true);
  assert.equal(f.state().release.prerelease, false);
  assert.equal(f.state().events.includes("publish"), false);
  assert.equal(f.state().events.includes("public-feed"), false);
  assert.ok(f.files.every((file) => f.state().events.includes(`download:${file}`)));
});

test("draft reruns reuse the release, preserve notes and peer capture, and retire stale assets", (t) => {
  const f = fixture(t, { existing: true });
  succeeded(f.run("prepare"));
  succeeded(f.run("prepare"));
  assert.notEqual(f.run("upload", "upload").status, 0);
  assert.equal(f.state().release.draft, true);
  succeeded(f.run("upload"));
  const { release, events } = f.state();
  assert.equal(release.body, "owner release notes");
  assert.ok(release.assets.some((asset) => asset.name === "canary-peer.json"));
  assert.ok(events.includes("delete:stale.zip"));
  assert.equal(events.includes("delete:canary-peer.json"), false);
  assert.equal(events.includes("create-draft"), false);
});

test("upload, missing/corrupt download and publish failures never publish a draft", (t) => {
  for (const fault of ["upload", "missing:latest-mac.yml", "corrupt:latest-mac.yml", "publish"]) {
    const f = fixture(t);
    succeeded(f.run("prepare"));
    const result = f.run("upload", fault);
    assert.notEqual(result.status, 0, fault);
    assert.equal(f.state().release.draft, true, fault);
    assert.equal(f.state().events.includes("publish"), false, fault);
    assert.equal(f.state().events.includes("public-feed"), false, fault);
  }
  // Not just presence/headers: changed bytes in either desktop artifact or a
  // provenance bundle must also fail before the publication transition.
  const f = fixture(t);
  succeeded(f.run("prepare"));
  for (const name of [
    f.dmg,
    f.zip,
    "hostd-provenance.sigstore.json",
    "volli-runner-provenance.sigstore.json",
  ]) {
    assert.notEqual(f.run("upload", `corrupt:${name}`).status, 0);
    assert.equal(f.state().release.draft, true);
  }
});

test("a malformed or stale feed fails before any asset mutation", (t) => {
  const f = fixture(t, { existing: true });
  const path = join(f.assets, "latest-mac.yml");
  const original = parse(readFileSync(path, "utf8"));
  for (const change of [
    (feed) => {
      feed.version = "0.0.0";
    },
    (feed) => {
      feed.files[0].sha512 = "pre-staple hash";
    },
    (feed) => {
      feed.files[1].size++;
    },
    (feed) => {
      feed.files[1].url = "missing.dmg";
    },
    (feed) => {
      feed.path = "other.zip";
    },
    (feed) => {
      feed.sha512 = "wrong legacy hash";
    },
  ]) {
    const feed = structuredClone(original);
    change(feed);
    writeFileSync(path, stringify(feed));
    assert.notEqual(f.run("upload").status, 0);
    assert.equal(f.state().release.draft, true);
    assert.deepEqual(f.state().events, []);
  }
});

test("published-tag reruns never replace differing live assets or change their channel", (t) => {
  const f = fixture(t);
  succeeded(f.run("prepare"));
  succeeded(f.run("upload"));
  const before = f.state().events.length;
  writeFileSync(join(f.assets, "hostd-provenance.sigstore.json"), "rebuilt differently");
  assert.notEqual(f.run("upload").status, 0);
  assert.equal(f.state().release.draft, false);
  assert.ok(
    f
      .state()
      .events.slice(before)
      .every((event) => !/^(upload|delete|publish)/.test(event)),
  );
  const state = f.state();
  state.release.prerelease = false;
  writeFileSync(f.statePath, JSON.stringify(state));
  assert.notEqual(f.run("prepare").status, 0);
  assert.notEqual(f.run("upload").status, 0);
});

test("unreadable or differing public feeds fail the job after bounded checks of the complete release", (t) => {
  for (const fault of ["public-404", "public-corrupt"]) {
    const f = fixture(t);
    succeeded(f.run("prepare"));
    const result = f.run("upload", fault);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Published release has an unreadable updater feed/);
    assert.equal(f.state().release.draft, false);
    assert.equal(f.state().release.assets.length, f.files.length);
    assert.equal(f.state().events.filter((event) => event === "public-feed").length, 5);
    assert.equal(f.state().events.filter((event) => event === "publish").length, 1);
  }
});

test("a lookup outage never falls through to release creation", (t) => {
  const f = fixture(t);
  assert.notEqual(f.run("prepare", "lookup").status, 0);
  assert.equal(f.state().release, null);
  assert.deepEqual(f.state().events, ["lookup"]);
});
