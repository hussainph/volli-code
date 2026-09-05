/**
 * Measures the latencies the bench replays, so the headline numbers rest on
 * something real rather than on a plausible-looking constant.
 *
 * Each probe does work of the same *class* as a Volli tool, not a mock of it:
 * a real file read, a real subprocess, a real HTTPS round trip, a real
 * fsync'd write. What it cannot measure honestly it does not pretend to —
 * `provider` needs a paid model call and `browser` needs the app's live
 * browser, so both are declared as assumptions and swept over instead of
 * being invented here.
 *
 *   pnpm -C packages/agent-runtime run bench:probe
 *
 * Writes `profile.measured.json` beside this file. The bench falls back to
 * `FALLBACK_PROFILE` when that file is absent, and always prints which one it
 * used.
 *
 * That file is a generated artefact committed in-tree, which is a rule this
 * repo otherwise holds to. It is kept deliberately: the benchmark tables in
 * `docs/research/pi-parallel-tool-execution-vc-245.md` are only reproducible
 * against the latencies they were produced with, and network latency in
 * particular moves enough between runs to shift every absolute millisecond in
 * them. **Re-running this probe invalidates those tables** — regenerate them
 * with `run bench` in the same sitting, or restore the committed profile.
 */

import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));

/** Milliseconds for one call of `work`, taken as a median of `samples` runs. */
async function timed(samples: number, work: () => Promise<unknown>): Promise<number> {
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = process.hrtime.bigint();
    await work();
    durations.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
  }
  durations.sort((left, right) => left - right);
  const middle = Math.floor(durations.length / 2);
  return Number(
    (durations.length % 2 === 0
      ? (durations[middle - 1]! + durations[middle]!) / 2
      : durations[middle]!
    ).toFixed(1),
  );
}

/** The five public pages the network probe rotates through. */
const NETWORK_TARGETS = [
  "https://example.com",
  "https://www.iana.org/help/example-domains",
  "https://developer.mozilla.org/en-US/",
  "https://nodejs.org/en",
  "https://www.rfc-editor.org/rfc/rfc2606.txt",
];

async function main(): Promise<void> {
  const offline = process.env.BENCH_PROBE_OFFLINE === "1";

  const localFile = await timed(21, () => readFile(join(here, "harness.ts"), "utf8"));

  const subprocess = await timed(11, () => run("/bin/echo", ["bench"]));

  // `mkdtemp` rather than a name built from the pid: a predictable path in the
  // shared temp dir is one another user can pre-create as a symlink, and the
  // `open(…, "w")` below would then follow it and write through. `mkdtemp`
  // makes a fresh 0700 directory with a random suffix, so the file underneath
  // it cannot be anticipated.
  const scratchDir = await mkdtemp(join(tmpdir(), "volli-bench-"));
  const scratch = join(scratchDir, "durable-write.tmp");
  const sessionStart = await timed(11, async () => {
    // A durable write is a write plus the fsync that makes it durable; timing
    // only the write would flatter every side-effecting tool in the bench.
    const handle = await open(scratch, "w");
    await handle.writeFile(JSON.stringify({ startedAt: Date.now(), payload: "x".repeat(2_048) }));
    await handle.sync();
    await handle.close();
  });
  await rm(scratchDir, { recursive: true, force: true });

  let network = 0;
  let networkNote = "measured";
  if (offline) {
    networkNote = "skipped (BENCH_PROBE_OFFLINE=1)";
  } else {
    let index = 0;
    try {
      network = await timed(NETWORK_TARGETS.length, async () => {
        const target = NETWORK_TARGETS[index % NETWORK_TARGETS.length]!;
        index += 1;
        const response = await fetch(target, { redirect: "follow" });
        await response.text();
      });
    } catch (error) {
      networkNote = `failed (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  const profile = {
    localFile,
    subprocess,
    network: network || 400,
    // Assumed, not measured. A Browser Tab call is a page load inside a real
    // browser plus accessibility-tree extraction; nothing in this package can
    // stand in for that, so it is declared and swept rather than faked.
    browser: 900,
    sessionStart,
    // Measured, but by the transcript audit rather than here: 130,600ms mean
    // over 241 real `ticket.await` calls. Nothing in this package can park on
    // another Session, so the probe carries the audit's number forward.
    ticketAwait: 130_600,
    // Assumed, not measured. Measuring it costs a real provider call.
    provider: 1_400,
  };

  const document = {
    measuredAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    notes: {
      localFile: "measured: fs.readFile of a ~13KB source file",
      subprocess: "measured: execFile /bin/echo",
      network: `${networkNote}: HTTPS GET + full body read, rotating five public pages`,
      browser: "ASSUMED: needs the app's live browser; swept in the sensitivity table",
      sessionStart: "measured: open + write 2KB + fsync + close",
      ticketAwait: "measured by the transcript audit: 130,600ms mean over 241 real calls",
      provider: "ASSUMED: one paid round trip; swept in the sensitivity table",
    },
    profile,
  };

  const path = join(here, "profile.measured.json");
  const handle = await open(path, "w");
  await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`);
  await handle.close();

  console.log(JSON.stringify(document, null, 2));
  console.log(`\nwrote ${path}`);
}

await main();
