#!/usr/bin/env node
/**
 * Assemble a self-contained Linux runner with the pinned Node, native modules,
 * CLI and Code Mode worker. Run inside .devcontainer/runner-build/Dockerfile.
 * Every ELF is inspected against glibc 2.31 before the archive is emitted.
 * Usage: node apps/runner/scripts/package.mjs --out <dir>
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

/** The natives runner ships, and the platform package each one loads its binary from. */
const NATIVES = {
  "better-sqlite3": "better-sqlite3 (bundled N-API prebuild)",
  "node-pty": "node-pty (compiled from source at deploy, N-API)",
  sharp: "sharp with @img/sharp-<platform> and @img/sharp-libvips-<platform>",
  "@vscode/ripgrep": "@vscode/ripgrep with @vscode/ripgrep-<platform>",
};

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (values.out === undefined) {
  process.stderr.write("usage: node apps/runner/scripts/package.mjs --out <dir>\n");
  process.exit(2);
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });

const nvmrc = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("Runner artifacts support Linux x64 and arm64 only.");
}
if (process.versions.node !== nvmrc) {
  throw new Error(`Node ${process.versions.node} is not the pinned ${nvmrc} (.nvmrc).`);
}
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const target = `${process.platform}-${process.arch}`;
const name = `volli-runner-${version}-${target}`;
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
// Staged on local disk and archived from there: only the archive reaches
// --out, which in CI and in Docker Desktop is a bind mount that may not keep
// file modes.
const staging = mkdtempSync(join(tmpdir(), "runner-stage-"));
const stage = join(staging, name);
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(join(stage, "lib"), { recursive: true });

// 1. The two bundles.
run("pnpm", ["--filter", "@volli/runner", "--filter", "@volli/cli", "run", "build"]);
// runner's bundle is an entry plus the chunks its lazy imports split off.
cpSync(join(APP, "dist"), join(stage, "lib", "runner"), { recursive: true });
copyFileSync(join(ROOT, "packages", "cli", "dist", "volli.cjs"), join(stage, "lib", "volli.cjs"));
copyFileSync(join(HERE, "probe-natives.cjs"), join(stage, "lib", "probe-natives.cjs"));
copyFileSync(join(HERE, "probe-codemode.mjs"), join(stage, "lib", "probe-codemode.mjs"));

// 2. The externals, from the lockfile, flat so lib/runner/runner.cjs resolves them.
// Install scripts run: node-pty has no Linux prebuild and compiles here.
const deployed = mkdtempSync(join(tmpdir(), "runner-deploy-"));
try {
  run("pnpm", [
    "--filter",
    "@volli/runner",
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

// 3. The pinned Linux Node and symlink-safe launchers.
copyFileSync(process.execPath, join(stage, "bin", "node"));
chmodSync(join(stage, "bin", "node"), 0o755);
const launcher = (bundle) => `#!/bin/sh
# Generated by apps/runner/scripts/package.mjs.
here=$(dirname "$(readlink -f "$0")")
exec "$here/node" "$here/../lib/${bundle}" "$@"
`;
writeFileSync(join(stage, "bin", "volli-runner"), launcher("runner/runner.cjs"), { mode: 0o755 });
writeFileSync(join(stage, "bin", "volli"), launcher("volli.cjs"), { mode: 0o755 });

// 4. Install/update units are supplied by the runner installer packages.
// No Chromium: the runner does not download a browser during installation.
mkdirSync(join(stage, "share", "systemd"), { recursive: true });
for (const unit of readdirSync(join(APP, "packaging"))) {
  if (/^volli-runner.*\.(service|path)$/.test(unit)) {
    copyFileSync(join(APP, "packaging", unit), join(stage, "share", "systemd", unit));
  }
}
copyFileSync(join(APP, "packaging", "README.md"), join(stage, "README.md"));
copyFileSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
copyFileSync(join(HERE, "probe-glibc.cjs"), join(stage, "lib", "probe-glibc.cjs"));

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
      name: "volli-runner",
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

run(join(stage, "bin", "node"), [join(stage, "lib", "probe-glibc.cjs"), stage]);

// 5. Prove the natives load under the shipped Node before anything is archived.
run(join(stage, "bin", "node"), [join(stage, "lib", "probe-natives.cjs")]);
run(join(stage, "bin", "node"), [join(stage, "lib", "probe-codemode.mjs")]);

// 6. The archive and its checksum.
const archive = join(out, `${name}.tar.gz`);
run("tar", ["-czf", archive, "-C", staging, name]);
rmSync(staging, { recursive: true, force: true });
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
process.stdout.write(`${archive}\n${digest}\n`);
