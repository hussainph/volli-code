#!/usr/bin/env node
"use strict";
// Build-time ABI gate. Inspect every ELF, including bundled shared libraries,
// not just the .node entrypoints that happen to load in today's runtime probe.
const { execFileSync } = require("node:child_process");
const {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} = require("node:fs");
const { join, resolve, sep } = require("node:path");

function glibcVersions(output) {
  // readelf --version-info also lists definitions. Only version *needs* constrain
  // compatibility; do not count a library's own exported GLIBC_* definitions.
  const needs = output
    .split(/Version needs section/)
    .slice(1)
    .join("\n");
  return [...needs.matchAll(/\bName: GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)].map((m) => m.slice(1));
}
function exceedsFloor([major, minor, patch]) {
  return (
    Number(major) > 2 ||
    (Number(major) === 2 &&
      (Number(minor) > 31 || (Number(minor) === 31 && Number(patch ?? 0) > 0)))
  );
}
function probe(root) {
  root = realpathSync(root);
  const seen = new Set();
  let binaries = 0;
  function walk(path) {
    const real = realpathSync(path);
    if (real !== root && !real.startsWith(root + sep))
      throw new Error(`Artifact symlink escapes root: ${path}`);
    if (seen.has(real)) return;
    seen.add(real);
    // Open first, refusing a swapped final symlink. Both the header check and
    // readelf inspect this same descriptor, never reopening a mutable pathname.
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const entry = fstatSync(fd);
      if (entry.isDirectory()) {
        for (const name of readdirSync(real)) walk(join(real, name));
        return;
      }
      if (!entry.isFile()) throw new Error(`Unsupported artifact entry: ${path}`);
      const magic = Buffer.alloc(4);
      readSync(fd, magic, 0, 4, 0);
      if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return;
      binaries++;
      // This is a Linux build-time probe; pass the descriptor explicitly as
      // child fd3 so replacing the original path cannot change the ELF parsed.
      const output = execFileSync("readelf", ["--version-info", "/proc/self/fd/3"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", fd],
        maxBuffer: 16 * 1024 * 1024,
      });
      const incompatible = glibcVersions(output).filter(exceedsFloor);
      if (incompatible.length)
        throw new Error(
          `${path} needs GLIBC_${incompatible[0].filter(Boolean).join(".")} (runner floor is 2.31)`,
        );
    } finally {
      closeSync(fd);
    }
  }
  walk(root);
  if (!binaries) throw new Error("No ELF binaries found in runner artifact");
  console.log(`probe-glibc: ${binaries} ELF binaries require glibc <= 2.31`);
}
module.exports = { glibcVersions, exceedsFloor, probe };
if (require.main === module) {
  try {
    probe(resolve(process.argv[2] ?? "."));
  } catch (error) {
    console.error(`probe-glibc: ${error.message}`);
    process.exitCode = 1;
  }
}
