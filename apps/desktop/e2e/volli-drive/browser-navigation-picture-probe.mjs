#!/usr/bin/env node
/**
 * VC-1150 discriminator, NOT a capture-policy repair or a replacement smoke.
 * Build separately, then run once. Exactly one guarded fake-model volli-drive
 * instance; Browser commands go through composer -> Pi -> Code Mode -> real
 * Browser tools/CDP. No renderer/domain-state injection or legacy launcher.
 *
 * Read-only diagnostic boundary: the fixture renderer's existing preload reads
 * tab/trace metadata and picture lengths through real IPC. The immediate size
 * comes from the harness-only camera record before the navigate result returns.
 * This is NOT proof of the original smoke's direct-port disposal lifetime: a
 * root Session stays attached until stop. The original smoke retains its own
 * immediate/before/after-disposal checkpoints for CI.
 *
 * Times: Code Mode pins the program's clock (codemode/journal.ts), so every
 * elapsed, ordering and presentation decision uses host records instead: the
 * nested call spans in this Session's referenced transcript artifacts and
 * this tab's trace (lib/navigation-host-evidence.mjs). The program's own
 * clock fields are only a pinned-clock witness.
 *
 * Main work is bounded to 180 s, then <=80 s cleanup (a <=10 s failure-path
 * live doctor, then the CLI stop's 60 s). No automatic retries or
 * builds. The 12 s delayed module is the original cold-load fixture, not an
 * extra readiness sleep. Failure evidence survives before assertions fail.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Script } from "node:vm";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import sharp from "sharp";

import { ELECTRON } from "../lib/smoke-kit.mjs";
import { quietSmokeVerdict } from "../../scripts/smoke-quiet-check-logic.mjs";
import { createRegistry, instanceLayout, REPO } from "./lib/core.mjs";
import {
  collectNavigationMetrics,
  NavigationCollectionError,
  navigationToolProgram,
} from "./lib/navigation-picture-collector.mjs";
import {
  HostEvidenceError,
  navigationTiming,
  nestedSpanTiming,
  readTranscriptArtifact,
  settledSpans,
  transcriptReferences,
  transcriptReferenceSql,
} from "./lib/navigation-host-evidence.mjs";
import { request } from "./lib/protocol.mjs";

const exec = promisify(execFile);
const cli = join(REPO, "apps/desktop/e2e/volli-drive/cli.mjs");
const INITIAL_ROWS = 900;
const CHUNK_ROWS = 600;
const CHUNK_DELAY_MS = 12_000;
const SCREENSHOT_BUDGET_MS = 5_000;
const MAIN_BUDGET_MS = 180_000;
const parent = join(REPO, ".scratch/browser-navigation-picture-probe");
await mkdir(parent, { recursive: true });
const run = await mkdtemp(join(parent, "run-"));
const evidenceRoot = join(run, "instances");
await mkdir(evidenceRoot);
const env = { ...process.env, VOLLI_DRIVE_EVIDENCE: evidenceRoot };
const endAt = Date.now() + MAIN_BUDGET_MS;
const abort = new AbortController();
const expiry = setTimeout(() => abort.abort(), MAIN_BUDGET_MS);
const remaining = () => {
  abort.signal.throwIfAborted();
  return Math.max(1, endAt - Date.now());
};
const bounded = (promise, cap = remaining()) => {
  const ms = Math.min(cap, remaining());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe operation deadline")), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
};
const drive = async (...args) =>
  (
    await exec(process.execPath, [cli, ...args], {
      cwd: REPO,
      env,
      signal: abort.signal,
      timeout: Math.min(60_000, remaining()),
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
const result = {
  boundary: "composer/tools; read-only preload diagnostics",
  checks: [],
  pass: false,
};
let phase = "preflight";
let id;
let layout;
let browser;
let sampler;
let samplerClosed;
let samplerOutput = "";
const stopPath = join(run, "sampler-stop");
const fixtureAbort = new AbortController();
let resolveChunk;
const chunkDone = new Promise((resolve) => {
  resolveChunk = resolve;
});
const timing = {
  documentResponses: 0,
  chunkRequests: 0,
  chunkRequestedAt: null,
  chunkRespondedAt: null,
};
result.timing = timing;
const health = (report) => ({
  ok: report.ok,
  pid: report.electron.pid,
  guardActive: report.guard.active,
  violations: report.guard.violations.length,
  trapped: Object.values(report.guard.live?.trapped ?? {}).filter(Boolean).length,
  containment: Object.fromEntries(
    [
      "userDataInside",
      "homeInside",
      "agentHomeInside",
      "dbInside",
      "appSocketInside",
      "appSocketOwned",
    ].map((key) => [key, report.isolation[key]]),
  ),
  build: { commit: report.build.commit, dirty: report.build.dirty },
});

// Same cold-module geometry, DOM workload, title counters and timings as
// browser-headless-capture-smoke.mjs. No fixture-side rendering override.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>vc278 phase=boot clicked=0 nodes=0</title>
<style>
body { margin:0; background:#0b1020; color:#e8ecff; font:14px/1.4 system-ui }
#go { position:fixed; top:8px; left:8px; z-index:10; width:220px; height:56px; font-size:18px }
.row { margin:0 0 6px 250px; padding:8px 12px; border-radius:8px;
background:linear-gradient(90deg,#1d4ed8,#7c3aed); box-shadow:0 1px 6px #0008 }
</style></head><body><button id="go">Press me</button><main id="graph"></main>
<script>
const graph = document.getElementById("graph");
const state = { phase:"initial", clicked:0, publish() {
 document.title = "vc278 phase=" + this.phase + " clicked=" + this.clicked +
 " nodes=" + document.getElementsByTagName("*").length;
}};
globalThis.vc278 = state;
function rows(label, count) {
 const band = document.createElement("section");
 for (let i=0; i<count; i++) {
  const row = document.createElement("div"); row.className="row";
  row.textContent=label + " row " + i; band.appendChild(row);
 }
 graph.appendChild(band);
 let measured=0; for (const row of band.children) measured+=row.getBoundingClientRect().height;
 return measured;
}
rows("document", ${INITIAL_ROWS}); state.publish();
document.getElementById("go").addEventListener("click", () => { state.clicked++; state.publish(); });
window.addEventListener("load", () => setTimeout(() => {
 state.phase="compiling"; state.publish(); import("/cold-chunk.mjs");
}, 50));
</script></body></html>`;
const CHUNK = `const state=globalThis.vc278;
const band=document.createElement("section");
for(let i=0;i<${CHUNK_ROWS};i++) {
 const row=document.createElement("div"); row.className="row";
 row.textContent="chunk row " + i; band.appendChild(row);
}
document.getElementById("graph").appendChild(band);
let measured=0; for(const row of band.children) measured+=row.getBoundingClientRect().height;
state.phase="ready"; state.publish(); export { measured };`;
const server = createServer((req, res) => {
  void (async () => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    res.setHeader("Cache-Control", "no-store");
    if (path === "/cold-chunk.mjs") {
      timing.chunkRequests++;
      timing.chunkRequestedAt = Date.now();
      await delay(CHUNK_DELAY_MS, undefined, { signal: fixtureAbort.signal });
      timing.chunkRespondedAt = Date.now();
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(CHUNK);
      resolveChunk();
    } else if (path === "/") {
      timing.documentResponses++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    } else res.writeHead(404).end();
  })().catch(() => res.destroy());
});

// Reuse the native sampler, NOT smoke-quiet-check's legacy launch wrapper.
async function startSampler() {
  sampler = spawn(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      join(REPO, "apps/desktop/scripts/smoke-quiet-sampler.jxa"),
      stopPath,
      "0.25",
      ELECTRON,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let ready;
  let failed;
  const readiness = new Promise((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const collect = (bytes) => {
    samplerOutput += bytes.toString("utf8");
    if (samplerOutput.length > 512 * 1024) {
      failed(new Error("sampler output bound"));
      sampler.kill("SIGTERM");
    }
    if (samplerOutput.includes("READY")) ready();
  };
  sampler.stdout.on("data", collect);
  sampler.stderr.on("data", collect);
  sampler.on("error", () => failed(new Error("sampler spawn failed")));
  samplerClosed = new Promise((resolve) =>
    sampler.once("close", (code, signal) => {
      failed(new Error("sampler ended before ready"));
      resolve({ code, signal });
    }),
  );
  await bounded(readiness, 5_000);
}

function refFor(snap, label) {
  const line = snap.text.split("\n").find((row) => row.includes(label) && /\[ref=/.test(row));
  assert.ok(line, "required UI control missing");
  return /\[ref=([^\]]+)\]/.exec(line)[1];
}
const call = (cmd, args = {}, cap = 15_000) =>
  request(layout.driveSocket, cmd, args, {
    timeoutMs: Math.min(cap, remaining()),
  });
const find = async (query) => {
  const snap = await call("find", { query });
  return { text: snap.matches.join("\n"), generation: snap.generation };
};
const act = async (snap, label, kind = "click", extra = {}) =>
  (
    await call("act", {
      gen: snap.generation,
      ref: refFor(snap, label),
      kind,
      ...extra,
    })
  ).snapshot;
const wait = async (text, timeout = 15_000) =>
  (await call("wait", { text, timeout }, timeout + 1_000)).snapshot;

async function diagnostics() {
  const fields = [
    "ts",
    "msg",
    "outcome",
    "picture",
    "lookupSize",
    "generation",
    "currentGeneration",
    "pending",
    "elapsedMs",
  ];
  const rows = [];
  const dir = join(layout.userDataDir, "logs");
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const body = await readFile(join(dir, name), "utf8");
    assert.ok(body.length < 16 * 1024 * 1024, "structured log size bound");
    for (const line of body.split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      if (
        row.component !== "browser" ||
        !["browser navigation picture frame", "browser navigation picture outcome"].includes(
          row.msg,
        )
      )
        continue;
      rows.push(
        Object.fromEntries(fields.filter((key) => key in row).map((key) => [key, row[key]])),
      );
    }
  }
  return rows.toSorted((a, b) => a.ts.localeCompare(b.ts));
}

try {
  assert.equal(process.platform, "darwin", "native sampler requires macOS");
  await drive("doctor"); // Static guard preflight; never builds.
  phase = "native sampler";
  await startSampler(); // Baseline recorded before the single app exists.
  phase = "fixture setup";
  await bounded(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    5_000,
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const program = navigationToolProgram(`${origin}/`);
  // Parse the generated asynchronous tool body without executing it. Outer
  // node --check alone cannot validate JavaScript inside a template string.
  assert.doesNotThrow(() => new Script(`(async () => {\n${program}\n})`), "tool program syntax");
  const replies = join(run, "replies.json");
  await writeFile(
    replies,
    JSON.stringify([
      { toolCalls: [{ name: "codemode", arguments: { code: program } }] },
      { text: "Navigation picture commands complete" },
    ]),
  );
  phase = "guarded launch";
  const launched = JSON.parse(
    await drive(
      "launch",
      "--fixture",
      "basic",
      "--model",
      "fake",
      "--fake-script",
      replies,
      "--no-build",
      "--json",
    ),
  );
  id = launched.id;
  result.id = id;
  result.evidence = launched.evidence;
  const entry = await createRegistry().get(id);
  assert.ok(entry && entry.evidence === launched.evidence, "owned registry entry missing");
  layout = instanceLayout(entry.scratch, entry.evidence);
  result.doctorBefore = health(JSON.parse(await drive("doctor", id, "--json")));
  assert.equal(result.doctorBefore.ok, true, "live guard/containment proof failed");
  phase = "read-only registry observer";
  const [port, ws] = (await readFile(join(layout.userDataDir, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${ws}`, {
    timeout: Math.min(10_000, remaining()),
  });
  const page = browser
    .contexts()[0]
    .pages()
    .find((candidate) => candidate.url().startsWith("volli-app:"));
  assert.ok(page, "fixture renderer missing");
  // A local read-only subscription, not injected domain/renderer state. It
  // observes presentation around the timed tools without driving the page.
  const observed = page
    .evaluate(
      (budget) =>
        new Promise((resolve, reject) => {
          const samples = [];
          let off;
          const finish = (ok) => {
            clearTimeout(timer);
            off?.();
            if (ok) resolve(samples);
            else reject(new Error("registry observation incomplete"));
          };
          const timer = setTimeout(() => finish(false), budget);
          off = window.api.browser.onTabState(({ tab }) => {
            if (!tab || tab.projectId !== "drive-project" || tab.createdBy !== "session") return;
            const documentPhase =
              /phase=(boot|initial|compiling|ready)/.exec(tab.title)?.[1] ?? null;
            const nodes = Number(/nodes=(\d+)/.exec(tab.title)?.[1]);
            const clicked = tab.title.includes("clicked=1");
            samples.push({
              tabId: tab.tabId,
              at: Date.now(),
              presentation: tab.presentation,
              generation: tab.generation,
              phase: documentPhase,
            });
            if (samples.length > 128) finish(false);
            else if (documentPhase === "ready" && nodes >= 1500 && clicked) finish(true);
          });
        }),
      remaining(),
    )
    .then(
      (samples) => ({ samples }),
      () => ({ incomplete: true }),
    );
  phase = "composer setup";
  let snap = await find("Settings");
  snap = await act(snap, 'button "Settings"');
  snap = await find("Agents");
  snap = await act(snap, 'button "Agents"');
  snap = await wait("Code Mode for new Sessions");
  snap = await act(snap, 'combobox "Code Mode for new Sessions"');
  snap = await find("Code and direct tools");
  snap = await act(snap, 'option "Code and direct tools"');
  snap = await find("Close Settings");
  snap = await act(snap, 'button "Close Settings"');
  snap = await find("DRV-1");
  snap = await act(snap, "DRV-1");
  snap = await act(snap, "DRV-1", "press", { key: "Enter" });
  snap = await find("Open a tab");
  snap = await act(snap, 'button "Open a tab"');
  snap = await find("Chat");
  snap = await act(snap, 'menuitem "Chat');
  snap = await find("Message");
  snap = await act(snap, 'textbox "Message"', "type", {
    text: "Run navigation picture discriminator",
  });
  phase = "production Browser commands";
  await act(snap, 'textbox "Message"', "press", { key: "Enter" });
  await wait("Navigation picture commands complete", 45_000);
  // The settled bundle is collapsed (run-EmUg4N gen-0021): open its header
  // from a fresh tree, then ONLY the codemode row's disclosure (never a browse
  // row: its tab card would read the measured picture). No fallback.
  const collected = await collectNavigationMetrics({
    snapshot: () => call("snapshot"),
    click: async (generation, ref) =>
      (await call("act", { gen: generation, ref, kind: "click" })).snapshot,
    checkpoint: (next) => {
      phase = next;
    },
  });
  result.metrics = collected.metrics;
  result.collection = collected.collection;
  phase = "production Browser evidence";
  await bounded(chunkDone, CHUNK_DELAY_MS + 5_000);
  result.observation = await bounded(observed, 5_000);
  assert.ok(!result.observation.incomplete, "registry observation incomplete");
  phase = "read-only IPC evidence";
  // Existing read-only preload calls only. Never invoke open/navigate/act here.
  result.host = await bounded(
    page.evaluate(
      async ({ tabId }) => {
        const api = window.api.browser;
        const listed = await api.list({ projectId: "drive-project" });
        if (!listed.ok) throw new Error("registry read failed");
        const tab = listed.tabs.find((candidate) => candidate.tabId === tabId);
        if (!tab) throw new Error("Session tab missing");
        const traces = await window.api.browser.traces({ sessionId: tab.ownerSessionId });
        if (!traces.ok) throw new Error("trace read failed");
        // Steps carry no tab id: the TRACE is per (Session, tab).
        const steps = traces.traces
          .filter((trace) => trace.tabId === tabId)
          .flatMap((trace) => trace.steps);
        const open = steps.find((step) => step.action === "open");
        const shot = steps.find((step) => step.action === "screenshot");
        const sizeOf = async (pictureId) => {
          if (pictureId == null) return 0;
          const answer = await api.picture({ pictureId });
          if (!answer.ok) throw new Error("picture IPC failed");
          return answer.dataUrl?.length ?? 0;
        };
        return {
          presentation: tab.presentation,
          generation: tab.generation,
          ready: tab.title.includes("phase=ready"),
          clicked: tab.title.includes("clicked=1"),
          nodes: Number(/nodes=(\d+)/.exec(tab.title)?.[1]),
          ownerMatches: tab.ownerSessionId !== null && tab.createdBy === "session",
          ownerSessionId: tab.ownerSessionId,
          // Host settle times for the timing evidence: facts only, no page text.
          traceSteps: steps.map(({ action, generation, at, outcome }) => ({
            action,
            generation,
            at,
            outcome,
          })),
          navigationRecorded: Boolean(open),
          screenshotRecorded: Boolean(shot),
          navigationPicture: open?.pictureId ?? null,
          screenshotPicture: shot?.pictureId ?? null,
          navigationLaterSize: await sizeOf(open?.pictureId),
          screenshotLaterSize: await sizeOf(shot?.pictureId),
        };
      },
      { tabId: result.metrics.tabId },
    ),
    10_000,
  );
  phase = "host timing evidence";
  // Code Mode pins its program clock, so every time below is the host's own:
  // the nested call spans in this Session's referenced transcript artifacts,
  // cross-checked against this tab's trace. Read-only; no picture is read.
  const references = transcriptReferences(
    JSON.parse(await drive("state", id, "sql", transcriptReferenceSql(result.host.ownerSessionId))),
  );
  const transcripts = join(layout.userDataDir, "session-transcripts");
  const spans = settledSpans(
    references.map((reference) => readTranscriptArtifact(transcripts, reference, readFileSync)),
  );
  result.hostTiming = navigationTiming({
    timing: nestedSpanTiming({ spans, metrics: result.metrics }),
    steps: result.host.traceSteps,
    metrics: result.metrics,
  });
  result.hostTiming.references = references.length;
  phase = "real PNG decode";
  assert.match(
    result.host.screenshotPicture ?? "",
    /^[a-f0-9-]{36}$/i,
    "screenshot ID not a host UUID",
  );
  const png = await readFile(
    join(layout.userDataDir, "browser-pictures", `${result.host.screenshotPicture}.png`),
  );
  const decoded = await bounded(
    sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    5_000,
  );
  const colours = new Set();
  for (let offset = 0; offset + 3 < decoded.data.length; offset += 4 * 997) {
    colours.add(`${decoded.data[offset]},${decoded.data[offset + 1]},${decoded.data[offset + 2]}`);
    if (colours.size > 32) break;
  }
  result.pixels = {
    bytes: png.length,
    width: decoded.info.width,
    height: decoded.info.height,
    colours: colours.size,
  };
  result.diagnostics = await diagnostics();
  const frame = result.diagnostics.find((row) => row.msg === "browser navigation picture frame");
  const camera =
    frame?.outcome === "ready"
      ? result.diagnostics.find((row) => row.msg === "browser navigation picture outcome")
      : null;
  result.navigationDiscriminator = {
    frame: frame?.outcome ?? "missing-diagnostic",
    camera: camera?.outcome ?? "not-observed",
    picture: result.host.navigationPicture,
    immediateSize: camera?.lookupSize ?? 0,
    laterSize: result.host.navigationLaterSize,
  };
  result.timing = timing;
  // m: the program's fixed record (its clock fields are only the pinned
  // witness); t: host spans and trace times, the only times decisions use.
  const m = result.metrics,
    h = result.host,
    p = result.pixels,
    t = result.hostTiming;
  const samples = result.observation.samples.filter((row) => row.tabId === m.tabId);
  const at = (time) => samples.findLast((row) => row.at <= time)?.presentation;
  result.presentations = {
    before: at(t.requestedAt),
    after: at(t.answeredAt),
    end: h.presentation,
  };
  // The original four assertions remain positive requirements, including #4.
  result.checks = [
    {
      check: 1,
      ok:
        timing.documentResponses === 1 &&
        timing.chunkRequests === 1 &&
        timing.chunkRespondedAt !== null &&
        t.answeredAt < timing.chunkRespondedAt &&
        h.ready &&
        h.nodes >= INITIAL_ROWS + CHUNK_ROWS,
    },
    {
      check: 2,
      ok:
        result.presentations.before === "headless" &&
        result.presentations.after === "headless" &&
        h.presentation === "headless" &&
        samples.every((row) => row.presentation === "headless") &&
        h.ownerMatches &&
        t.screenshotMs < SCREENSHOT_BUDGET_MS &&
        m.hasImage &&
        p.bytes > 2_000 &&
        m.width > 0 &&
        m.height > 0 &&
        p.width === m.width &&
        p.height === m.height &&
        p.colours >= 4,
    },
    {
      check: 3,
      ok:
        m.clickedWhileCompiling &&
        t.clickRequestedAt < timing.chunkRespondedAt &&
        t.clickAnsweredAt < timing.chunkRespondedAt &&
        // The tabs read whose title gives clickedWhileCompiling finished
        // before the chunk answered, so "compiling" is a fact of that window.
        t.tabsAnsweredAt < timing.chunkRespondedAt &&
        h.clicked,
    },
    {
      check: 4,
      ok:
        h.navigationRecorded &&
        h.screenshotRecorded &&
        h.navigationLaterSize > 2_000 &&
        h.screenshotLaterSize > 2_000,
    },
  ];
  await call("screenshot", { name: "navigation-picture-discriminator" });
  result.doctorAfter = health(JSON.parse(await drive("doctor", id, "--json")));
  assert.equal(result.doctorAfter.ok, true, "post-run guard/containment proof failed");
  assert.ok(frame, "preview frame diagnostic missing");
  assert.ok(frame.outcome !== "ready" || camera, "native camera diagnostic missing");
  result.pass = result.checks.every((check) => check.ok);
  phase = "assertions complete";
} catch (error) {
  result.failedPhase = phase; // No arbitrary error, page text, CDP params or URL logging.
  // Collection facts are counts, allowlisted phases and fixed program causes.
  if (error instanceof NavigationCollectionError) result.collection = error.collection;
  if (error instanceof HostEvidenceError) result.timingEvidence = error.evidence;
} finally {
  clearTimeout(expiry);
  abort.abort();
  // The launch CLI can time out before printing its ID. This invocation has a
  // unique evidence root; recover ONLY its own spec(s), never other instances.
  result.cleanup = [];
  try {
    if (layout && !result.diagnostics) {
      try {
        result.diagnostics = await diagnostics();
      } catch {
        result.diagnosticReadFault = true;
      }
    }
    // Failure path only: a LIVE post-run guard proof while the owned instance
    // still runs, inside this bounded cleanup and never in place of its stop.
    // A static doctor is not this proof; when it cannot run, say so.
    if (id && !result.doctorAfter) {
      try {
        const { stdout } = await exec(process.execPath, [cli, "doctor", id, "--json"], {
          cwd: REPO,
          env,
          timeout: 10_000,
          maxBuffer: 4 * 1024 * 1024,
        }).catch((error) => {
          if (typeof error?.stdout === "string" && error.stdout.trim()) return error;
          throw error;
        });
        result.doctorAfterFailurePath = health(JSON.parse(stdout));
        if (!result.doctorAfterFailurePath.ok) result.guardFault = true;
      } catch {
        result.doctorAfterFailurePath = { notReached: true };
      }
    }
    if (browser) {
      try {
        await Promise.race([browser.close(), delay(2_000)]);
      } catch {
        result.detachFault = true;
      }
    }
    const ownIds = new Set(id ? [id] : []);
    const names = await readdir(evidenceRoot).catch(() => []);
    for (const name of names) {
      if (!/^vd-[a-f0-9]{6}$/.test(name)) continue;
      try {
        const spec = JSON.parse(await readFile(join(evidenceRoot, name, "spec.json"), "utf8"));
        if (spec.id === name && spec.evidence === join(evidenceRoot, name)) ownIds.add(name);
      } catch {
        result.specReadFault = true;
      }
    }
    for (const owned of ownIds) {
      try {
        await exec(process.execPath, [cli, "stop", owned], {
          cwd: REPO,
          env,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
        result.cleanup.push({ id: owned, stopped: true });
      } catch {
        result.cleanup.push({ id: owned, stopped: false });
      }
    }
    const listed = await createRegistry().list();
    result.ownLiveInstances = listed.filter((entry) => entry.live && ownIds.has(entry.id)).length;
  } catch {
    result.cleanupFault = true;
  } finally {
    fixtureAbort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await writeFile(stopPath, "stop\n");
    if (sampler) {
      let kill;
      try {
        kill = setTimeout(() => sampler.kill("SIGKILL"), 2_000);
        const exit = await samplerClosed;
        const line = samplerOutput
          .trim()
          .split("\n")
          .findLast((row) => row.startsWith("{"));
        const report = JSON.parse(line ?? "null");
        assert.ok(report, "native sampler report missing");
        result.quiet = { report, verdict: quietSmokeVerdict(report), exit };
        if (exit.code !== 0 || !result.quiet.verdict.ok || report.smokeAppCount !== 1)
          result.pass = false;
      } catch {
        result.quietFault = true;
        result.pass = false;
      } finally {
        clearTimeout(kill);
      }
    } else result.pass = false;
  }
  if (
    result.cleanupFault ||
    result.ownLiveInstances !== 0 ||
    result.cleanup.some((row) => !row.stopped)
  )
    result.pass = false;
  await writeFile(join(run, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}
console.log(
  JSON.stringify(
    {
      pass: result.pass,
      phase: result.failedPhase ?? phase,
      checks: result.checks,
      discriminator: result.navigationDiscriminator ?? null,
      collection: result.collection ?? null,
      timingEvidence: result.timingEvidence ?? null,
      hostTiming: result.hostTiming ?? null,
      doctorAfter: result.doctorAfter ?? null,
      doctorAfterFailurePath: result.doctorAfterFailurePath ?? null,
      evidence: run,
      ownLiveInstances: result.ownLiveInstances ?? null,
    },
    null,
    2,
  ),
);
if (!result.pass) process.exitCode = 1;
