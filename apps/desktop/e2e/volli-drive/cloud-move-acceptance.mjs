#!/usr/bin/env node
/**
 * Real MOVE app path through volli-drive, against only the pinned throwaway backend.
 *
 * SETUP: UUID local project/tickets + PNG + Automation definitions (fixture `move`), fake model HTTP,
 * preview enrollment, one empty Workspace and an S3-compatible signature-checking bucket.
 * The Session/turn, move, verification, Finish, explicit re-arm and Go back to local are driven
 * through the real UI. A passing journey ends returned, with the cloud copy kept.
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
    "fixture local board, PNG and disabled Automation definitions",
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
  // Inert background controls can retain their name but have no actionable
  // ref. Only a control the fresh snapshot permits us to act on can match.
  const hits = visibleControls(snap.text, role, name, options).filter((line) =>
    line.includes("[ref="),
  );
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
  // A reopened ticket remembers its last Session tab. The card's Enter opens
  // the ticket surface, not necessarily its body, so select the actual ticket.
  await click("tab", key);
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
async function waitForEngine(label, predicate, deadline) {
  let latest;
  let terminal;
  await waitUntil(
    label,
    async () => {
      // Fresh UI read, then read-only journal evidence. No patched facts or clock.
      await drive("snapshot");
      const rows = await sql(
        "SELECT m.state,m.paused,m.failure_json,m.report_json,q.state AS queue_state FROM cloud_moves m JOIN cloud_move_queues q USING(queue_id) ORDER BY m.created_at DESC LIMIT 1",
      );
      if (rows.length === 0) return false;
      latest = rows[0];
      const failure = latest.failure_json === null ? null : JSON.parse(latest.failure_json);
      if (
        failure !== null ||
        (latest.paused !== null && latest.paused !== "network") ||
        latest.queue_state === "stopped" ||
        latest.state === "rolled_back" ||
        (latest.state === "checked" && JSON.parse(latest.report_json)?.ok !== true)
      ) {
        terminal = latest;
        return true;
      }
      return latest.paused === null && predicate(latest);
    },
    { timeout: Math.max(1, deadline - performance.now()), interval: 5_000 },
  );
  // waitUntil retries thrown predicates; assert irreversible failures outside it.
  proof.terminal = terminal;
  assert.equal(terminal, undefined, `Engine stopped: ${JSON.stringify(terminal)}`);
  return latest;
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
  const cloud = new ConvexHttpClient(fixture.convexUrl);
  cloud.setAuth(token);
  const read = (name, args) => cloud.query(makeFunctionReference(name), args);
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
          (control) => control.includes("[ref=") && !control.includes("[disabled]"),
        ),
      { timeout: 60_000, interval: 500 },
    );
    await click("button", "Move");
    const deadline = performance.now() + 35 * 60_000;
    await wait("Moves to Volli Cloud");
    await waitForEngine(
      "the engine reaches its history settling wait",
      (row) => row.state === "history",
      deadline,
    );
    await wait("Waiting for file uploads to settle before checking.");
    await click("button", "Pause");
    await wait("Resume");
    await waitUntil(
      "Pause is durable after its worker stops",
      async () => {
        const paused = (
          await sql(
            "SELECT m.paused,q.state FROM cloud_moves m JOIN cloud_move_queues q USING(queue_id) ORDER BY m.created_at DESC LIMIT 1",
          )
        )[0];
        return paused?.paused === "paused" && paused.state === "stopped";
      },
      { timeout: 60_000, interval: 500 },
    );
    await drive("screenshot", { name: "durable-pause" });
    await click("button", "Resume");
    await waitUntil(
      "Resume restarts the durable queue",
      async () => {
        const resumed = (
          await sql(
            "SELECT m.paused,m.failure_json,q.state FROM cloud_moves m JOIN cloud_move_queues q USING(queue_id) ORDER BY m.created_at DESC LIMIT 1",
          )
        )[0];
        return (
          resumed?.state === "running" ||
          (resumed?.failure_json != null && JSON.parse(resumed.failure_json) !== null)
        );
      },
      { timeout: 60_000, interval: 500 },
    );
    await waitForEngine(
      "the engine resumes",
      (row) => row.state === "history" || row.state === "checked",
      deadline,
    );
    await click("button", "Close");
    await wait("Move Project is read-only while it moves to Volli Cloud.");
    await click("button", "Home", { first: true });
    const navigation = await drive("snapshot");
    assert.ok(
      visibleControls(navigation.text, "button", "Move to Volli Cloud progress").length === 1,
    );
    assert.ok(navigation.text.includes("Move Project is read-only while it moves to Volli Cloud."));
    await drive("screenshot", { name: "read-only-banner-and-durable-row" });
    await click("button", "Move to Volli Cloud progress");
    await wait("Moves to Volli Cloud");
    proof.recovery = {
      pauseDurable: true,
      resumed: true,
      banner: true,
      rowSurvivedNavigation: true,
    };
    await waitForEngine(
      "the engine reaches its real result",
      (row) => row.state === "checked",
      deadline,
    );
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
  await step("Finish keeps moved Automations paused", async () => {
    await click("button", "Finish move");
    await wait("Moved to Volli Cloud");
    const moved = (
      await sql("SELECT move_id,state FROM cloud_moves ORDER BY created_at DESC LIMIT 1")
    )[0];
    assert.equal(moved.state, "confirmed");
    proof.confirmed = true;
    proof.moveId = moved.move_id;
    const names = launched.seeded.automations;
    const list = await read("projectImports:rearmList", { moveId: proof.moveId });
    assert.deepEqual(list.columns, [
      { automationId: names.columnId, name: "Move column proof", status: "done" },
    ]);
    assert.deepEqual(list.schedules, [
      { automationId: names.scheduleId, name: "Move schedule proof" },
    ]);
    assert.deepEqual(list.inertGlobals, [{ id: names.personalId, name: "Move personal proof" }]);
    const columns = await read("automations:armings", { projectId: MOVE_PROJECT.id });
    const schedules = await read("automations:schedules", { projectId: MOVE_PROJECT.id });
    assert.equal(columns[0]?.pausedReason, "moved");
    assert.equal(schedules[0]?.pausedReason, "moved");
    assert.deepEqual(
      (
        await read("automations:runsForProject", {
          projectId: MOVE_PROJECT.id,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page,
      [],
      "moving starts no Automation work",
    );
    await click("button", "Paused Automations", { contains: true });
    await wait("Open in Volli Cloud to re-arm on this Mac.");
    const local = await drive("snapshot");
    const buttons = visibleControls(local.text, "button", "Re-arm", { contains: true });
    assert.equal(buttons.length, 2);
    assert.ok(
      buttons.every((line) => line.includes("[disabled]")),
      "a registration-only runner must not re-arm",
    );
    assert.equal(local.text.match(/Move personal proof · Not armed/gu)?.length, 1);
    return { list, pausedWithoutStarting: true, localRearmDisabled: true };
  });
  await step("Re-arm moved Automations explicitly on this Mac", async () => {
    await drive("restart", { reason: "Open the moved project in Volli Cloud (supervised)" });
    await wait(MOVE_PROJECT.name);
    await click("button", "Settings", { first: true });
    await wait("Settings categories");
    await click("button", "Volli Cloud", { first: true });
    await click("button", "Progress and local copies");
    await wait("Paused Automations");
    await click("button", "Paused Automations", { contains: true });
    await waitUntil(
      "this Mac's real full runner can re-arm",
      async () => {
        const snap = await drive("snapshot");
        const button = visibleControls(
          snap.text,
          "button",
          "Re-arm Move column proof on this Mac (Done)",
        )[0];
        if (button?.includes("[ref=") && !button.includes("[disabled]")) return true;
        if (
          visibleControls(snap.text, "button", "Try again").some(
            (line) => line.includes("[ref=") && !line.includes("[disabled]"),
          )
        )
          await click("button", "Try again");
        return false;
      },
      { timeout: 60_000, interval: 1_000 },
    );
    const current = await drive("cloud-state");
    assert.ok(current.runnerId, "the cloud launch has a real full MacRunner");
    const runners = await read("runners:list", {});
    const runner = runners.find((item) => item.id === current.runnerId);
    assert.equal(runner?.kind, "mac");
    assert.ok(runner.capabilities.tools.includes("automation.run"));
    await drive("screenshot", { name: "paused-automations-ready-on-this-mac" });
    const names = launched.seeded.automations;
    await click("button", "Re-arm Move column proof on this Mac (Done)");
    let columns;
    await waitUntil(
      "the ordinary column arm receipt is visible",
      async () => {
        columns = await read("automations:armings", { projectId: MOVE_PROJECT.id });
        return columns.some(
          (item) =>
            item.automationId === names.columnId &&
            item.runnerId === current.runnerId &&
            item.pausedAt == null,
        );
      },
      { timeout: 30_000, interval: 250 },
    );
    const afterColumn = await read("projectImports:rearmList", { moveId: proof.moveId });
    assert.deepEqual(afterColumn.columns, []);
    assert.deepEqual(
      afterColumn.schedules.map((item) => item.automationId),
      [names.scheduleId],
    );
    await click("button", "Re-arm Move schedule proof schedule on this Mac");
    let schedules;
    await waitUntil(
      "the ordinary schedule arm receipt is visible",
      async () => {
        schedules = await read("automations:schedules", { projectId: MOVE_PROJECT.id });
        return schedules.some(
          (item) =>
            item.automationId === names.scheduleId &&
            item.runnerId === current.runnerId &&
            item.pausedAt == null,
        );
      },
      { timeout: 30_000, interval: 250 },
    );
    const after = await read("projectImports:rearmList", { moveId: proof.moveId });
    assert.deepEqual(after.columns, []);
    assert.deepEqual(after.schedules, []);
    assert.deepEqual(
      (
        await read("automations:runsForProject", {
          projectId: MOVE_PROJECT.id,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page,
      [],
      "arming neither replays old arrivals nor runs a future schedule early",
    );
    assert.deepEqual(after.inertGlobals, [{ id: names.personalId, name: "Move personal proof" }]);
    await drive("wait", { text: "Paused Automations", gone: true, timeout: 30_000 });
    const result = await drive("snapshot");
    assert.equal(result.text.match(/Move personal proof · Not armed/gu)?.length, 1);
    assert.equal(visibleControls(result.text, "button", "Re-arm", { contains: true }).length, 0);
    await drive("screenshot", { name: "explicit-rearm-result-and-inert-personal-definition" });
    await click("button", "Close");
    return { runnerId: current.runnerId, columns, schedules, inertGlobals: after.inertGlobals };
  });
  await step("Read moved history and attachments through the real cloud board", async () => {
    await click("button", "Home", { first: true });
    await openTicket("MOV-1");
    // Monaco's body image is a decoration rather than accessible text. Use
    // the real comment viewer to render the moved attachment and to leave a
    // cloud-side change that Go back must preserve in its readable export.
    await action("type", "textbox", "Add a comment", {
      text: "Cloud comment after move.\n\n![Moved attachment](.volli/attachments/move-proof.png)",
    });
    await press("textbox", "Add a comment", "Meta+Enter");
    await wait("Cloud comment after move.");
    const imageHash = launched.seeded.attachment.blobHash;
    await waitUntil(
      "the moved attachment renders through the cloud reader",
      async () => {
        const image = await drive("snapshot");
        return (
          image.text.includes('img "Moved attachment"') &&
          !image.text.includes("Image could not be loaded") &&
          store.requests.some(
            (item) =>
              item.method === "GET" &&
              item.sha256 === imageHash &&
              item.origin === "volli-app://bundle",
          )
        );
      },
      { timeout: 60_000, interval: 500 },
    );
    await drive("screenshot", { name: "moved-attachment-rendered" });
    const image = await drive("snapshot");
    assert.ok(image.text.includes('img "Moved attachment"'));
    assert.ok(!image.text.includes("Image could not be loaded"));
    // This fixture has exactly one Session. Its auto-title comes from the
    // ticket, not the first message; choose the actual Session list entry.
    await click("button", "azure-openai-responses · Idle", { contains: true, first: true });
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
    return { transcriptRead: true, attachmentRendered: true, foldersReused: true };
  });
  let sessionWriteError;
  try {
    await step("Resume the moved Session and create another Session", async () => {
      await send("Move proof after the move");
      await click("button", "New chat", { first: true });
      await send("New cloud Session after move");
      return { resumed: true, newSession: true };
    });
  } catch (error) {
    // Keep the actual failure, but still prove the escape hatch on this same
    // moved project. The whole journey remains failed if either path fails.
    sessionWriteError = error;
    proof.sessionWriteError = error.stack;
    await drive("screenshot", { name: "cloud-session-write-failed" });
  }
  await step("Go back to local keeps the cloud copy and saves a readable export", async () => {
    await click("button", "Settings", { first: true });
    await wait("Settings categories");
    await click("button", "Volli Cloud", { first: true });
    await click("button", "Progress and local copies");
    await click("button", "Go back to local");
    await wait("Volli Cloud keeps its copy.");
    await drive("screenshot", { name: "go-back-confirmation-and-export-location" });
    await click("button", "Go back to local");
    await wait("Cloud changes saved to:");
    const returned = (
      await sql("SELECT state,journal_json FROM cloud_moves ORDER BY created_at DESC LIMIT 1")
    )[0];
    assert.equal(returned.state, "returned");
    const directory = await fs.realpath(JSON.parse(returned.journal_json).returnedExport);
    assert.ok(directory.startsWith((await fs.realpath(entry.scratch)) + "/"));
    const saved = JSON.parse(await fs.readFile(join(directory, "cloud-changes.json"), "utf8"));
    assert.equal(saved.format, "volli.cloud-changes/1");
    assert.match(
      await fs.readFile(join(directory, "cloud-changes.md"), "utf8"),
      /Changes made in Volli Cloud/u,
    );
    assert.match(
      await fs.readFile(join(directory, "cloud-changes.md"), "utf8"),
      /Cloud comment after move\./u,
    );
    const client = new ConvexHttpClient(fixture.convexUrl);
    client.setAuth(token);
    const retained = await client.query(makeFunctionReference("projects:get"), {
      projectId: MOVE_PROJECT.id,
    });
    assert.equal(retained.id, MOVE_PROJECT.id);
    const cursors = await sql(
      "SELECT session_id FROM session_drain_cursors WHERE session_id='" + proof.sessionId + "'",
    );
    assert.deepEqual(cursors, []);
    return {
      localUnlocked: true,
      cloudCopyRetained: true,
      readableExport: true,
      movedCursorReleased: true,
    };
  });
  if (sessionWriteError !== undefined) throw sessionWriteError;
  const doctor = await drive("doctor");
  assert.ok(doctor.ok, JSON.stringify(doctor.problems));
  assert.deepEqual(store.problems, []);
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
    proof.requests = store.requests;
    proof.storeCleanup = await store.close();
    if (proof.storeCleanup.problems.length > 0) failed = true;
  }
  proof.finishedAt = new Date().toISOString();
  proof.passed = !failed;
  await fs.writeFile(join(reportDir, "acceptance.json"), JSON.stringify(proof, null, 2));
}
process.exitCode = failed ? 1 : 0;
