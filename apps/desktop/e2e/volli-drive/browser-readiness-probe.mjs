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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { REPO } from "./lib/core.mjs";

const exec = promisify(execFile);
const cli = join(REPO, "apps/desktop/e2e/volli-drive/cli.mjs");
const scratch = join(REPO, ".scratch/browser-readiness-probe");
await mkdir(scratch, { recursive: true });
const counts = { stalled: 0, normal: 0, submitted: 0 };
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture.invalid").pathname;
  if (path === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  const page = path === "/stalled" ? "stalled" : path === "/submitted" ? "submitted" : "normal";
  counts[page] += 1;
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>${page}</title>
    <style>body { background: ${page === "submitted" ? "#359963" : "#ededeb"}; padding: 80px; } button { font-size: 24px; }</style>
    ${page === "stalled" ? "<script>window.requestAnimationFrame = () => 1;</script>" : ""}
    <h1>${page === "submitted" ? "Submitted once" : "Readiness fixture"}</h1>
    <form action="/submitted"><button>Submit once</button></form>`);
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
const drive = async (...args) =>
  (
    await exec(process.execPath, [cli, ...args], {
      cwd: REPO,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
const parseSnapshot = (output) => {
  const generation = Number(/generation: (\d+)/.exec(output)?.[1]);
  assert.ok(Number.isFinite(generation), output);
  return { output, generation };
};
const find = async (text) => parseSnapshot(await drive("find", id, text));
const act = async (snap, ref, kind, ...args) =>
  parseSnapshot(
    await drive("act", id, "--gen", String(snap.generation), "--kind", kind, "--ref", ref, ...args),
  );
const refFor = (snap, label) => {
  const line = snap.output.split("\n").find((line) => line.includes(label) && /\[ref=/.test(line));
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
  await drive("doctor", id);
  // Enable a per-model Code Mode pin through Settings; the fake model's
  // ordinary default is Off. This must happen before the Session is born.
  let snap = await find("Settings");
  snap = await act(snap, refFor(snap, 'button "Settings"'), "click");
  snap = await find("Models");
  snap = await act(snap, refFor(snap, "Models"), "click");
  snap = await find("Show advanced Code Mode settings");
  snap = await act(snap, refFor(snap, "Show advanced Code Mode settings"), "click");
  snap = await find("Pin a model");
  snap = await act(snap, refFor(snap, 'combobox "Pin a model"'), "click");
  snap = await find("GPT-4.1 mini");
  snap = await act(snap, refFor(snap, 'option "GPT-4.1 mini"'), "click");
  snap = await find("Code Mode for GPT-4.1 mini");
  snap = await act(snap, refFor(snap, 'combobox "Code Mode for GPT-4.1 mini"'), "click");
  snap = await find("Both");
  snap = await act(snap, refFor(snap, 'option "Both"'), "click");
  snap = await find("Home");
  snap = await act(snap, refFor(snap, 'button "Home"'), "click");
  // The real ticket -> Draft -> composer Send path, not injected renderer state.
  snap = await find("DRV-1");
  snap = await act(snap, refFor(snap, "DRV-1"), "click");
  snap = await act(snap, refFor(snap, "DRV-1"), "press", "--key", "Enter");
  snap = await find("New chat");
  snap = await act(snap, refFor(snap, "New chat"), "click");
  snap = await find("Message");
  snap = await act(
    snap,
    refFor(snap, 'textbox "Message"'),
    "type",
    "--text",
    "Run readiness probe",
  );
  await act(snap, refFor(snap, 'textbox "Message"'), "press", "--key", "Enter");
  snap = parseSnapshot(
    await drive("wait", id, "--text", "Readiness probe complete", "--timeout", "120000"),
  );
  const details = snap.output
    .split("\n")
    .filter((line) => line.includes('button "Show details"'))
    .at(-1);
  assert.ok(details, snap.output);
  snap = await act(snap, /\[ref=([^\]]+)\]/.exec(details)[1], "click");
  assert.ok(snap.output.includes("READINESS_ASSERTIONS_PASSED"), snap.output);
  await drive("screenshot", id, "--name", "readiness-probe");
  const sessions = await drive("state", id, "cli", "session", "list", "--project", "DRV", "--json");
  await writeFile(join(scratch, "sessions.json"), sessions);
  const mainLog = await readFile(join(launched.evidence, "logs/main.log"), "utf8");
  const logs =
    mainLog.match(/\[browser\] browser CDP command timed out \{[\s\S]*?\n\}/g)?.join("\n") ?? "";
  assert.ok(logs.includes("frame-fence"), logs);
  assert.ok(logs.includes("stage"), logs);
  assert.ok(logs.includes('"wakeLeases":1') || logs.includes("wakeLeases: 1"), logs);
  // One request to the stalled page proves neither visual failure replayed it.
  assert.deepEqual(counts, { stalled: 1, normal: 1, submitted: 2 }); // submit + explicit reload
  await drive("doctor", id);
  const result = { id, counts, diagnostics: logs, sessions: JSON.parse(sessions) };
  await writeFile(join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify(
      { id, counts, evidence: launched.evidence, result: join(scratch, "result.json") },
      null,
      2,
    ),
  );
} finally {
  if (id) console.log(await drive("stop", id));
  await new Promise((resolve) => server.close(resolve));
}
