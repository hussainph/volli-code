#!/usr/bin/env node
/**
 * Focused real Electron/CDP regression probe. Builds first with `pnpm run build`,
 * then run this file. It launches ONLY through guarded volli-drive, sends one
 * scripted fake-model turn through the real composer and Browser tools, and
 * stops its one instance in finally. No credentials or owner profile involved.
 *
 * The fixture deliberately withholds rAF callbacks while keeping AX responsive.
 * A structural read must still work; visual input/capture must fail closed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import { createRegistry, instanceLayout, REPO } from "./lib/core.mjs";
import { request } from "./lib/protocol.mjs";
import { windowTargeting } from "./lib/window-targeting.mjs";

const exec = promisify(execFile);
const cli = join(REPO, "apps/desktop/e2e/volli-drive/cli.mjs");
const scratch = join(REPO, ".scratch/browser-readiness-probe");
await mkdir(scratch, { recursive: true });
const counts = { stalled: 0, normal: 0, submitted: 0, wrong: 0 };
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture.invalid").pathname;
  if (path === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  const page =
    path === "/stalled"
      ? "stalled"
      : path === "/submitted"
        ? "submitted"
        : path === "/wrong"
          ? "wrong"
          : "normal";
  counts[page] += 1;
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>${page}</title>
    <style>
      html { background: ${page === "submitted" ? "#359963" : page === "stalled" ? "#b04040" : "#ededeb"}; }
      body { margin: 0; } button { width: 180px; height: 60px; font-size: 24px; }
      #target { position: absolute; left: ${page === "stalled" ? 80 : 600}px; top: ${page === "stalled" ? 80 : 320}px; }
      #trap { position: absolute; left: 80px; top: 80px; }
    </style>
    ${page === "stalled" ? "<script>window.requestAnimationFrame = () => 1;</script>" : ""}
    <h1>${page === "submitted" ? "Submitted once" : "Readiness fixture"}</h1>
    <form id="target" action="/submitted"><button>Submit once</button></form>
    ${page === "normal" ? '<form id="trap" action="/wrong"><button>Old position trap</button></form>' : ""}`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const program = `
const raw = r => typeof r === "string" ? r : r.text;
const opened = raw(await tools.browser_navigate({ url: ${JSON.stringify(`${origin}/stalled`)} }));
const tabId = /Browser Tab (\\S+) at/.exec(opened)[1];
const generation = Number(/generation (\\d+)/.exec(opened)[1]);
if (!opened.includes('button "Submit once"')) throw new Error("stalled navigation lost AX structure");
const read = raw(await tools.browser_snapshot({ tabId }));
const found = raw(await tools.browser_find({ tabId, query: "Submit once" }));
if (!read.includes('button "Submit once"') || !found.includes("1 match")) throw new Error("structural read failed");
const ref = /\\[ref=(e\\d+)\\]/.exec(found)[1];
let captureRefused = false;
try { await tools.browser_screenshot({ tabId }); } catch (e) { captureRefused = String(e).includes("rendered frame"); }
if (!captureRefused) throw new Error("stalled frame allowed screenshot");
let clickRefused = false;
try { await tools.browser_act({ tabId, generation, kind: "click", ref }); } catch (e) { clickRefused = String(e).includes("rendered frame"); }
if (!clickRefused) throw new Error("stalled frame allowed hit-tested input");
const afterTimeout = raw(await tools.browser_find({ tabId, query: "Submit once" }));
if (!afterTimeout.includes("1 match")) throw new Error("timeout wedged tab queue");
const normal = raw(await tools.browser_navigate({ tabId, url: ${JSON.stringify(`${origin}/normal`)} }));
const shot = await tools.browser_screenshot({ tabId });
if (!shot.images?.length) throw new Error("headless capture returned no image");
const fresh = raw(await tools.browser_find({ tabId, query: "Submit once" }));
const normalRef = /\\[ref=(e\\d+)\\]/.exec(fresh)[1];
const normalGeneration = Number(/generation (\\d+)/.exec(fresh)[1]);
const submitted = raw(await tools.browser_act({ tabId, generation: normalGeneration, kind: "click", ref: normalRef }));
if (!submitted.includes("Submitted once")) throw new Error("headless click hit a stale surface");
const submittedShot = await tools.browser_screenshot({ tabId });
if (!submittedShot.images?.length) throw new Error("post-navigation capture returned no image");
const reload = raw(await tools.browser_navigate({ tabId, action: "reload" }));
if (!reload.includes("Submitted once")) throw new Error("reload lost structure");
let staleRefused = false;
try { staleRefused = raw(await tools.browser_act({ tabId, generation: normalGeneration, kind: "click", ref: normalRef })).includes("browser.stale-ref"); } catch (e) { staleRefused = String(e).includes("generation"); }
if (!staleRefused) throw new Error("reload accepted stale refs");
text({ structuralReads: true, visualTimeouts: 2, queueRecovered: true, headlessCapture: true, hitTest: true, staleRefused });
text("READINESS_" + "ASSERTIONS_PASSED");
`;
const scriptPath = join(scratch, "replies.json");
await writeFile(
  scriptPath,
  JSON.stringify([
    { toolCalls: [{ name: "codemode", arguments: { code: program } }] },
    { text: "Readiness probe complete" },
  ]),
);
let id;
let layout;
const drive = async (...args) =>
  (
    await exec(process.execPath, [cli, ...args], {
      cwd: REPO,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
// Use the same supervised, serialized drive wire as the CLI, without starting
// a new Node process for each gesture on a memory-constrained shared machine.
const snapshot = (snap) => ({ output: snap.text, generation: snap.generation });
// Keep each snapshot/action/wait on the chosen page through the shared
// native-window targeting: the workbench first, then the Settings window the
// Settings button opens, then back to the workbench after its native close.
// `wait` keeps its socket budget riding on the requested timeout.
const windows = windowTargeting((cmd, args = {}) =>
  request(
    layout.driveSocket,
    cmd,
    args,
    cmd === "wait" && Number.isFinite(Number(args.timeout))
      ? { timeoutMs: Number(args.timeout) + 30_000 }
      : undefined,
  ),
);
const find = async (query) => {
  const snap = await windows.call("find", { query });
  return { output: snap.matches.join("\n"), generation: snap.generation };
};
const act = async (snap, ref, kind, ...args) => {
  const options = {};
  for (let i = 0; i < args.length; i += 2) options[args[i].slice(2)] = args[i + 1];
  const result = await windows.call("act", {
    gen: snap.generation,
    ref,
    kind,
    ...options,
  });
  return snapshot(result.snapshot);
};
const wait = async (text, timeout) =>
  snapshot((await windows.call("wait", { text, timeout })).snapshot);
const refFor = (snap, label) => {
  const line = snap.output
    .split("\n")
    .find((candidate) => candidate.includes(label) && /\[ref=/.test(candidate));
  assert.ok(line, snap.output);
  return /\[ref=([^\]]+)\]/.exec(line)[1];
};
try {
  const launched = JSON.parse(
    await drive(
      "launch",
      "--fixture",
      "basic",
      "--model",
      "fake",
      "--fake-script",
      scriptPath,
      "--no-build",
      "--json",
    ),
  );
  id = launched.id;
  assert.ok(id, JSON.stringify(launched));
  const entry = await createRegistry().get(id);
  layout = instanceLayout(entry.scratch, entry.evidence);
  await drive("doctor", id);
  // Enable Code Mode in this isolated profile before the Session is born.
  // Settings is a native second window: open it from the workbench button,
  // target that window for the Agents pane, and close it at the native
  // boundary — a quiet window cannot become key, so close is addressed
  // explicitly, never by sending an OS-wide keyboard event. The workbench
  // (DRV-1 and the Session below it) is the target again afterwards.
  let snap = await find("Settings");
  snap = await act(snap, refFor(snap, 'button "Settings"'), "click");
  await windows.useSettingsWindow();
  snap = await find("Agents");
  snap = await act(snap, refFor(snap, 'button "Agents"'), "click");
  snap = await wait("Code Mode for new Sessions", 10_000);
  snap = await act(snap, refFor(snap, 'combobox "Code Mode for new Sessions"'), "click");
  snap = await find("Code and direct tools");
  snap = await act(snap, refFor(snap, 'option "Code and direct tools"'), "click");
  await windows.call("settings-native", { action: "close" });
  windows.useMainWindow();
  // The real ticket -> Draft -> composer Send path, not injected renderer state.
  snap = await find("DRV-1");
  snap = await act(snap, refFor(snap, "DRV-1"), "click");
  snap = await act(snap, refFor(snap, "DRV-1"), "press", "--key", "Enter");
  snap = await find("Open a tab");
  snap = await act(snap, refFor(snap, 'button "Open a tab"'), "click");
  snap = await find("Chat");
  snap = await act(snap, refFor(snap, 'menuitem "Chat'), "click");
  snap = await find("Message");
  snap = await act(
    snap,
    refFor(snap, 'textbox "Message"'),
    "type",
    "--text",
    "Run readiness probe",
  );
  await act(snap, refFor(snap, 'textbox "Message"'), "press", "--key", "Enter");
  snap = await wait("Readiness probe complete", 120_000);
  const details = snap.output
    .split("\n")
    .findLast((line) => line.includes('button "Show details"'));
  assert.ok(details, snap.output);
  snap = await act(snap, /\[ref=([^\]]+)\]/.exec(details)[1], "click");
  assert.ok(snap.output.includes("READINESS_ASSERTIONS_PASSED"), snap.output);
  await request(layout.driveSocket, "screenshot", { name: "readiness-probe" });
  const sessions = await drive("state", id, "cli", "session", "list", "--project", "DRV", "--json");
  await writeFile(join(scratch, "sessions.json"), sessions);
  const mainLog = await readFile(join(launched.evidence, "logs/main.log"), "utf8");
  const logs =
    mainLog.match(/\[browser\] browser CDP command timed out \{[\s\S]*?\n\}/g)?.join("\n") ?? "";
  assert.ok(logs.includes("frame-fence"), logs);
  assert.ok(logs.includes("stage"), logs);
  assert.ok(logs.includes('"wakeLeases":1') || logs.includes("wakeLeases: 1"), logs);
  // One request to the stalled page proves neither visual failure replayed it.
  assert.deepEqual(counts, { stalled: 1, normal: 1, submitted: 2, wrong: 0 }); // submit + explicit reload
  // Read the exact full-resolution PNGs kept by browser_screenshot, not a
  // separate camera. Distinct document colours catch a previous surface even
  // when capture itself returned successfully (the old UnknownVizError family).
  const pictures = join(layout.userDataDir, "browser-pictures");
  const pngs = [];
  for (const name of await readdir(pictures)) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(join(pictures, name), "utf8"));
    if (record.mime === "image/png") pngs.push(record);
  }
  pngs.sort((a, b) => a.capturedAt - b.capturedAt);
  assert.equal(pngs.length, 2);
  const pixels = [];
  for (const [index, expected] of [
    [237, 237, 235],
    [53, 153, 99],
  ].entries()) {
    const path = join(pictures, `${pngs[index].id}.png`);
    const pixel = [
      ...(await sharp(path)
        .extract({ left: 0, top: 0, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer()),
    ];
    assert.deepEqual(pixel, expected, `stale screenshot at generation ${pngs[index].generation}`);
    pixels.push({ generation: pngs[index].generation, rgb: pixel });
    await copyFile(
      path,
      join(launched.evidence, "screenshots", `${index === 0 ? "normal" : "submitted"}-tab.png`),
    );
  }
  await drive("doctor", id);
  const result = { id, counts, pixels, diagnostics: logs, sessions: JSON.parse(sessions) };
  await writeFile(join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify(
      { id, counts, evidence: launched.evidence, result: join(scratch, "result.json") },
      null,
      2,
    ),
  );
} finally {
  try {
    if (id) console.log(await drive("stop", id));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
