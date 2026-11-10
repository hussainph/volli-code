/**
 * The update legs' later releases (VC-1043): this run's runner archive,
 * **re-stamped** as another version, so an update has somewhere to go
 * without building the runner twice more. What is under test there is the
 * update path (stage, verify, drain, activate, health, rollback), not the
 * build, so a re-stamp is labelled as such in every output.
 *
 * A re-stamp changes exactly what names the version: the archive's root
 * directory and file name (C4), the packager's `MANIFEST.json`, and the
 * version string baked into the runner bundle (`lib/runner/`). Nothing else
 * in the archive moves, so its natives, Node and probes are the real ones.
 *
 * `broken: true` makes a release that stages (its probes pass) but whose
 * daemon refuses to start: the runner's `run` exits 70 at once, so it never
 * reports online at that version and the update must roll back.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What a broken release's runner does first: refuse `run`, leave every other command alone. */
export const BROKEN_PRELUDE =
  'if (process.argv[2] === "run") { process.stderr.write("volli-runner: this release is broken on purpose (BYO lane rollback leg)\\n"); process.exit(70); }\n';

/** `text` with every JSON string literal `"from"` replaced by `"to"`, and how many there were. */
export function replaceVersionLiteral(text, from, to) {
  const needle = JSON.stringify(from);
  const parts = text.split(needle);
  return { text: parts.join(JSON.stringify(to)), count: parts.length - 1 };
}

/** `source` with {@link BROKEN_PRELUDE} after any shebang and leading directive. */
export function breakRunner(source) {
  const lines = source.split("\n");
  let at = 0;
  if (lines[0]?.startsWith("#!")) at = 1;
  if (/^["']use strict["'];?\s*$/u.test(lines[at] ?? "")) at += 1;
  lines.splice(at, 0, BROKEN_PRELUDE.trimEnd());
  return lines.join("\n");
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * Write `volli-runner-<to>-linux-<arch>.tar.gz` and its `.sha256` sidecar
 * into `outDir`, re-stamped from `archive` (a C4 tarball of version `from`).
 */
export function restampArchive({ archive, from, to, arch, outDir, broken = false }) {
  const work = mkdtempSync(join(tmpdir(), "byo-restamp-"));
  try {
    execFileSync("tar", ["-xzf", archive, "-C", work]);
    const fromRoot = `volli-runner-${from}-linux-${arch}`;
    const toRoot = `volli-runner-${to}-linux-${arch}`;
    renameSync(join(work, fromRoot), join(work, toRoot));
    const root = join(work, toRoot);

    const manifestPath = join(root, "MANIFEST.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.version !== from) {
      throw new Error(`${archive} is ${manifest.version}, not ${from}`);
    }
    manifest.version = to;
    manifest.restampedFrom = from;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    let baked = 0;
    for (const path of walk(join(root, "lib", "runner"))) {
      if (!/\.(c|m)?js$/u.test(path)) continue;
      const replaced = replaceVersionLiteral(readFileSync(path, "utf8"), from, to);
      if (replaced.count > 0) writeFileSync(path, replaced.text);
      baked += replaced.count;
    }
    if (baked === 0) throw new Error(`no baked "${from}" in ${toRoot}/lib/runner`);
    if (broken) {
      const bundle = join(root, "lib", "runner", "runner.cjs");
      writeFileSync(bundle, breakRunner(readFileSync(bundle, "utf8")));
    }

    const name = `${toRoot}.tar.gz`;
    const out = join(outDir, name);
    execFileSync("tar", ["-czf", out, "-C", work, toRoot]);
    const digest = createHash("sha256").update(readFileSync(out)).digest("hex");
    writeFileSync(`${out}.sha256`, `${digest}  ${name}\n`);
    return { path: out, sha256: digest, baked };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
