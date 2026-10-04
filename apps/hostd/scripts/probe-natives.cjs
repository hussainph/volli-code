#!/usr/bin/env node
/**
 * Loads and exercises every native module hostd ships, under the Node running
 * it, and exits non-zero naming the first that fails. The artifact build runs
 * it before archiving; on a box, `bin/node lib/probe-natives.cjs` answers
 * "will this host's natives load here" without starting the host.
 */
"use strict";

const { execFileSync } = require("node:child_process");

async function main() {
  const report = {};

  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  report["better-sqlite3"] = db.prepare("select sqlite_version() as v").get().v;
  db.close();

  const pty = require("node-pty");
  report["node-pty"] = await new Promise((resolve, reject) => {
    let output = "";
    const shell = pty.spawn("/bin/sh", ["-c", "printf pty-ok"], { cols: 80, rows: 24 });
    shell.onData((data) => (output += data));
    shell.onExit(({ exitCode }) =>
      exitCode === 0 && output.includes("pty-ok")
        ? resolve("spawned /bin/sh")
        : reject(new Error(`node-pty: exit ${exitCode}, output ${JSON.stringify(output)}`)),
    );
  });

  const sharp = require("sharp");
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  const meta = await sharp(png).metadata();
  if (meta.width !== 2) throw new Error("sharp: round trip lost the image");
  report.sharp = `libvips ${sharp.versions.vips}`;

  // ESM-only: loaded the way hostd's bundle loads it.
  const { rgPath } = await import("@vscode/ripgrep");
  report["@vscode/ripgrep"] = execFileSync(rgPath, ["--version"], { encoding: "utf8" }).split(
    "\n",
  )[0];

  process.stdout.write(`${JSON.stringify({ ok: true, node: process.versions.node, ...report })}\n`);
}

main().catch((error) => {
  process.stderr.write(`probe-natives: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
