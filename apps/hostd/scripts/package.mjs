#!/usr/bin/env node
/**
 * Assembles the hostd artifact for the platform this runs on (README.md,
 * "Packaging"). CI runs it inside the digest-pinned Linux host image
 * (.devcontainer/host/Dockerfile) after a host-only install, so the Node it
 * copies and the natives it builds are that image's: Node = .nvmrc, glibc =
 * Debian bookworm's. release.yml's hostd-darwin job runs it natively on a
 * macOS runner of each architecture, under the nodejs.org Node = .nvmrc.
 *
 *   node apps/hostd/scripts/package.mjs --out <dir>
 *
 * Writes <dir>/volli-hostd-<version>-<platform>-<arch>.tar.gz and its .sha256.
 * The archive holds one directory of that name:
 *
 *   bin/node            this Node, copied (checked against .nvmrc)
 *   bin/volli-hostd     sh launcher for lib/hostd/hostd.cjs
 *   bin/volli           sh launcher for the volli CLI (lib/volli.cjs)
 *   lib/hostd/          hostd.cjs and its chunks: hostd, every @volli package
 *                       and the pure-JS dependencies, bundled
 *   lib/volli.cjs       the volli CLI bundle
 *   lib/probe-natives.cjs  loads and exercises every native module
 *   lib/node_modules/   `pnpm deploy --prod` of @volli/hostd: the externals only
 *   share/systemd/volli-hostd.{service,socket}, share/launchd/com.volli.hostd.plist
 *   MANIFEST.json, README.md, LICENSE
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const ROOT = resolve(APP, "../..");

/** The natives hostd ships, and the platform package each one loads its binary from. */
const NATIVES = {
  "better-sqlite3": "better-sqlite3 (bundled N-API prebuild)",
  "node-pty": "node-pty (compiled from source at deploy, N-API)",
  sharp: "sharp with @img/sharp-<platform> and @img/sharp-libvips-<platform>",
  "@vscode/ripgrep": "@vscode/ripgrep with @vscode/ripgrep-<platform>",
};

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (values.out === undefined) {
  process.stderr.write("usage: node apps/hostd/scripts/package.mjs --out <dir>\n");
  process.exit(2);
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });

const nvmrc = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
if (process.versions.node !== nvmrc) {
  throw new Error(`Node ${process.versions.node} is not the pinned ${nvmrc} (.nvmrc).`);
}
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const target = `${process.platform}-${process.arch}`;
const name = `volli-hostd-${version}-${target}`;
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
// Staged on local disk and archived from there: only the archive reaches
// --out, which in CI and in Docker Desktop is a bind mount that may not keep
// file modes.
const staging = mkdtempSync(join(tmpdir(), "hostd-stage-"));
const stage = join(staging, name);
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(join(stage, "lib"), { recursive: true });

// 1. The two bundles.
run("pnpm", ["--filter", "@volli/hostd", "--filter", "@volli/cli", "run", "build"]);
// hostd's bundle is an entry plus the chunks its lazy imports split off.
cpSync(join(APP, "dist"), join(stage, "lib", "hostd"), { recursive: true });
copyFileSync(join(ROOT, "packages", "cli", "dist", "volli.cjs"), join(stage, "lib", "volli.cjs"));
copyFileSync(join(HERE, "probe-natives.cjs"), join(stage, "lib", "probe-natives.cjs"));
copyFileSync(join(HERE, "probe-codemode.mjs"), join(stage, "lib", "probe-codemode.mjs"));

// 2. The externals, from the lockfile, flat so lib/hostd/hostd.cjs resolves them.
// Install scripts run: node-pty has no Linux prebuild and compiles here.
const deployed = mkdtempSync(join(tmpdir(), "hostd-deploy-"));
try {
  run("pnpm", [
    "--filter",
    "@volli/hostd",
    "deploy",
    "--prod",
    "--frozen-lockfile",
    "--config.inject-workspace-packages=true",
    "--config.node-linker=hoisted",
    deployed,
  ]);
  cpSync(join(deployed, "node_modules"), join(stage, "lib", "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
} finally {
  rmSync(deployed, { recursive: true, force: true });
}
for (const native of Object.keys(NATIVES)) {
  if (!existsSync(join(stage, "lib", "node_modules", native, "package.json"))) {
    throw new Error(`The deploy did not install ${native}.`);
  }
}
// Other platforms' prebuilds (about 70 MB of macOS and Windows binaries). The
// probe in step 5 proves nothing this platform loads was removed.
for (const native of ["better-sqlite3", "node-pty"]) {
  const prebuilds = join(stage, "lib", "node_modules", native, "prebuilds");
  if (!existsSync(prebuilds)) continue;
  for (const entry of readdirSync(prebuilds)) {
    const [platform, arch] = entry.replace(/\.node$/, "").split("-");
    const ours = platform.startsWith(process.platform) && arch === process.arch;
    if (!ours) rmSync(join(prebuilds, entry), { recursive: true, force: true });
  }
}

// Code Mode executes in a worker with an ES-module loader. Ship its published
// files and QuickJS together; the host half stays bundled, but neither this
// worker nor its bare quickjs-wasi import can be an in-bundle chunk.
const runtimePackage = join(ROOT, "packages", "agent-runtime");
const sandboxRoot = realpathSync(
  join(runtimePackage, "node_modules", "@earendil-works", "pi-codemode"),
);
const quickjsRoot = dirname(
  createRequire(join(sandboxRoot, "package.json")).resolve("quickjs-wasi/quickjs.wasm"),
);
cpSync(sandboxRoot, join(stage, "lib", "node_modules", "@earendil-works", "pi-codemode"), {
  recursive: true,
});
cpSync(quickjsRoot, join(stage, "lib", "node_modules", "quickjs-wasi"), { recursive: true });

// 3. Node itself, and the launchers. `readlink -f` is in macOS's own
// readlink from 12.3, and this Node already needs 13.5 or later.
copyFileSync(process.execPath, join(stage, "bin", "node"));
chmodSync(join(stage, "bin", "node"), 0o755);
const launcher = (bundle) => `#!/bin/sh
# Generated by apps/hostd/scripts/package.mjs.
here=$(dirname "$(readlink -f "$0")")
exec "$here/node" "$here/../lib/${bundle}" "$@"
`;
writeFileSync(join(stage, "bin", "volli-hostd"), launcher("hostd/hostd.cjs"), { mode: 0o755 });
writeFileSync(join(stage, "bin", "volli"), launcher("volli.cjs"), { mode: 0o755 });

// 4. Service templates and documents.
mkdirSync(join(stage, "share", "systemd"), { recursive: true });
mkdirSync(join(stage, "share", "launchd"), { recursive: true });
for (const unit of ["volli-hostd.service", "volli-hostd.socket"]) {
  copyFileSync(join(APP, "packaging", unit), join(stage, "share", "systemd", unit));
}
copyFileSync(
  join(APP, "packaging", "com.volli.hostd.plist"),
  join(stage, "share", "launchd", "com.volli.hostd.plist"),
);
// The agent browser's sandbox on Ubuntu 23.10+ (VC-619), and its probe.
mkdirSync(join(stage, "share", "apparmor"), { recursive: true });
copyFileSync(
  join(APP, "packaging", "volli-chromium.apparmor"),
  join(stage, "share", "apparmor", "volli-chromium"),
);
copyFileSync(
  join(APP, "scripts", "probe-chromium-sandbox.sh"),
  join(stage, "share", "probe-chromium-sandbox.sh"),
);
chmodSync(join(stage, "share", "probe-chromium-sandbox.sh"), 0o755);
copyFileSync(join(APP, "README.md"), join(stage, "README.md"));
copyFileSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));

const installed = (pkg) =>
  JSON.parse(readFileSync(join(stage, "lib", "node_modules", pkg, "package.json"), "utf8")).version;
const revision = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
})();
writeFileSync(
  join(stage, "MANIFEST.json"),
  `${JSON.stringify(
    {
      name: "volli-hostd",
      version,
      target,
      revision,
      node: process.versions.node,
      modules: process.versions.modules,
      natives: Object.fromEntries(
        Object.entries(NATIVES).map(([pkg, source]) => [pkg, { version: installed(pkg), source }]),
      ),
    },
    null,
    2,
  )}\n`,
);

// 5. Prove the natives load under the shipped Node before anything is archived.
run(join(stage, "bin", "node"), [join(stage, "lib", "probe-natives.cjs")]);
run(join(stage, "bin", "node"), [join(stage, "lib", "probe-codemode.mjs")]);

// 6. The archive and its checksum.
const archive = join(out, `${name}.tar.gz`);
// macOS's bsdtar would otherwise add AppleDouble `._*` entries and extended
// attributes from the build machine; the archive should hold only the files.
// GNU tar has neither option and needs neither, so they are Darwin-only.
const tarFlags = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : [];
run("tar", [...tarFlags, "-czf", archive, "-C", staging, name], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
rmSync(staging, { recursive: true, force: true });
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
process.stdout.write(`${archive}\n${digest}\n`);
