#!/usr/bin/env node
/**
 * Real MOVE app path through volli-drive, against only the pinned throwaway backend.
 *
 * SETUP: UUID local project/tickets + a stored PNG (fixture `move`), fake model HTTP,
 * preview enrollment, one empty Workspace and an S3-compatible signature-checking bucket.
 * The Session/turn, move, verification and Finish are driven through the real UI.
 * No engine mock, journal patch, clock jump, shortened URL guard or window.api move call.
 * In particular, the production signed-history settling wait (~11 min) runs in full.
 *
 * Run after a VOLLI_CLOUD_LOOPBACK=1 build:
 * node convex/fixture/with-backend.ts --deploy -- node apps/desktop/e2e/volli-drive/cloud-move-acceptance.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { waitUntil } from "../lib/smoke-kit.mjs";
import {
  cloudFixtureFromEnv,
  devAccessToken,
  grantPreview,
  cleanQuitProblems,
} from "./lib/cloud-acceptance.mjs";
import { startTranscriptStore } from "./lib/cloud-transcript-acceptance.mjs";
import { createRegistry, instanceLayout, REPO } from "./lib/core.mjs";
import { MOVE_PROJECT } from "./lib/fixtures.mjs";
import { request } from "./lib/protocol.mjs";
import { visibleControls } from "./lib/remote-acceptance.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const fixture = cloudFixtureFromEnv({ ...process.env, VOLLI_CLOUD_STORAGE_ORIGIN: undefined });
const reportDir =
  process.env.VOLLI_SMOKE_REPORT_DIR ?? join(REPO, ".scratch", "cloud-move-acceptance");
await fs.mkdir(reportDir, { recursive: true });
const proof = {
  startedAt: new Date().toISOString(),
  steps: [],
  doubles: [
    "fake model HTTP",
    "dev sign-in browser",
    "fixture local board and PNG",
    "preview enrollment and empty Workspace",
    "S3-compatible HTTP bucket",
    "supervised restart",
  ],
};
let launched, drive, store;
let failed = false;
const sql = async (query) =>
  JSON.parse(
    (
      await exec(process.execPath, [cli, "state", launched.id, "sql", query], {
        cwd: REPO,
        timeout: 30_000,
      })
    ).stdout,
  );
async function step(label, work) {
  console.log(`START ${label}`);
  const result = await work();
  proof.steps.push({ label, at: new Date().toISOString(), result });
  if (drive) await drive("screenshot", { name: `step-${proof.steps.length}` });
  console.log(`PASS ${label}`);
  await fs.writeFile(join(reportDir, "acceptance.json"), JSON.stringify(proof, null, 2));
  return result;
}
async function action(kind, role, name, extra = {}, options = {}) {
  const snap = await drive("snapshot");
  const hits = visibleControls(snap.text, role, name, options);
  const hit = options.first ? hits[0] : hits.length === 1 ? hits[0] : null;
  assert.ok(hit, `Expected ${role} ${name} once, found ${hits.length}\n${snap.text}`);
  assert.ok(!hit.includes("[disabled]"), `${name} disabled\n${snap.text}`);
  const ref = hit.match(/\[ref=([^\]]+)\]/u)[1];
  return drive("act", { gen: snap.generation, ref, kind, ...extra });
}
const click = (role, name, options) => action("click", role, name, {}, options);
const wait = (text, timeout = 60_000) => drive("wait", { text, timeout });
async function openTicket(key) {
  // Cards have an unnamed button around their visible key. Find that ancestor
  // in one fresh tree; do not invent an accessible label or a snapshot ref.
  const snap = await drive("snapshot");
  const lines = snap.text.split("\n");
  const index = lines.findIndex((line) => line.trimEnd().endsWith(`: ${key}`));
  assert.ok(index >= 0, `Ticket ${key} is visible\n${snap.text}`);
  let indent = lines[index].search(/\S/u);
  let ref;
  for (let at = index - 1; at >= 0; at -= 1) {
    const parentIndent = lines[at].search(/\S/u);
    if (parentIndent >= indent) continue;
    indent = parentIndent;
    if (/^\s*- button \[ref=/u.test(lines[at])) {
      ref = lines[at].match(/\[ref=([^\]]+)\]/u)[1];
      break;
    }
  }
  assert.ok(ref, `Ticket ${key} has an actionable card ancestor`);
  await drive("act", { gen: snap.generation, ref, kind: "click" });
  const fresh = await drive("snapshot");
  await drive("act", { gen: fresh.generation, kind: "press", key: "Enter" });
  await wait("Ticket tabs");
}
const press = (role, name, key, options) => action("press", role, name, { key }, options);
async function assertPreflightCounts() {
  let prepared;
  await waitUntil(
    "the real dry run returns counts or a named refusal",
    async () => {
      prepared = await drive("snapshot");
      return (
        prepared.text.includes("1 attachment (") ||
        prepared.text.includes("Counts unavailable until this problem is resolved.")
      );
    },
    { timeout: 60_000, interval: 500 },
  );
  assert.ok(
    prepared.text.includes("1 attachment ("),
    `Dry run refused the real fixture\n${prepared.text}`,
  );
}
const send = async (text) => {
  await action("type", "textbox", "Message", { text });
  await press("textbox", "Message", "Enter");
  await wait(`fake-agent: ${text}`);
  await drive("wait", { text: "Stop turn", gone: true, timeout: 60_000 });
};
try {
  assert.equal(process.platform, "darwin", "the guarded desktop needs macOS");
  assert.ok(fixture.adminKey, "the pinned local fixture admin key is required");
  await grantPreview({ convexUrl: fixture.convexUrl, adminKey: fixture.adminKey });
  store = await startTranscriptStore(fixture, reportDir);
  const subject = `move-${randomBytes(4).toString("hex")}`;
  const token = devAccessToken({ privateKeyPem: fixture.privateKeyPem, subject });
  const output = await exec(
    process.execPath,
    [
      cli,
      "launch",
      "--fixture",
      "move",
      "--cloud",
      "--cloud-subject",
      subject,
      "--idle-min",
      "40",
      "--no-build",
      "--json",
    ],
    {
      cwd: REPO,
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, VOLLI_CLOUD_STORAGE_ORIGIN: store.endpoint },
    },
  );
  launched = JSON.parse(output.stdout);
  const entry = await createRegistry().get(launched.id);
  const layout = instanceLayout(entry.scratch, entry.evidence);
  drive = (cmd, args = {}) => request(layout.driveSocket, cmd, args, { timeoutMs: 150_000 });
  proof.instance = { id: launched.id, evidence: launched.evidence };
  await step("Local ticket Session and worktree", async () => {
    await wait(MOVE_PROJECT.name);
    await openTicket("MOV-1");
    await click("button", "New chat", { first: true });
    await send("Move proof before the move");
    const sessions = await sql("SELECT id, ticket_id FROM sessions WHERE role='ticket'");
    assert.equal(sessions.length, 1);
    const paths = await sql(
      "SELECT projects.id, projects.path, tickets.worktree_path FROM projects LEFT JOIN tickets ON tickets.project_id=projects.id WHERE projects.id='" +
        MOVE_PROJECT.id +
        "' AND tickets.ticket_number=1",
    );
    assert.ok(paths[0]?.worktree_path, "the local ticket's Working copy exists before handover");
    proof.sessionId = sessions[0].id;
    proof.beforePaths = paths;
    return { sessionId: sessions[0].id, hasWorktree: true };
  });
  await step("Quiet project-menu entry and single-project dry run", async () => {
    await press("button", "MP", "Shift+F10", { first: true });
    await click("menuitem", "Move to Volli Cloud…");
    await assertPreflightCounts();
    await drive("screenshot", { name: "project-menu-preflight" });
    await click("button", "Cancel");
    assert.deepEqual(
      await sql("SELECT move_id FROM cloud_moves"),
      [],
      "the dry run starts no move",
    );
    return { entry: "project menu", dryRunOnly: true };
  });
  await step("Sign in, without leaving the local launch", async () => {
    await click("button", "Settings", { first: true });
    await wait("Settings categories");
    await click("button", "Account", { first: true });
    await click("checkbox", "Accept Preview Agreement");
    const since = Date.now();
    await click("button", "Continue with GitHub");
    await drive("cloud-sign-in-browser", { since });
    await wait("Restart to open Volli Cloud");
    const client = new ConvexHttpClient(fixture.convexUrl);
    client.setAuth(token);
    const spaces = await client.query(makeFunctionReference("workspaces:listMine"), {});
    const workspaceId = spaces[0]?.workspaceId ?? randomUUID();
    if (spaces.length === 0)
      await client.mutation(makeFunctionReference("workspaces:create"), {
        workspaceId,
        name: "Move proof Workspace",
      });
    proof.workspaceId = workspaceId;
    return { stillLocal: true };
  });
  await step("Settings Move all preflight and real move", async () => {
    await click("button", "Volli Cloud", { first: true });
    await click("button", "Move all projects…");
    await wait("Stop at the first problem");
    await assertPreflightCounts();
    await waitUntil(
      "Move is ready after the Workspace-bound dry run",
      async () =>
        visibleControls((await drive("snapshot")).text, "button", "Move").some(
          (control) => !control.includes("[disabled]"),
        ),
      { timeout: 60_000, interval: 500 },
    );
    await click("button", "Move");
    await wait("Moves to Volli Cloud");
    let terminal;
    await waitUntil(
      "the engine reaches its real result",
      async () => {
        // Fresh UI read, then read-only journal evidence. No patched facts or clock.
        await drive("snapshot");
        const rows = await sql(
          "SELECT m.state,m.paused,m.failure_json,m.report_json,q.state AS queue_state,q.profile_step FROM cloud_moves m JOIN cloud_move_queues q USING(queue_id) ORDER BY m.created_at DESC LIMIT 1",
        );
        if (rows.length === 0) return false;
        const row = rows[0];
        const failure = row.failure_json === null ? null : JSON.parse(row.failure_json);
        if (
          failure !== null ||
          row.paused !== null ||
          row.queue_state === "stopped" ||
          row.state === "rolled_back"
        ) {
          terminal = row;
          return true;
        }
        return row.state === "checked";
      },
      { timeout: 35 * 60_000, interval: 15_000 },
    );
    // waitUntil retries thrown predicates; assert irreversible failures outside it.
    proof.terminal = terminal;
    assert.equal(terminal, undefined, `Engine stopped: ${JSON.stringify(terminal)}`);
    await wait("Finish move");
    const result = (
      await sql(
        "SELECT state, report_json, journal_json FROM cloud_moves ORDER BY created_at DESC LIMIT 1",
      )
    )[0];
    assert.equal(JSON.parse(result.report_json).ok, true);
    assert.ok(JSON.parse(result.journal_json).handover.workingCopies.length > 0);
    proof.moveResult = result;
    return { state: result.state, checksPassed: true };
  });
  await step("Finish and reopen through the real cloud board", async () => {
    await click("button", "Finish move");
    await wait("Moved to Volli Cloud");
    assert.equal(
      (await sql("SELECT state FROM cloud_moves ORDER BY created_at DESC LIMIT 1"))[0].state,
      "confirmed",
    );
    await drive("restart", { reason: "Open the moved project in Volli Cloud (supervised)" });
    await wait(MOVE_PROJECT.name);
    await click("button", "Home", { first: true });
    await openTicket("MOV-1");
    await wait("move-proof.png");
    await click("button", "Move proof before the move", { contains: true, first: true });
    await wait("fake-agent: Move proof before the move");
    const after = await sql(
      "SELECT projects.id, projects.path, tickets.worktree_path FROM projects LEFT JOIN tickets ON tickets.project_id=projects.id WHERE projects.id='" +
        MOVE_PROJECT.id +
        "' AND tickets.ticket_number=1",
    );
    assert.deepEqual(
      after,
      proof.beforePaths,
      "handover reused the existing folder and Working copy",
    );
    return { transcriptRead: true, attachmentListed: true, foldersReused: true };
  });
  await step("Resume the moved Session and create another Session", async () => {
    await send("Move proof after the move");
    await click("button", "New chat", { first: true });
    await send("New cloud Session after move");
    return { resumed: true, newSession: true };
  });
  const doctor = await drive("doctor");
  assert.ok(doctor.ok, JSON.stringify(doctor.problems));
  assert.deepEqual(store.problems, []);
  proof.requests = store.requests;
} catch (error) {
  failed = true;
  proof.error = error.stack;
  console.error(error.stack);
  if (drive) await drive("screenshot", { name: "failed" }).catch(() => {});
} finally {
  if (launched) {
    await exec(process.execPath, [cli, "stop", launched.id], { cwd: REPO, timeout: 120_000 }).catch(
      (error) => {
        failed = true;
        proof.stopError = error.message;
      },
    );
    const manifest = await fs
      .readFile(join(launched.evidence, "manifest.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        failed = true;
        proof.manifestError = error.message;
        return {};
      });
    proof.cleanup = {
      scratchRemoved: manifest.scratchRemoved,
      keychainViolations: manifest.keychainViolations,
      leftovers: manifest.leftovers,
      close: cleanQuitProblems(manifest.electron?.close),
    };
    if (
      !manifest.scratchRemoved ||
      manifest.keychainViolations?.length !== 0 ||
      manifest.leftovers?.length !== 0 ||
      proof.cleanup.close.length !== 0
    )
      failed = true;
  }
  if (store) {
    proof.storeCleanup = await store.close();
    if (proof.storeCleanup.problems.length > 0) failed = true;
  }
  proof.finishedAt = new Date().toISOString();
  proof.passed = !failed;
  await fs.writeFile(join(reportDir, "acceptance.json"), JSON.stringify(proof, null, 2));
}
process.exitCode = failed ? 1 : 0;
