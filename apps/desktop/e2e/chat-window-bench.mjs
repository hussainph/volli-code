#!/usr/bin/env node
/** Synthetic real-ChatPlane benchmark, not a real-app user journey.
 * Every live run is launch → doctor → measure → doctor → stop through
 * volli-drive. There is no direct Electron entry or credential/packed fallback.
 * See bench/chat-window/README.md for matched source-revision comparisons.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import { assertProductionReact, readBenchCadence } from "./bench/chat-window/production.mjs";
import { parseBenchArgs } from "./bench/chat-window/settings.mjs";
import { overlayManifest, prepareSources, verifySource } from "./bench/chat-window/sources.mjs";
import { runGuardedSide, serialComparison } from "./bench/chat-window/guarded-run.mjs";
import { printReport } from "./bench/chat-window/report.mjs";
const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const options = parseBenchArgs(process.argv.slice(2));
const output = resolve(options.output ?? join(REPO, ".scratch/chat-window-bench"));
await mkdir(output, { recursive: true });
process.env.NODE_ENV = "production";
const command = (cwd, bin, args, timeout = 300_000) =>
  exec(bin, args, {
    cwd,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: "production" },
  });
const driver = (dir) => async (args) => {
  const { stdout } = await command(
    dir,
    process.execPath,
    [join(dir, "apps/desktop/e2e/volli-drive/cli.mjs"), ...args],
    390_000,
  );
  return JSON.parse(stdout);
};
let sides;
if (options.compare) {
  sides = await prepareSources(REPO, options.compare, join(output, "sources"));
} else {
  const { stdout: commit } = await command(REPO, "git", ["rev-parse", "HEAD"]);
  const { stdout: status } = await command(REPO, "git", ["status", "--porcelain"]);
  const { stdout: diff } = await command(REPO, "git", [
    "diff",
    "HEAD",
    "--",
    ".",
    ":(exclude)apps/desktop/e2e",
  ]);
  sides = [
    {
      dir: REPO,
      metadata: {
        commit: commit.trim(),
        dirty: Boolean(status.trim()),
        productDiffSha256: createHash("sha256").update(diff).digest("hex"),
        overlay: { files: await overlayManifest(REPO) },
      },
    },
  ];
}
await writeFile(join(output, "sources.json"), JSON.stringify(sides, null, 2) + "\n");
if (options.prepareOnly) {
  console.log("Prepared source-only snapshots; no install, build or launch performed:");
  for (const side of sides) console.log(side.dir);
} else {
  // Do all dependency checks/builds BEFORE the first live measurement, not
  // between comparison sides (which would change machine load/thermal state).
  for (const side of sides) {
    if (!existsSync(join(side.dir, "node_modules")))
      throw new Error(
        `dependencies absent in ${side.dir}; install its frozen lockfile only in an approved slot`,
      );
    if (options.compare) await verifySource(side.dir, side.metadata);
    const bench = join(side.dir, "apps/desktop/e2e/bench/chat-window");
    if (!options.skipBuild) {
      await command(side.dir, "pnpm", ["run", "build"]);
      // Resolve the snapshot's own Vite/dependencies, not the controller's.
      await command(join(side.dir, "apps/desktop"), process.execPath, [
        "--input-type=module",
        "-e",
        `const { build } = await import('vite'); const { diagramCadencePlugin } = await import(${JSON.stringify(join(bench, "production.mjs"))}); await build({ configFile: ${JSON.stringify(join(bench, "vite.config.ts"))}, mode: 'production', logLevel: 'warn', plugins: [diagramCadencePlugin(${JSON.stringify(options.settings.diagramSampleMs)})] });`,
      ]);
    }
    if (options.compare) await verifySource(side.dir, side.metadata);
    await assertProductionReact(join(bench, "dist"));
    side.metadata.benchCadence = await readBenchCadence(
      join(bench, "dist"),
      options.settings.diagramSampleMs,
    );
    const sourceProof = JSON.stringify({
      commit: side.metadata.commit,
      product: side.metadata.product ?? side.metadata.productDiffSha256,
      overlay: side.metadata.overlay,
    });
    const assets = await readdir(join(bench, "dist/assets"));
    side.metadata.benchAssets = {};
    for (const asset of assets.toSorted())
      side.metadata.benchAssets[asset] = createHash("sha256")
        .update(await readFile(join(bench, "dist/assets", asset)))
        .digest("hex");
    side.metadata.hostBundleSha256 = createHash("sha256")
      .update(await readFile(join(side.dir, "apps/desktop/dist-electron/main.cjs")))
      .digest("hex");
    const proof = JSON.stringify({
      sourceProof,
      benchAssets: side.metadata.benchAssets,
      benchCadence: side.metadata.benchCadence,
      hostBundleSha256: side.metadata.hostBundleSha256,
    });
    const proofPath = join(bench, "dist/.chat-window-build.json");
    if (options.skipBuild) {
      const prior = await readFile(proofPath, "utf8").catch(() => "");
      if (prior !== proof)
        throw new Error(
          `--skip-build source/build proof missing or stale in ${side.dir}; rebuild through this entry`,
        );
    } else await writeFile(proofPath, proof);
  }
  // Keep the exact build/cadence identities even if a guarded probe later
  // refuses its sample contract; failed evidence must not lose artifact proof.
  await writeFile(join(output, "sources.json"), JSON.stringify(sides, null, 2) + "\n");
  const reports = await serialComparison(sides, async (side) => {
    if (options.compare) await verifySource(side.dir, side.metadata);
    const report = await runGuardedSide({
      drive: driver(side.dir),
      settings: options.settings,
      source: side.metadata,
    });
    console.log(`\n__BENCH__${JSON.stringify(report)}__BENCH__`);
    await printReport(report, options.settings.streamTokenRate);
    // Legacy trace flags still copy the raw trace to the requested path. In a
    // comparison each side gets its own suffix, never overwriting the first.
    for (const arm of ["draft", "reveal", "stream"]) {
      const target = options.settings[`${arm}Trace`];
      const file = report[`${arm}Trace`];
      if (target && file)
        await writeFile(
          options.compare ? `${target}.${side.metadata.commit}.json` : target,
          await readFile(file),
        );
    }
    await writeFile(
      join(output, `${side.metadata.commit}.json`),
      JSON.stringify(report, null, 2) + "\n",
    );
    return report;
  });
  await writeFile(
    join(output, "comparison.json"),
    JSON.stringify(
      {
        settings: options.settings,
        machine: {
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          cpus: os.cpus()[0]?.model,
        },
        reports,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`results: ${join(output, "comparison.json")}`);
}
