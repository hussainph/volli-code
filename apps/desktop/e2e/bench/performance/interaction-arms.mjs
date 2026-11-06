/**
 * The interactions the 2026-11 stutter audit found the matrix missing
 * (VC-1093): switching workspace (project), a fleet of Sessions storming the
 * app with activity, and typing a draft while that storm runs.
 *
 * Each one drives a production path end to end in the built app — no lab
 * page, no store poked from outside:
 *
 * - **Workspace switch** is ⌘N (`use-project-shortcuts.ts`), the path that
 *   marks `workspace-switch` for the renderer's stall labels. A second, small
 *   project is created through the app's own `projects.create` so the fixture
 *   keeps one project and its bytes do not change.
 * - **Fleet storm** is VC-1078's activity storm (`sidebar-store-bench.mjs`:
 *   N running Sessions, one push each every 60 ms, four seconds) moved from the
 *   lab into the real app. Each push is `sessions.setRead` — main reads the
 *   Session through the engine, writes its receipt to SQLite, rebuilds its
 *   listing row and broadcasts it on `volli:session-activity`, the same
 *   broadcast a running Session's durable facts drive. So the storm costs main
 *   what activity costs main, and every window takes the row through its
 *   shipped intake. At owner scale (`--preset owner`, 5,034 Sessions) the rows
 *   land in a fleet that size.
 * - **Draft typing under load** types into a new chat's composer on the long
 *   chat's ticket while a storm runs, measuring each keystroke from its `keydown` to the frame after
 *   it painted.
 *
 * The runner passes its own helpers in (`kit`) so there is one definition of
 * a measured window, a drawn board and a settled frame.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { makeGitRepo, openNewChatTab, TICKET_TAB_STRIP } from "../../lib/smoke-kit.mjs";
import { fixtureSessionId } from "./fixture.mjs";

/** VC-1078's storm shape: streams, one push each per interval, for this long. */
export const STORM_DEFAULTS = Object.freeze({ sessions: 16, intervalMs: 60, durationMs: 4_000 });
/** What the draft-typing arm types: fixed, so every sample types the same keys. */
export const DRAFT_TEXT = "Typing a draft while the fleet runs 0123456789.";
/** The delay between keystrokes: a quick typist, ~25 keys a second. */
export const DRAFT_KEY_DELAY_MS = 40;
const TICKET_STRIP_TABS = '[role="tablist"][aria-label="Ticket tabs"] [role="tab"]';
const SECOND_WORKSPACE = Object.freeze({
  name: "Perf Second Workspace",
  ticket: "Second workspace",
});

/**
 * The Sessions a storm drives: `count` of them, spread evenly over the
 * fixture's index range so a storm touches old and new Sessions alike rather
 * than only the Active band. Deterministic for a preset.
 */
export function stormSessionIds(sessionCount, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error("a storm needs at least one Session");
  const streams = Math.min(count, sessionCount);
  return Array.from({ length: streams }, (_, stream) =>
    fixtureSessionId(Math.floor((stream * sessionCount) / streams)),
  );
}

/**
 * Runs inside the page: the storm itself. Every push is scheduled up front at
 * its own instant, phase-shifted per stream, like independent Sessions whose
 * writes do not wait for the app to finish the last one — an app that cannot
 * keep up falls behind, and `stormLagMs` is how far.
 *
 * Serialized into the page, so it closes over nothing.
 */
export async function runStormInPage({ sessionIds, intervalMs, durationMs }) {
  const perStream = Math.max(1, Math.floor(durationMs / intervalMs));
  const total = sessionIds.length * perStream;
  const roundTrips = [];
  const failures = [];
  let notices = 0;
  const unsubscribe = window.api.sessions.onActivity(() => {
    notices += 1;
  });
  const started = performance.now();
  const calls = [];
  let lastIssuedAt = started;
  let lastDueAt = started;
  await new Promise((resolve) => {
    let issued = 0;
    sessionIds.forEach((sessionId, stream) => {
      const offset = (stream * intervalMs) / sessionIds.length;
      for (let tick = 0; tick < perStream; tick += 1) {
        const dueIn = offset + tick * intervalMs;
        lastDueAt = Math.max(lastDueAt, started + dueIn);
        setTimeout(() => {
          const sent = performance.now();
          lastIssuedAt = sent;
          calls.push(
            window.api.sessions
              .setRead({ sessionId, unread: tick % 2 === 0 })
              .then((result) => {
                roundTrips.push(performance.now() - sent);
                if (result?.ok !== true) failures.push(String(result?.error ?? "not ok"));
              })
              .catch((error) => failures.push(String(error?.message ?? error))),
          );
          issued += 1;
          if (issued === total) resolve();
        }, dueIn);
      }
    });
  });
  await Promise.all(calls);
  const settledAt = performance.now();
  // Let the last broadcasts arrive and paint before the window closes.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  unsubscribe();
  roundTrips.sort((a, b) => a - b);
  const p95 = roundTrips[Math.max(0, Math.ceil(roundTrips.length * 0.95) - 1)] ?? null;
  return {
    stormPushes: total,
    stormStreams: sessionIds.length,
    stormLagMs: lastIssuedAt - lastDueAt,
    stormSettleMs: settledAt - started,
    stormRoundTripP95Ms: p95,
    stormRoundTripMaxMs: roundTrips.at(-1) ?? null,
    activityNotices: notices,
    failures: failures.slice(0, 5),
    failureCount: failures.length,
  };
}

function assertStormHealthy(storm) {
  if (storm.failureCount > 0) {
    throw new Error(
      `fleet storm: ${storm.failureCount} of ${storm.stormPushes} pushes failed (${storm.failures.join(" | ")})`,
    );
  }
  // Every push re-publishes one listing row; a storm that drew none measured
  // the IPC round trip and nothing a window does with it.
  if (storm.activityNotices === 0) {
    throw new Error("fleet storm: no volli:session-activity notice reached the window");
  }
}

/** The storm's own numbers, as per-sample scalars. */
function stormFields(storm) {
  const { failures: _failures, failureCount: _failureCount, ...fields } = storm;
  return fields;
}

/**
 * Fleet storm with the board in front: frame times, long tasks and main
 * stalls while N Sessions push activity rows. Latency is the whole storm,
 * first push to the last answer painted; a fixed-shape storm on a healthy
 * app takes `durationMs` plus one interval, and everything past that is the
 * app falling behind.
 */
export async function measureFleetStorm(kit, { page, app, ticketCount, storm }) {
  await kit.bringBoardForward(ticketCount);
  let result;
  const sample = await kit.measured(
    page,
    app,
    async () => {
      result = await page.evaluate(runStormInPage, storm);
    },
    async () => {},
  );
  assertStormHealthy(result);
  return { ...sample, ...stormFields(result) };
}

/** Whether the visible composer's value ends with `expected`. */
function composerHolds(expected) {
  const boxes = Array.from(document.querySelectorAll('textarea[aria-label="Message"]'));
  const box = boxes.find((node) => node instanceof HTMLElement && node.offsetParent !== null);
  return box instanceof HTMLTextAreaElement && box.value.endsWith(expected);
}

/**
 * Typing into a new chat's composer, on the long chat's ticket, while a storm runs. One sample is
 * {@link DRAFT_TEXT} at {@link DRAFT_KEY_DELAY_MS} between keys; latency is
 * first key to the full draft in the field, and `keyToPaintMs` is each key's
 * `keydown` to the task after the next frame — what a person reads as the
 * letter appearing.
 */
export async function measureDraftTyping(kit, { page, app, manifest, storm }) {
  await kit.bringBoardForward(manifest.counts.tickets);
  await kit.openTicket(page, manifest.longChat.displayId);
  // A fresh `+ Chat` on the long chat's ticket: the fixture's own Sessions are
  // history with no live executor, and their composers stay disabled.
  const before = await page.locator(TICKET_STRIP_TABS).count();
  await openNewChatTab(page, TICKET_TAB_STRIP);
  await page.waitForFunction(
    ({ selector, count }) => document.querySelectorAll(selector).length > count,
    { selector: TICKET_STRIP_TABS, count: before },
    { timeout: 30_000 },
  );
  const textarea = page.locator('textarea[aria-label="Message"]:visible').first();
  await textarea.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const boxes = Array.from(document.querySelectorAll('textarea[aria-label="Message"]'));
      const box = boxes.find((node) => node instanceof HTMLElement && node.offsetParent !== null);
      return box instanceof HTMLTextAreaElement && !box.disabled;
    },
    undefined,
    { timeout: 30_000 },
  );
  await textarea.fill("");
  await textarea.focus();
  await kit.settleFrames(page);
  await page.evaluate(() => {
    const probe = { latencies: [] };
    probe.onKey = (event) => {
      if (event.key.length !== 1) return;
      const at = event.timeStamp;
      requestAnimationFrame(() =>
        setTimeout(() => probe.latencies.push(performance.now() - at), 0),
      );
    };
    window.addEventListener("keydown", probe.onKey, true);
    window.vc1093Keys = probe;
  });
  let stormResult;
  let sample;
  try {
    sample = await kit.measured(
      page,
      app,
      async () => {
        const storming = page.evaluate(runStormInPage, storm).then((result) => {
          stormResult = result;
        });
        await textarea.pressSequentially(DRAFT_TEXT, { delay: DRAFT_KEY_DELAY_MS });
        await page.waitForFunction(composerHolds, DRAFT_TEXT, { timeout: 30_000 });
        await storming;
      },
      async () => {},
    );
  } finally {
    await page
      .evaluate(() => window.removeEventListener("keydown", window.vc1093Keys.onKey, true))
      .catch(() => null);
  }
  const keyToPaintMs = await page.evaluate(() => window.vc1093Keys.latencies);
  if (keyToPaintMs.length !== DRAFT_TEXT.length) {
    throw new Error(
      `draft_typing: timed ${keyToPaintMs.length} of ${DRAFT_TEXT.length} keystrokes`,
    );
  }
  assertStormHealthy(stormResult);
  return { ...sample, keyToPaintMs, ...stormFields(stormResult) };
}

/**
 * Adds the second workspace through the app's own door and waits until this
 * window holds it (`projects.create` broadcasts `data-changed`, whose
 * unknown-project branch rehydrates the projects store). It gets one ticket so
 * its board is drawn, not an empty state.
 */
async function addSecondWorkspace(page, profile) {
  const parent = join(profile, "second-workspace");
  await fs.mkdir(parent, { recursive: true });
  const path = await makeGitRepo(parent, "workspace-");
  const created = await page.evaluate(
    async ({ projectPath, name, ticket }) => {
      const result = await window.api.projects.create({ path: projectPath, name });
      if (!result?.ok) return { error: String(result?.error ?? "project create failed") };
      const projectId = result.project.id;
      const made = await window.api.tickets.create({
        projectId,
        status: "todo",
        title: ticket,
        priority: "medium",
      });
      if (!made?.ok) return { error: String(made?.error ?? "ticket create failed") };
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return { error: String(boot.error) };
      return { projectId, order: boot.data.projects.map((project) => project.id) };
    },
    { projectPath: path, name: SECOND_WORKSPACE.name, ticket: SECOND_WORKSPACE.ticket },
  );
  if (created.error !== undefined) throw new Error(`workspace_switch: ${created.error}`);
  return created;
}

/** ⌘N for the Nth rail project, repeated until the board shows `ticketCount`. */
async function switchWorkspace(kit, page, index, ticketCount, timeoutMs = 30_000) {
  if (index < 0 || index > 8)
    throw new Error(`workspace_switch: project index ${index} has no ⌘ shortcut`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await page.keyboard.press(`Meta+${index + 1}`);
    try {
      await kit.waitForBoard(page, ticketCount, 2_000);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}

/**
 * Switching from a small workspace back to the fixture's: ⌘N until the
 * fixture's board holds every ticket and has painted its columns — the heavy
 * direction, what the owner feels coming back to their big project. The
 * light direction (to the one-ticket workspace) is reported as `toLightMs`.
 * One round trip runs first so the measured switch is a return to a
 * workspace this launch has drawn, not a first open.
 */
export async function measureWorkspaceSwitch(kit, { page, app, profile, ticketCount, state }) {
  if (state.secondWorkspace === undefined) {
    state.secondWorkspace = await addSecondWorkspace(page, profile);
  }
  const { order, projectId } = state.secondWorkspace;
  const lightIndex = order.indexOf(projectId);
  const heavyIndex = order.findIndex((id) => id !== projectId);
  await kit.bringBoardForward(ticketCount);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  // Warm round trip.
  await switchWorkspace(kit, page, lightIndex, 1);
  await switchWorkspace(kit, page, heavyIndex, ticketCount);
  await kit.settleFrames(page);
  const light = await kit.measured(
    page,
    app,
    () => page.keyboard.press(`Meta+${lightIndex + 1}`),
    () => kit.waitForBoard(page, 1),
  );
  await kit.settleFrames(page);
  const heavy = await kit.measured(
    page,
    app,
    () => page.keyboard.press(`Meta+${heavyIndex + 1}`),
    () => kit.waitForBoard(page, ticketCount),
  );
  return { ...heavy, toLightMs: light.latencyMs };
}
