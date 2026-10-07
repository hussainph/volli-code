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
import { waitUntil } from "../lib/smoke-kit.mjs";
import {
  ANSWER_QUESTION,
  ANSWER_REPLY,
  REOPEN_QUESTION,
  REOPEN_REPLY,
  snapshotSubtree,
  visibleControls as controls,
  hasActionableControl,
  stableWaitingLabel,
  visibleServingRow,
  visibleAnswerReceipt,
  REMOTE_HOST,
  REMOTE_PROJECT,
  STREAM_REPLY,
  assertAcceptanceRunner,
  assertAcceptanceCleanup,
  projectCreationOutcome,
  acceptanceHostAddState,
} from "./lib/remote-acceptance.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const TITLE = "Cloud acceptance ticket";
const LOCAL_KEEPALIVE = "[slow:120000] local-menu-bar-keepalive";
const results = [];
let localKeepaliveStarted = false;
let nativeQuitAttempted = false;
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
async function action(kind, role, name, extra = {}, options = {}) {
  const current = await snap();
  const surface = options.scope
    ? snapshotSubtree(current.text, options.scope.role, options.scope.name)
    : current.text;
  const hits = controls(surface, role, name, options);
  const hit = options.first ? hits[0] : hits.length === 1 ? hits[0] : null;
  assert.ok(hit, `Expected ${role} "${name}" once; found ${hits.length}\n${current.text}`);
  assert.ok(!hit.includes("[disabled]"), `${name} is disabled`);
  const ref = hit.match(/\[ref=([^\]]+)\]/)[1];
  return (await call("act", { gen: current.generation, ref, kind, ...extra })).snapshot;
}
const click = (role, name, options) => action("click", role, name, {}, options);
const type = (name, text) => action("type", "textbox", name, { text });
async function selectProceed() {
  // Native radios are visually hidden beneath their label's custom disc.
  // Space selects the real focused input without bypassing pointer checks.
  const selected = await action("press", "radio", "Proceed", { key: "Space" });
  assert.match(controls(selected.text, "radio", "Proceed")[0] ?? "", /\[checked\]/u);
}
async function submitProceed(question) {
  await click("button", "Submit", { scope: { role: "form", name: question } });
  // This fixture's declared Stop draws a verdict card. Its receipt is the
  // durable transcript row, not the ask-user card's transient Sent line.
  await waitUntil(
    `durable Proceed receipt for ${question}`,
    async () => visibleAnswerReceipt((await snap()).text, question, "Proceed"),
    { timeout: 10_000, interval: 100 },
  );
}
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
  await wait("Switch host");
}
const SWITCHER = { scope: { role: "dialog", name: "Switch host" }, contains: true, first: true };
async function selectHost(name) {
  if (controls((await snap()).text, "button", `Host: ${name}`, { contains: true }).length === 1)
    return;
  await hostChip();
  await click("button", name, SWITCHER);
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
async function stopLocalKeepalive() {
  if (!localKeepaliveStarted) return;
  if (nativeQuitAttempted) {
    await call("native-reopen");
    nativeQuitAttempted = false;
  }
  await selectHost("This Mac");
  // The sidebar's No ticket row names this synthetic Session. A title-only
  // match also hits its Close tab button, which does not interrupt the turn.
  await click("button", "local-menu-bar-keepalive No ticket", { contains: true });
  await wait(LOCAL_KEEPALIVE);
  await click("button", "Stop turn");
  await call("wait", { text: "Stop turn", gone: true });
  localKeepaliveStarted = false;
}
async function step(number, assertion, body) {
  try {
    const result = await body();
    await shot(`step-${number}`);
    record(number, result?.status ?? "PASS", assertion, result?.detail ?? "");
    return result;
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
    let ready;
    await waitUntil(
      "host ready, answering the optional VC-724 self-add confirmation",
      async () => {
        const current = await snap();
        const state = acceptanceHostAddState(current.text, REMOTE_HOST);
        if (state === "self-add") {
          await shot("step-1-self-add-question");
          await click("button", "Add anyway");
          return false;
        }
        if (state !== "ready") return false;
        ready = current;
        return true;
      },
      { timeout: 120_000, interval: 200 },
    );
    assert.match(ready.text, /Volli host/);
    assert.ok(ready.text.includes(`Starts when you log in to ${REMOTE_HOST}`));
    await shot("step-1-ready");
    await click("button", "Done");
    // AM2 replaces the transient pairing checklist with a stable ready view.
    // Prove the saved pairing in Settings, where the host reads its real
    // enrolled devices over SSH and marks this device as This Mac.
    await click("button", "Settings");
    await wait("Settings categories");
    await click("button", "Hosts");
    await click("button", REMOTE_HOST, { contains: true, first: true });
    await wait("Paired devices");
    await waitUntil(
      "This Mac's enrolled-device row",
      async () => {
        const devices = (await snap()).text.split("Paired devices").at(-1);
        return devices.includes("This Mac") && /Paired [^\n]*\d/u.test(devices);
      },
      { timeout: 30_000, interval: 200 },
    );
    // drive screenshots capture the viewport, not the full Settings scroller.
    // Hovering the footer scrolls it into view; wheel down there reaches the
    // pane's bottom, framing Paired devices + This Mac immediately above it.
    // Never click Forget: this is only a real UI scroll for the evidence frame.
    await action("scroll", "button", "Forget…", { direction: "down" });
    await shot("step-1-paired-device");
    await click("button", "Home");
  });

  await step(
    2,
    "New project on host: folder path, Create and open, selected remote Host chip",
    async () => {
      // Only benign Git box state is arranged. Project registration is UI-only.
      await call("acceptance-arrange-box");
      await click("button", "Settings");
      await wait("Settings categories");
      await click("button", "Hosts");
      await click("button", REMOTE_HOST, { contains: true, first: true });
      await wait("New project…");
      await click("button", "New project…");
      await wait(`New project on ${REMOTE_HOST}`);
      await type(`Git URL or folder on ${REMOTE_HOST}`, fixture.projectPath);
      await type("Name (optional)", REMOTE_PROJECT);
      await click("button", "Create and open");
      const refusal = `${REMOTE_HOST} runs Volli as your login, so this Mac can't add projects to it.`;
      const opened = `Opened ${REMOTE_PROJECT} on ${REMOTE_HOST}`;
      let current;
      await waitUntil(
        "project opens (the old user-install refusal is a failure)",
        async () => {
          current = await snap();
          return current.text.includes(opened) || current.text.includes(refusal);
        },
        { timeout: 90_000, interval: 200 },
      );
      assert.equal(
        projectCreationOutcome(current.text, {
          hostName: REMOTE_HOST,
          projectName: REMOTE_PROJECT,
        })?.status,
        "PASS",
        "The folder project must open through production UI registration",
      );
      // The success toast arrives before the project's dialog has finished
      // exiting. Wait for navigation's real accessibility name/ref to return;
      // text behind a still-modal dialog is not an actionable Home button.
      await waitUntil(
        "project dialog exits and Home is actionable",
        async () => hasActionableControl((await snap()).text, "button", "Home"),
        { timeout: 10_000, interval: 100 },
      );
      await click("button", "Home");
      await selectHost(REMOTE_HOST);
      const selected = await wait(REMOTE_PROJECT);
      assert.match(selected.text, new RegExp(`Host: ${REMOTE_HOST}`));
    },
  );
  await call("acceptance-model");
  await wait(`Host: ${REMOTE_HOST}`);
  await step(3, "Create/move ticket: Backlog then Todo, persisted after UI reopen", async () => {
    await click("button", "Home");
    // Operator configuration restarts hostd. The host chip keeps its name
    // throughout that outage; only the enabled write control proves rejoin.
    await waitUntil(
      "Workspace rejoins after model deployment and New ticket is actionable",
      async () => hasActionableControl((await snap()).text, "button", "New ticket"),
      { timeout: 10_000, interval: 100 },
    );
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
  await step(
    4,
    "Paste fake API key and choose the box default through Models on host",
    async () => {
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
      await waitUntil(
        "sign-in sheet exits and the host chip is actionable",
        async () => hasActionableControl((await snap()).text, "button", `Host: ${REMOTE_HOST}`),
        { timeout: 10_000, interval: 100 },
      );
      await hostChip();
      await click("button", `Models on ${REMOTE_HOST}…`);
      const modelScope = { scope: { role: "dialog", name: `Models on ${REMOTE_HOST}` } };
      await waitUntil(
        "the box catalog offers its unconfigured Board default",
        async () => {
          const tree = (await snap()).text;
          return (
            controls(tree, "dialog", `Models on ${REMOTE_HOST}`).length === 1 &&
            hasActionableControl(
              snapshotSubtree(tree, "dialog", `Models on ${REMOTE_HOST}`),
              "combobox",
              "Choose a model",
            )
          );
        },
        { timeout: 10_000, interval: 100 },
      );
      await click("combobox", "Choose a model", modelScope);
      await click("option", "GPT-4.1 mini");
      await waitUntil(
        "the box saved its selected default",
        async () =>
          hasActionableControl(
            snapshotSubtree((await snap()).text, "dialog", `Models on ${REMOTE_HOST}`),
            "combobox",
            "GPT-4.1 mini",
          ),
        { timeout: 10_000, interval: 100 },
      );
      await shot("step-4-model-default");
      await press("Escape");
      await waitUntil(
        "model sheet exits and the host chip is actionable",
        async () => hasActionableControl((await snap()).text, "button", `Host: ${REMOTE_HOST}`),
        { timeout: 10_000, interval: 100 },
      );
    },
  );
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
    await selectProceed();
    await submitProceed(ANSWER_QUESTION);
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
      localKeepaliveStarted = true;
      await send(LOCAL_KEEPALIVE);
      await wait("Stop turn");
      await selectHost(REMOTE_HOST);
      await click("button", "Home");
      const before = await wait("Waiting for you");
      const row = controls(before.text, "button", "Waiting for you", { contains: true })[0];
      assert.ok(row, "Waiting remote Session row missing before quit");
      const rowLabel = stableWaitingLabel(row);
      nativeQuitAttempted = true;
      const quit = await call("native-quit");
      assert.match(quit.label, /Quit/);
      assert.equal(quit.nativeWindows.visible, 0);
      await call("native-reopen");
      nativeQuitAttempted = false;
      await wait(`Host: ${REMOTE_HOST}`);
      const reopened = await wait("Waiting for you");
      const recovered = controls(reopened.text, "button", "Waiting for you", {
        contains: true,
      }).filter((line) => stableWaitingLabel(line) === rowLabel);
      assert.equal(recovered.length, 1, "Same remote Session row was not recovered");
      await call("act", {
        gen: reopened.generation,
        ref: recovered[0].match(/\[ref=([^\]]+)\]/u)[1],
        kind: "click",
      });
      await wait(REOPEN_QUESTION);
      await selectProceed();
      await submitProceed(REOPEN_QUESTION);
      await wait(REOPEN_REPLY);
      await stopLocalKeepalive();
      await selectHost(REMOTE_HOST);
    },
  );
  await step(
    8,
    "Logs: This Mac and box source buttons, real hostd serving line labelled with box",
    async () => {
      await click("button", "Settings");
      await wait("Settings categories");
      await click("button", "Logs", { contains: true, first: true });
      await wait("Sources");
      await click("button", REMOTE_HOST);
      await type("Search", "serving");
      const current = await wait('button "serving');
      assert.ok(controls(current.text, "button", "This Mac").length === 1);
      assert.ok(controls(current.text, "button", REMOTE_HOST)[0]?.includes("[pressed]"));
      assert.ok(
        visibleServingRow(current.text, REMOTE_HOST),
        "Real serving row must name hostd and the remote machine, not just the Search input",
      );
    },
  );
  const doctor = await call("doctor");
  assert.ok(doctor.ok, JSON.stringify(doctor));
}

assertAcceptanceRunner();
const reportDir = process.env.VOLLI_SMOKE_REPORT_DIR ?? join(REPO, ".scratch", "cloud-acceptance");
await fs.mkdir(reportDir, { recursive: true });
let failed = false;
let cleanupVerified = false;
let cleanupError = null;
try {
  await journey();
} catch (error) {
  failed = true;
  console.error(error.stack);
  for (let n = 1; n <= 8; n++) {
    if (!results.some((row) => row.step === n))
      record(n, "BLOCKED", "Not run", "Earlier action or deployment prerequisite failed");
  }
} finally {
  if (instance) {
    // Retire only this journey's local live-work holder through the UI even
    // on failure; an ordinary quit must not be forced over its running turn.
    await stopLocalKeepalive().catch((error) => {
      failed = true;
      cleanupError = `Local keepalive retirement failed: ${error.message}`;
      console.error(cleanupError);
    });
    const stopped = await exec(process.execPath, [cli, "stop", instance.id], {
      cwd: REPO,
      timeout: 120_000,
    }).catch((error) => {
      failed = true;
      cleanupError = error.message;
      console.error(cleanupError);
      return null;
    });
    if (stopped) {
      const manifest = await fs
        .readFile(join(instance.evidence, "manifest.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      try {
        assertAcceptanceCleanup(manifest);
        cleanupVerified = true;
      } catch (error) {
        failed = true;
        cleanupError = error.message;
        console.error(cleanupError);
      }
    }
  }
  await fs.writeFile(
    join(reportDir, "acceptance.json"),
    JSON.stringify(
      {
        commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: REPO })).stdout.trim(),
        complete:
          !failed &&
          cleanupVerified &&
          results.length === 8 &&
          results.every((row) => row.status === "PASS"),
        failed,
        cleanupVerified,
        cleanupError,
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
      `## Remote acceptance\n\n${results.map((row) => `- **${row.status} ${row.step}** ${row.assertion}${row.detail ? ` — ${row.detail.split("\n")[0]}` : ""}`).join("\n")}\n\nCleanup: ${cleanupVerified ? "PASS" : "FAIL"}${cleanupError ? ` — ${cleanupError.split("\n")[0]}` : ""}. The canary SHA requires all eight PASS rows, verified graceful disposal and complete:true in acceptance.json.\n`,
    );
}
process.exitCode = failed ? 1 : 0;
