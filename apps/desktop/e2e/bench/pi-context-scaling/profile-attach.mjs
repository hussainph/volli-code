#!/usr/bin/env node
/**
 * VC-445: where one Pi re-bind spends its time, outside Electron.
 *
 * The Electron bench shows the re-bind stall and its size; this names its
 * cause. It grows one synthetic sidecar with the bench's own generator (real
 * runtime, faux provider, real `read` calls, tripwire loaded). The sidecar is
 * created here rather than by the app's `sessions.attach`, and the workspace
 * files are smaller than the bench fixture's, so its bytes per entry differ;
 * the report quotes each run's own size. It times a series of re-attaches,
 * then CPU-profiles a few more through the inspector and prints the bottom-up
 * self-time table. Plain Node: no app, no ledger, no network.
 *
 *   node apps/desktop/e2e/bench/pi-context-scaling/profile-attach.mjs --entries 1500
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import helpers from "../session-rpc/helpers.cjs";
import { withGenerator } from "./generator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(join(here, "network-tripwire.cjs"));

const ENTRIES = helpers.parsePositiveInteger("entries", 1_500);
const TIMED = helpers.parsePositiveInteger("timed", 6);
const PROFILED = helpers.parsePositiveInteger("profiled", 5);
const model = { providerId: "openai", modelId: "gpt-5-mini", reasoningLevel: "low" };
const identity = {
  sessionId: "vc445-profile",
  rootThreadId: "vc445-thread",
  attachmentId: "vc445-attachment",
  projectId: "vc445-project",
};

const root = await mkdtemp(join(tmpdir(), "vc445-profile-"));
try {
  await withGenerator(async (generator) => {
    const workspacePath = join(root, "workspace");
    const sessionDataDir = join(root, "sessions");
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await mkdir(sessionDataDir, { recursive: true });
    const files = [];
    for (let index = 0; index < 24; index += 1) {
      const path = `src/module-${index}.ts`;
      const line = `export function value${index}(input: number): number { return input * ${index}; }\n`;
      await writeFile(join(workspacePath, path), line.repeat(12 + index * 8));
      files.push(path);
    }
    const catalogModel = generator.builtinCatalogModel(model.providerId, model.modelId);
    const base = { sessionDataDir, workspacePath, model, catalogModel };
    const recovery = await generator.createSidecar({ ...base, identity });
    const target = { ...identity, recovery, targetEntries: ENTRIES, seed: 445 };
    const [grown] = await generator.growSidecarHistories({ ...base, files, targets: [target] });
    console.log(`sidecar: ${grown.entries} entries, ${(grown.bytes / 1e6).toFixed(2)} MB`);

    const timings = [];
    const stalls = [];
    for (let index = 0; index < TIMED; index += 1) {
      // VC-462: the longest the loop was held during each re-attach, the
      // plain-Node stand-in for the Electron bench's hydration-window max.
      // The histogram records a stall only when its timer next fires, so it
      // stays enabled for a few ms after the attach; disabled at once, it
      // would miss a stall that ends the attach.
      const delay = monitorEventLoopDelay({ resolution: 1 });
      delay.enable();
      timings.push(Math.round(await generator.reattachOnce({ ...base, target })));
      await new Promise((resolve) => setTimeout(resolve, 20));
      delay.disable();
      stalls.push(Math.round(delay.max / 1e6));
    }
    console.log(`re-attach ms: ${timings.join(", ")}`);
    console.log(`re-attach loop-delay max ms: ${stalls.join(", ")}`);

    const inspector = new Session();
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.setSamplingInterval", { interval: 100 });
    await inspector.post("Profiler.start");
    for (let index = 0; index < PROFILED; index += 1) {
      await generator.reattachOnce({ ...base, target });
    }
    const { profile } = await inspector.post("Profiler.stop");
    inspector.disconnect();

    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const self = new Map();
    let total = 0;
    for (const [index, id] of profile.samples.entries()) {
      const frame = nodes.get(id).callFrame;
      // The profiler's own session frame is the measurement, not the subject.
      if (frame.url === "node:inspector") continue;
      const where = frame.url.split("/").slice(-3).join("/");
      const key = `${frame.functionName || "(anonymous)"}  ${where}:${frame.lineNumber + 1}`;
      const micros = profile.timeDeltas[index] ?? 0;
      self.set(key, (self.get(key) ?? 0) + micros);
      total += micros;
    }
    console.log(
      `\nself time over ${PROFILED} re-attaches (${Math.round(total / 1000)} ms sampled):`,
    );
    for (const [key, micros] of [...self].toSorted((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`${String(Math.round(micros / 1000)).padStart(7)} ms  ${key}`);
    }
    const blocked = globalThis.VOLLI_NETWORK_TRIPWIRE?.blocked ?? [];
    console.log(`\nnetwork attempts refused: ${blocked.length}`);
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
