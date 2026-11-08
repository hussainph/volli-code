import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { copyVerifiedArchive, publishArchive, restoreArchive } from "./worker-node-archive.mjs";

const root = resolve(import.meta.dirname, "..");
const pinned = "13c8f1384f72ada969d164b8de7ebacd55f3fb18a97ea86abd9b7ebdb6c77c26";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function temporary(t) {
  fs.mkdirSync(join(root, ".tmp"), { recursive: true });
  const directory = fs.mkdtempSync(join(root, ".tmp/worker-archive-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function tar(name, body) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000700\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(
    Buffer.concat([header, body, Buffer.alloc(((512 - (body.length % 512)) % 512) + 1024)]),
  );
}
function fixture(
  t,
  { member = "bin/node", mismatch = false, downloadFails = false, corruptDownload = false } = {},
) {
  const directory = temporary(t);
  for (const path of ["scripts", "bin", ".tmp"]) fs.mkdirSync(join(directory, path));
  const executable = (name, body) =>
    fs.writeFileSync(join(directory, "bin", name), body, { mode: 0o700 });
  const wrapper = `#!/bin/sh\nexec '${process.execPath}' "$@"\n`;
  executable("node", wrapper);
  executable("uname", '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n');
  executable(
    "curl",
    `#!/bin/sh\necho call >> '${directory}/downloads'\nfor last; do :; done\n${corruptDownload ? 'printf partial > "$last"' : `cp '${directory}/fixture.tar.gz' "$last"`}\nexit ${downloadFails ? 1 : 0}\n`,
  );
  executable("readelf", "#!/bin/sh\necho 'Build ID: abc123'\n");
  executable(
    "addr2line",
    "#!/bin/sh\ni=0; while [ $i -lt 8 ]; do echo function; echo source; i=$((i+1)); done\n",
  );
  executable("nm", "#!/bin/sh\nexit 1\n");
  const archive = tar(member, Buffer.from(mismatch ? "not this job's Node" : wrapper));
  const expected = digest(archive);
  fs.writeFileSync(join(directory, "fixture.tar.gz"), archive);
  const source = fs
    .readFileSync(join(root, "scripts/symbolize-worker-stack.sh"), "utf8")
    .replaceAll(pinned, expected);
  fs.writeFileSync(join(directory, "scripts/symbolize-worker-stack.sh"), source);
  fs.copyFileSync(
    join(root, "scripts/worker-node-archive.mjs"),
    join(directory, "scripts/worker-node-archive.mjs"),
  );
  const cache = join(directory, ".tmp/cache", `${expected}.tar.gz`);
  const run = () =>
    spawnSync("bash", ["scripts/symbolize-worker-stack.sh", ".tmp/diagnostics"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${directory}/bin:${process.env.PATH}`,
        VOLLI_WORKER_NODE_ARCHIVE: cache,
        TMPDIR: join(directory, ".tmp"),
      },
    });
  return { directory, cache, archive, run };
}

test("true miss downloads once, publishes exact bytes; verified hit avoids downloader", (t) => {
  const f = fixture(t);
  let result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readFileSync(f.cache), f.archive);
  result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /archive_cache=verified_hit/);
  assert.equal(fs.readFileSync(join(f.directory, "downloads"), "utf8"), "call\n");
});

for (const kind of ["checksum", "oversize", "directory", "symlink", "fifo"]) {
  test(`untrusted ${kind} cache stays hard red without downloader`, (t) => {
    const f = fixture(t);
    fs.mkdirSync(resolve(f.cache, ".."), { recursive: true });
    if (kind === "checksum") fs.writeFileSync(f.cache, "corrupt");
    if (kind === "oversize") {
      fs.writeFileSync(f.cache, "");
      fs.truncateSync(f.cache, 134217729);
    }
    if (kind === "directory") fs.mkdirSync(f.cache);
    if (kind === "symlink") fs.symlinkSync(join(f.directory, "absent"), f.cache);
    if (kind === "fifo") assert.equal(spawnSync("mkfifo", [f.cache]).status, 0);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /diagnostic_failure=archive_(checksum_mismatch|download_failed)/);
    assert.equal(fs.existsSync(join(f.directory, "downloads")), false);
  });
}

for (const options of [
  { downloadFails: true },
  { corruptDownload: true },
  { member: "../bin/node" },
  { mismatch: true },
]) {
  test(`failed download/member/identity does not publish: ${JSON.stringify(options)}`, (t) => {
    const f = fixture(t, options);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(fs.existsSync(f.cache), false);
    assert.equal(fs.readFileSync(join(f.directory, "downloads"), "utf8"), "call\n");
    assert.match(result.stdout, /diagnostic_status=failed/);
    if (options.mismatch)
      assert.match(result.stdout, /diagnostic_failure=job_binary_identity_mismatch/);
  });
}

test("descriptor copy rejects replacement and in-place mutation races", (t) => {
  const directory = temporary(t);
  const originalRead = fs.readSync;
  for (const mutation of ["replace", "mutate"]) {
    const source = join(directory, mutation);
    const bytes = Buffer.alloc(150000, 65);
    fs.writeFileSync(source, bytes);
    let changed = false;
    const mock = t.mock.method(fs, "readSync", (...args) => {
      const count = originalRead(...args);
      if (!changed) {
        changed = true;
        if (mutation === "replace") {
          fs.renameSync(source, `${source}.old`);
          fs.writeFileSync(source, bytes);
        } else fs.writeFileSync(source, Buffer.alloc(bytes.length, 66));
      }
      return count;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => copyVerifiedArchive(source, `${source}.copy`, digest(bytes)),
        /archive_download_failed/,
      );
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("publication is atomic, immutable and checksum-verified", (t) => {
  const directory = temporary(t);
  const source = join(directory, "source");
  const cache = join(directory, "cache/archive");
  fs.writeFileSync(source, "bytes");
  assert.throws(() => publishArchive(source, cache, digest("wrong")), /archive_checksum_mismatch/);
  assert.deepEqual(fs.readdirSync(join(directory, "cache")), []);
  publishArchive(source, cache, digest("bytes"));
  assert.throws(() => publishArchive(source, cache, digest("bytes")), /EEXIST/);
  assert.equal(fs.readFileSync(cache, "utf8"), "bytes");
  assert.equal(
    restoreArchive(join(directory, "absent"), join(directory, "unused"), digest("bytes")),
    false,
  );
});

test("cache parent replacement cannot publish unverified staging bytes", (t) => {
  const directory = temporary(t);
  const work = join(directory, "owned-work");
  const parent = join(directory, "untrusted-cache");
  fs.mkdirSync(work, { mode: 0o700 });
  fs.mkdirSync(parent);
  const source = join(work, "node.tar.gz");
  const cache = join(parent, "archive.tar.gz");
  const original = Buffer.from("verified original archive bytes");
  const poison = Buffer.from("unverified replacement archive bytes");
  fs.writeFileSync(source, original);
  const originalLink = fs.linkSync;
  let replaced = false;
  const mock = t.mock.method(fs, "linkSync", (from, to) => {
    // Deterministically replace the cache parent after verification closed
    // its descriptors, but before the atomic publication resolves paths.
    replaced = true;
    const moved = `${parent}.moved`;
    fs.renameSync(parent, moved);
    fs.mkdirSync(parent);
    // Poison any staging paths that the old implementation placed under
    // that parent. Do not touch the protected work directory or validation.
    for (const entry of fs.readdirSync(moved, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const replacement = join(parent, entry.name);
        fs.mkdirSync(replacement);
        fs.writeFileSync(join(replacement, "archive"), poison);
      }
    }
    return originalLink(from, to);
  });
  syncBuiltinESMExports();
  let failure;
  try {
    publishArchive(source, cache, digest(original));
  } catch (error) {
    failure = error;
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(replaced, true);
  if (fs.existsSync(cache)) assert.deepEqual(fs.readFileSync(cache), original);
  else assert.ok(failure, "publication must either fail or publish the verified original");
  assert.deepEqual(fs.readdirSync(work), ["node.tar.gz"]);
});

test("publication rejects symlink and non-directory cache parents", (t) => {
  const directory = temporary(t);
  const source = join(directory, "source");
  fs.writeFileSync(source, "bytes");
  fs.mkdirSync(join(directory, "target"));
  fs.symlinkSync(join(directory, "target"), join(directory, "symlink"));
  fs.writeFileSync(join(directory, "file"), "not a directory");
  for (const parent of ["symlink", "file"]) {
    assert.throws(() =>
      publishArchive(source, join(directory, parent, "archive"), digest("bytes")),
    );
  }
  assert.deepEqual(fs.readdirSync(join(directory, "target")), []);
});

test("ordinary CI uses a narrow checksum-keyed cache without weakening diagnostic failure", () => {
  const workflow = fs.readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const section = workflow.slice(
    workflow.indexOf("      # Immutable optimization only:"),
    workflow.indexOf("      # A diagnostic failure stays red"),
  );
  assert.match(section, /actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/);
  assert.match(section, /actions\/cache\/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9/);
  assert.match(section, /steps.worker_symbols.outcome == 'success'/);
  assert.ok(section.includes(`key: worker-node-archive-linux-x64-${pinned}`));
  assert.doesNotMatch(section, /restore-keys:|continue-on-error:/);
  assert.ok(
    workflow.includes(
      "${{ !cancelled() && (success() || steps.worker_symbols.outcome == 'failure') }}",
    ),
  );
});
