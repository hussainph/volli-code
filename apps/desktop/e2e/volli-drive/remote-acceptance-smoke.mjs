#!/usr/bin/env node
/** VC-718: one ordered user journey, real production SSH/relay/Session wiring.
 * Electron and managed host installation run ONLY on disposable macOS CI.
 * The only external doubles are the localhost sshd and fake model HTTP API.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRegistry, findInSnapshot, instanceLayout, REPO } from "./lib/core.mjs";
import { request } from "./lib/protocol.mjs";
import {
  ANSWER_QUESTION,
  ANSWER_REPLY,
  REOPEN_QUESTION,
  REMOTE_HOST,
  REMOTE_PROJECT,
  STREAM_REPLY,
  assertAcceptanceRunner,
} from "./lib/remote-acceptance.mjs";

// Remove ONLY after VC-710 lands. Unexpected pass fails, never quietly waives
// the new path. Descendants are BLOCKED, not successful acceptance evidence.
const EXPECTED_FAILURE = { step: 2, ticket: "VC-710" };
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const TITLE = "Cloud acceptance ticket";
const results = [];
let instance;
let socket;
const call = (cmd, args = {}) => request(socket, cmd, args, { timeoutMs: 150_000 });
const snap = () => call("snapshot");
const wait = async (text, timeout = 45_000) => (await call("wait", { text, timeout })).snapshot;

function record(number, status, assertion, detail = "") {
  results.push({ step: number, status, assertion, detail });
  console.log(`${status} ${number}: ${assertion}${detail ? ` — ${detail}` : ""}`);
}

/** Refs always come from a fresh tree; ambiguity is a failure, not a guess. */
function controls(tree, role, name, { contains = false } = {}) {
  return tree.split("\n").filter((line) => {
    const hit = line.trim().startsWith(`- ${role} `) && line.includes("[ref=");
    const label = line.match(/^\s*- \S+ "(.*?)"/)?.[1];
    return hit && (contains ? label?.includes(name) : label === name);
  });
}
async function action(kind, role, name, extra = {}, options = {}) {
  const current = await snap();
  const hits = controls(current.text, role, name, options);
  const hit = options.first ? hits[0] : hits.length === 1 ? hits[0] : null;
  assert.ok(hit, `Expected ${role} "${name}" once; found ${hits.length}\n${current.text}`);
  assert.ok(!hit.includes("[disabled]"), `${name} is disabled`);
  const ref = hit.match(/\[ref=([^\]]+)\]/)[1];
  return (await call("act", { gen: current.generation, ref, kind, ...extra })).snapshot;
}
const click = (role, name, options) => action("click", role, name, {}, options);
const type = (name, text) => action("type", "textbox", name, { text });
async function press(key) {
  const current = await snap();
  return (await call("act", { gen: current.generation, kind: "press", key })).snapshot;
}
async function shot(name) {
  await call("screenshot", { name });
}
async function send(text) {
  await type("Message", text);
  await action("press", "textbox", "Message", { key: "Enter" });
}
async function hostChip() {
  await click("button", "Host:", { contains: true });
}
async function selectHost(name) {
  await hostChip();
  await click("button", name, { contains: true, first: true });
  await wait(`Host: ${name}`);
}
async function card() {
  const current = await snap();
  const path = findInSnapshot(current.text, TITLE);
  const hit = path.findLast((line) => /^\s*- button(?: |\[)/u.test(line) && line.includes("[ref="));
  assert.ok(hit, `Ticket card missing: ${TITLE}`);
  const ref = hit.match(/\[ref=([^\]]+)\]/)[1];
  await call("act", { gen: current.generation, ref, kind: "click" });
  const focused = await snap();
  const next = findInSnapshot(focused.text, TITLE).findLast(
    (line) => /^\s*- button(?: |\[)/u.test(line) && line.includes("[ref="),
  );
  await call("act", {
    gen: focused.generation,
    ref: next.match(/\[ref=([^\]]+)\]/)[1],
    kind: "press",
    key: "Enter",
  });
}
async function step(number, assertion, body) {
  try {
    await body();
    await shot(`step-${number}`);
    record(number, "PASS", assertion);
  } catch (error) {
    record(number, "FAIL", assertion, error.message);
    await shot(`step-${number}-failed`).catch(() => {});
    throw error;
  }
}

async function journey() {
  const launched = await exec(
    process.execPath,
    [cli, "launch", "--fixture", "basic", "--remote-acceptance", "--no-build", "--json"],
    { cwd: REPO, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 },
  );
  instance = JSON.parse(launched.stdout);
  const entry = await createRegistry().get(instance.id);
  socket = instanceLayout(entry.scratch, entry.evidence).driveSocket;
  const fixture = await call("acceptance-fixture");
  await step(1, "Add host: ready checklist and paired row", async () => {
    await hostChip();
    await click("button", "Add a host…");
    await type("SSH destination", REMOTE_HOST);
    await click("button", "Connect");
    // known_hosts is the fixture's independently generated key. No ambient
    // trust/keys/agent or network destination can enter the system SSH client.
    const ready = await wait(`${REMOTE_HOST} is ready`, 120_000);
    assert.match(ready.text, /Paired with this Mac/);
    assert.match(ready.text, /Volli host/);
    await shot("step-1-ready-checklist");
    await click("button", "Done");
  });

  // A narrowly identified missing UI surface is the ONLY expected failure.
  // SSH/install/Pair failures, arbitrary exceptions and all later steps fail.
  let projectSurface = await snap();
  if (!projectSurface.text.includes(`Open a project on ${REMOTE_HOST}`)) {
    await hostChip();
    projectSurface = await snap();
    const hostRow = controls(projectSurface.text, "button", REMOTE_HOST, { contains: true })[0];
    if (EXPECTED_FAILURE && hostRow?.includes("[disabled]")) {
      record(
        2,
        "XFAIL",
        "Open/create a remote project",
        `${EXPECTED_FAILURE.ticket}: zero-project host row is disabled`,
      );
      for (let n = 3; n <= 8; n++)
        record(n, "BLOCKED", "Requires remote project", EXPECTED_FAILURE.ticket);
      await shot("step-2-VC-710-expected-failure");
      return;
    }
    await click("button", REMOTE_HOST, { contains: true, first: true });
    projectSurface = await wait(`Open a project on ${REMOTE_HOST}`);
  }
  if (EXPECTED_FAILURE) {
    record(
      2,
      "XPASS",
      "Open/create a remote project",
      "VC-710 surface now exists; remove expected-failure marker and run all eight steps",
    );
    throw new Error("VC-710 unexpectedly passed: remove its expected-failure marker");
  }
  await step(2, "Create/open project: project label and selected remote Host chip", async () => {
    await click("button", "New project…");
    await type(`Git URL or folder on ${REMOTE_HOST}`, fixture.projectPath);
    await type("Name (optional)", REMOTE_PROJECT);
    await click("button", "Create and open");
    await wait(`Opened ${REMOTE_PROJECT} on ${REMOTE_HOST}`, 90_000);
    await selectHost(REMOTE_HOST);
    const current = await wait(REMOTE_PROJECT);
    assert.match(current.text, new RegExp(`Host: ${REMOTE_HOST}`));
  });
  await call("acceptance-model");
  await wait(`Host: ${REMOTE_HOST}`);
  await step(3, "Create/move ticket: Backlog then Todo, persisted after UI reopen", async () => {
    await click("button", "Home");
    await click("button", "New ticket");
    await type("Ticket title", TITLE);
    await click("button", "Create ticket");
    await wait(TITLE);
    await card();
    await click("button", "Status: Backlog");
    await click("menuitemradio", "Todo");
    await wait("Status: Todo");
    await click("button", "Home");
    await card();
    const current = await wait("Status: Todo");
    assert.ok(current.text.includes(TITLE));
    assert.ok(current.text.includes(`Running on ${REMOTE_HOST}`));
  });
  await step(4, "Paste fake API key: Signed in on host · API key", async () => {
    await hostChip();
    await click("button", `Sign-ins on ${REMOTE_HOST}…`);
    const current = await wait("Azure OpenAI");
    // Match the Azure provider's following action, never another provider's
    // identically named Add key. Verify the key field names Azure afterwards.
    const lines = current.text.split("\n");
    const start = lines.findIndex((line) => line.includes("Azure OpenAI"));
    const add = lines
      .slice(start)
      .find((line) => line.includes('button "Add key"') && line.includes("[ref="));
    assert.ok(add, "Azure OpenAI Add key missing");
    await call("act", {
      gen: current.generation,
      ref: add.match(/\[ref=([^\]]+)\]/)[1],
      kind: "click",
    });
    await type(`Azure OpenAI API key, stored on ${REMOTE_HOST}`, "volli-drive-fake-key");
    await click("button", "Save");
    await wait(`Signed in on ${REMOTE_HOST} · API key`);
    await press("Escape");
  });
  await step(
    5,
    "Start Session: Stop turn, streamed scripted response, remote host pill",
    async () => {
      await click("button", "New chat", { first: true });
      await send("remote-stream-turn");
      await wait("Stop turn");
      const current = await wait(STREAM_REPLY);
      assert.ok(current.text.includes(`Running on ${REMOTE_HOST}`));
    },
  );
  await step(6, "Answer question: real options, sent receipt, host continuation", async () => {
    await send("remote-answer-question");
    await wait(ANSWER_QUESTION);
    await click("radio", "Proceed", { contains: true });
    await click("button", "Send answer");
    await wait(ANSWER_REPLY);
  });
  await step(
    7,
    "Quit/reopen: same remote Session row Waiting for you and pending question",
    async () => {
      await send("remote-reopen-question");
      await wait(REOPEN_QUESTION);
      // Menu-bar mode hosts THIS MAC's work, not remote work. A real local
      // scripted turn keeps the client alive while the remote question waits.
      await selectHost("This Mac");
      await click("button", "Home");
      await click("button", "New chat", { first: true });
      await send("[slow:120000] local-menu-bar-keepalive");
      await wait("Stop turn");
      await selectHost(REMOTE_HOST);
      await click("button", "Home");
      const before = await wait("Waiting for you");
      const row = controls(before.text, "button", "Waiting for you", { contains: true })[0];
      assert.ok(row, "Waiting remote Session row missing before quit");
      const rowLabel = row.match(/- button "(.*?)"/)[1];
      const quit = await call("native-quit");
      assert.match(quit.label, /Quit/);
      await call("native-reopen");
      await wait(`Host: ${REMOTE_HOST}`);
      const reopened = await wait("Waiting for you");
      assert.ok(
        controls(reopened.text, "button", rowLabel).length === 1,
        "Same remote Session row was not recovered",
      );
      await click("button", rowLabel);
      await wait(REOPEN_QUESTION);
      await click("radio", "Proceed", { contains: true });
      await click("button", "Send answer");
      await wait(ANSWER_REPLY);
    },
  );
  await step(
    8,
    "Logs: This Mac and box source buttons, real hostd serving line labelled with box",
    async () => {
      await press("Meta+,");
      await click("button", "Logs", { contains: true, first: true });
      await wait("Sources");
      await click("button", REMOTE_HOST);
      await type("Search", "serving");
      const current = await wait("serving");
      assert.ok(controls(current.text, "button", "This Mac").length === 1);
      assert.ok(controls(current.text, "button", REMOTE_HOST)[0]?.includes("[pressed]"));
      assert.match(current.text, /hostd/);
      assert.ok(current.text.split(REMOTE_HOST).length >= 3, "Host label missing from log row");
    },
  );
  const doctor = await call("doctor");
  assert.ok(doctor.ok, JSON.stringify(doctor));
}

assertAcceptanceRunner();
const reportDir = process.env.VOLLI_SMOKE_REPORT_DIR ?? join(REPO, ".scratch", "cloud-acceptance");
await fs.mkdir(reportDir, { recursive: true });
let failed = false;
try {
  await journey();
} catch (error) {
  failed = true;
  console.error(error.stack);
} finally {
  if (instance) {
    const stopped = await exec(process.execPath, [cli, "stop", instance.id], {
      cwd: REPO,
      timeout: 30_000,
    }).catch((error) => {
      failed = true;
      console.error(error.message);
      return null;
    });
    if (stopped) {
      const manifest = JSON.parse(
        await fs.readFile(join(instance.evidence, "manifest.json"), "utf8"),
      );
      if (
        manifest.keychainViolations.length ||
        manifest.keychainViolationExit ||
        manifest.leftovers.length ||
        manifest.remoteCleanupError
      )
        failed = true;
    }
  }
  await fs.writeFile(
    join(reportDir, "acceptance.json"),
    JSON.stringify(
      {
        commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: REPO })).stdout.trim(),
        complete: results.length === 8 && results.every((row) => row.status === "PASS"),
        failed,
        expectedFailure: EXPECTED_FAILURE,
        instance: instance?.id,
        results,
      },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Remote acceptance\n\n${results.map((row) => `- **${row.status} ${row.step}** ${row.assertion}${row.detail ? ` — ${row.detail.split("\n")[0]}` : ""}`).join("\n")}\n\nXFAIL/BLOCKED is scaffolding, not canary acceptance. The canary SHA requires all eight PASS rows.\n`,
    );
}
process.exitCode = failed ? 1 : 0;
