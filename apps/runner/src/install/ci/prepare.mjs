#!/usr/bin/env node
/** Installer-only payload: the real CLI/native dependency, an explicitly fake unlinked runtime. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "linux")
  throw new Error("This payload is built only by the Linux CI lane.");
if (!process.argv[2]) throw new Error("usage: prepare.mjs <new-output-directory>");
const out = resolve(process.argv[2]);
const app = resolve(import.meta.dirname, "../../..");
const repository = resolve(app, "../..");
const release = join(out, "release");
if (existsSync(release)) throw new Error("Refusing to overwrite an existing fixture release.");
mkdirSync(join(release, "bin"), { recursive: true });
mkdirSync(join(release, "lib"), { recursive: true });
execFileSync(
  "pnpm",
  [
    "--filter",
    "@volli/runner",
    "deploy",
    "--prod",
    "--frozen-lockfile",
    "--config.inject-workspace-packages=true",
    "--config.node-linker=hoisted",
    join(out, "prod"),
  ],
  { cwd: repository, stdio: "inherit" },
);
cpSync(join(out, "prod/node_modules"), join(release, "lib/node_modules"), {
  recursive: true,
  verbatimSymlinks: true,
});
cpSync(join(app, "dist"), join(release, "lib/runner"), { recursive: true });
copyFileSync(process.execPath, join(release, "bin/node"));
copyFileSync(
  join(import.meta.dirname, "runtime-fixture.mjs"),
  join(release, "lib/install-runtime-fixture.mjs"),
);
writeFileSync(
  join(release, "bin/volli-runner"),
  `#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "\${1-}" = run ]; then
  exec "$HERE/node" "$HERE/../lib/install-runtime-fixture.mjs" "$@"
fi
exec "$HERE/node" "$HERE/../lib/runner/runner.cjs" "$@"
`,
);
for (const file of ["node", "volli-runner"]) chmodSync(join(release, "bin", file), 0o755);
const version = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).version;
writeFileSync(
  join(release, "MANIFEST.json"),
  `${JSON.stringify({ name: "volli-runner", version, revision: `installer-fixture-${process.env.GITHUB_SHA ?? "local"}`, target: `linux-${process.arch}`, node: process.versions.node })}\n`,
);
console.log(
  `Installer-test payload: ${release}; runtime is an unlinked fixture, not a cloud runner.`,
);
