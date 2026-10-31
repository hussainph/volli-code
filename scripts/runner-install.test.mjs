import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..");
const installer = join(workspace, "apps/runner/packaging/install.sh");
const { glibcVersions, exceedsFloor, probe } = createRequire(import.meta.url)(
  "../apps/runner/scripts/probe-glibc.cjs",
);
function run(command, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, cwd: workspace });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => {
      stdout += x;
    });
    child.stderr.on("data", (x) => {
      stderr += x;
    });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}
async function fixture(t) {
  mkdirSync(join(workspace, ".tmp"), { recursive: true });
  const root = mkdtempSync(join(workspace, ".tmp/runner-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, "tools");
  const staging = join(root, "staging");
  mkdirSync(tools);
  mkdirSync(staging);
  const tool = (name, content) =>
    writeFileSync(join(tools, name), `#!/bin/sh\n${content}\n`, { mode: 0o755 });
  tool(
    "uname",
    'case "$1" in -s) echo "${TEST_OS:-Linux}";; -m) echo "${TEST_ARCH:-x86_64}";; esac',
  );
  tool("getconf", 'echo "${TEST_LIBC:-glibc 2.31}"');
  tool("id", 'echo "${TEST_UID:-1000}"');
  tool(
    "df",
    'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nmock 9999999 1 ${TEST_FREE:-9999999} 1%% /\\n"',
  );
  const archives = {};
  for (const arch of ["x64", "arm64"]) {
    const name = `volli-runner-1.2.3-linux-${arch}`;
    const from = join(staging, name);
    mkdirSync(join(from, "bin"), { recursive: true });
    mkdirSync(join(from, "lib"));
    writeFileSync(
      join(from, "bin/node"),
      '#!/bin/sh\necho "probe:$1" >> "$PROBE_RECORD"\n[ "${TEST_PROBE_FAIL:-0}" = 0 ]\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(from, "bin/volli-runner"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$RECORD"\nprintf "%s" "$VOLLI_RUNNER_TOKEN" > "$TOKEN_RECORD"\nprintf "%s" "$VOLLI_SERVER" > "$SERVER_RECORD"\numask > "$UMASK_RECORD"\n',
      { mode: 0o755 },
    );
    for (const probeName of ["probe-natives.cjs", "probe-codemode.mjs"])
      writeFileSync(join(from, "lib", probeName), "");
    const tar = join(root, `${name}.tar.gz`);
    execFileSync("tar", ["-czf", tar, "-C", staging, name]);
    archives[arch] = readFileSync(tar);
  }
  let manifest;
  let corrupt = false;
  let redirect;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (redirect && !req.url.startsWith("/redirected/")) {
      const destination = `/redirected${req.url}`;
      const location = {
        absolute: `http://127.0.0.1:${server.address().port}${destination}`,
        root: destination,
        relative: destination.slice(1),
        insecure: "http://insecure.invalid/runner",
        loop: req.url,
      }[redirect];
      res.writeHead(302, { Location: location });
      res.end();
      return;
    }
    const path = req.url.replace(/^\/redirected/, "");
    if (path === "/volli-runner-manifest.json")
      res.end(typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    else if (path === "/x64.tar.gz" || path === "/arm64.tar.gz")
      res.end(corrupt ? Buffer.from("corrupted") : archives[path.slice(1, -7)]);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  manifest = {
    schemaVersion: 1,
    version: "1.2.3",
    releaseTag: "v1.2.3",
    minRunnerVersion: "1.2.3",
    minGlibc: "2.31",
    targets: Object.entries(archives).map(([arch, bytes]) => ({
      platform: "linux",
      arch,
      url: `${base}/${arch}.tar.gz`,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
    provenance: { bundleUrl: `${base}/volli-runner-provenance.sigstore.json` },
  };
  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    TMPDIR: root,
    HOME: root,
    RECORD: join(root, "record"),
    TOKEN_RECORD: join(root, "token"),
    SERVER_RECORD: join(root, "server"),
    UMASK_RECORD: join(root, "umask"),
    PROBE_RECORD: join(root, "probes"),
    VOLLI_RUNNER_TOKEN: "",
    VOLLI_SERVER: "",
  };
  return {
    root,
    tools,
    env,
    requests,
    redirect: (mode) => {
      redirect = mode;
    },
    tool,
    get manifest() {
      return manifest;
    },
    set manifest(value) {
      manifest = value;
    },
    corrupt: () => {
      corrupt = true;
    },
    run: (args = [], overrides = {}) =>
      run("sh", [installer, "--version", "1.2.3", "--release-base", base, ...args], {
        ...env,
        ...overrides,
      }),
    record: () => readFileSync(env.RECORD, "utf8").trim().split("\n"),
    installed: () => existsSync(env.RECORD),
  };
}

test("POSIX installer downloads a release over HTTP, verifies and probes before handoff", async (t) => {
  const f = await fixture(t);
  const result = await f.run([
    "--name",
    "box with spaces",
    "--server",
    "https://deployment.convex.site",
    "--token",
    "private-install-token",
    "--no-link",
    "--no-start",
    "--channel",
    "canary",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const args = f.record();
  assert.deepEqual(args.slice(0, 3), ["install", "--user", "--from"]);
  assert.ok(args[3].startsWith(f.root));
  assert.deepEqual(args.slice(4), [
    "--channel",
    "canary",
    "--name",
    "box with spaces",
    "--server",
    "https://deployment.convex.site",
    "--no-start",
    "--no-link",
  ]);
  assert.equal(readFileSync(f.env.TOKEN_RECORD, "utf8"), "private-install-token");
  assert.equal(readFileSync(f.env.SERVER_RECORD, "utf8"), "https://deployment.convex.site");
  assert.match(readFileSync(f.env.UMASK_RECORD, "utf8"), /^0*22\n$/);
  assert.equal(readFileSync(f.env.PROBE_RECORD, "utf8").trim().split("\n").length, 2);
  assert.doesNotMatch(result.stdout + result.stderr + args.join(" "), /private-install-token/);
  assert.match(result.stderr, /authenticity trusts TLS/);
  assert.deepEqual(f.requests, ["/volli-runner-manifest.json", "/x64.tar.gz"]);
});

function systemTool(name) {
  try {
    return execFileSync("sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

test("wget-only downloads follow safe 302 redirects and reject insecure/looping redirects", async (t) => {
  if (!systemTool("wget")) {
    assert.ok(!process.env.CI, "CI must have wget to verify the supported fallback");
    t.skip("wget is unavailable locally; CI and the distro matrix exercise this path");
    return;
  }
  for (const mode of ["absolute", "root", "relative", "insecure", "loop"]) {
    await t.test(mode, async (subtest) => {
      const f = await fixture(subtest);
      f.redirect(mode);
      for (const name of [
        "sh",
        "wget",
        "awk",
        "tar",
        "gzip",
        "mktemp",
        "wc",
        "sed",
        "rm",
        "dirname",
        "sha256sum",
        "shasum",
      ]) {
        const command = systemTool(name);
        if (command) symlinkSync(command, join(f.tools, name));
      }
      // No curl in PATH: this must execute the actual wget fallback, not curl.
      const result = await f.run([], { PATH: f.tools });
      if (["insecure", "loop"].includes(mode)) {
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(f.installed(), false);
        assert.match(result.stderr, mode === "insecure" ? /HTTPS/ : /manifest download failed/);
        assert.equal(f.requests.length, mode === "loop" ? 10 : 1);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(f.installed(), true);
        assert.deepEqual(f.requests, [
          "/volli-runner-manifest.json",
          "/redirected/volli-runner-manifest.json",
          "/x64.tar.gz",
          "/redirected/x64.tar.gz",
        ]);
      }
    });
  }
});

test("root defaults to system, arm64 and environment credentials are supported", async (t) => {
  const f = await fixture(t);
  const result = await f.run([], {
    TEST_UID: "0",
    TEST_ARCH: "aarch64",
    VOLLI_RUNNER_TOKEN: "env-token",
    VOLLI_SERVER: "https://override.test",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.record()[1], "--system");
  assert.equal(readFileSync(f.env.TOKEN_RECORD, "utf8"), "env-token");
  assert.match(f.requests[1], /arm64/);
});

test("musl, armv7, old glibc, low disk and unsafe install modes fail before extraction", async (t) => {
  const f = await fixture(t);
  for (const [args, env, reason] of [
    [[], { TEST_LIBC: "musl" }, /musl\/non-glibc/],
    [[], { TEST_ARCH: "armv7l" }, /unsupported architecture/],
    [[], { TEST_LIBC: "glibc 2.28" }, /glibc >= 2.31/],
    [[], { TEST_FREE: "100" }, /1 GiB/],
    [["--user"], { TEST_UID: "0" }, /cannot run as root/],
    [["--system"], { TEST_UID: "1000" }, /needs root/],
    [["--user", "--system"], {}, /choose only one/],
  ]) {
    const result = await f.run(args, env);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, reason);
    assert.equal(f.installed(), false);
    if (env.TEST_LIBC === "musl" || env.TEST_ARCH === "armv7l")
      assert.equal(result.stderr.trim().split("\n").length, 1);
  }
});

test("corruption, invalid manifest, missing target and failing probes never install", async (t) => {
  for (const problem of ["size", "checksum", "json", "duplicate", "target", "url", "probe"]) {
    await t.test(problem, async (subtest) => {
      const f = await fixture(subtest);
      if (problem === "size") f.corrupt();
      if (problem === "checksum") f.manifest.targets[0].sha256 = "0".repeat(64);
      if (problem === "json") f.manifest = '{"schemaVersion":1';
      if (problem === "duplicate")
        f.manifest = JSON.stringify(f.manifest).replace(
          '"version":',
          '"version":"9.9.9","version":',
        );
      if (problem === "target") f.manifest.targets[0].arch = "arm64";
      if (problem === "url") f.manifest.targets[0].url = "file:///tmp/runner.tar.gz";
      const result = await f.run([], problem === "probe" ? { TEST_PROBE_FAIL: "1" } : {});
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(f.installed(), false);
    });
  }
});

test("provenance verification is mandatory when requested and precedes probes", async (t) => {
  const f = await fixture(t);
  f.tool("gh", 'printf "%s\\n" "$@" > "$GH_RECORD"; exit "${TEST_GH_STATUS:-0}"');
  const env = { GH_RECORD: join(f.root, "gh-record") };
  let result = await f.run(["--verify-provenance"], { ...env, TEST_GH_STATUS: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /provenance verification failed/);
  assert.equal(existsSync(f.env.PROBE_RECORD), false);
  result = await f.run(["--verify-provenance"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(env.GH_RECORD, "utf8"),
    /attestation\nverify\n[\s\S]*--repo\nhussainph\/volli-code/,
  );
});

test("help, unknown flags and missing values are safe; partial script cannot invoke main", async (t) => {
  const f = await fixture(t);
  for (const flag of [
    "--token",
    "--name",
    "--server",
    "--version",
    "--channel",
    "--release-base",
  ]) {
    const result = await f.run([flag]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs a value/);
  }
  assert.equal((await f.run(["--help"])).status, 0);
  assert.equal((await f.run(["--wat"])).status, 1);
  const source = readFileSync(installer, "utf8");
  assert.ok(source.endsWith('main "$@"\n'));
  const truncated = join(f.root, "truncated.sh");
  writeFileSync(truncated, source.slice(0, source.lastIndexOf('main "$@"')));
  assert.equal((await run("sh", [truncated], f.env)).status, 0);
  assert.equal(f.requests.length, 0);
});

test("ELF ABI parser considers needs, not definitions, and enforces the exact floor", () => {
  const output = `Version definition section: Name: GLIBC_2.99\nVersion needs section: Name: GLIBC_2.28\nName: GLIBC_2.31\nName: GLIBC_2.32`;
  assert.deepEqual(glibcVersions(output).map(exceedsFloor), [false, false, true]);
  assert.equal(exceedsFloor(["2", "31", "1"]), true);
  assert.equal(exceedsFloor(["3", "0"]), true);
  assert.equal(exceedsFloor(["2", "9"]), false);
});

test("ABI gate walks every ELF and rejects a build requiring newer glibc", async (t) => {
  const f = await fixture(t);
  const elfRoot = join(f.root, "elf");
  mkdirSync(elfRoot);
  writeFileSync(join(elfRoot, "native.so"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  f.tool("readelf", 'echo "Version needs section: Name: GLIBC_${TEST_REQUIRED_GLIBC:-2.31}"');
  const oldPath = process.env.PATH;
  process.env.PATH = f.env.PATH;
  t.after(() => {
    process.env.PATH = oldPath;
    delete process.env.TEST_REQUIRED_GLIBC;
  });
  assert.doesNotThrow(() => probe(elfRoot));
  process.env.TEST_REQUIRED_GLIBC = "2.32";
  assert.throws(() => probe(elfRoot), /needs GLIBC_2.32/);
});
