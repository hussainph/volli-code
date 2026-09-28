/**
 * VC-373 — the ticket-open IPC fan-out, counted through the REAL packed app.
 *
 * A ticket detail is keyed on `ticket.id`, so a ticket switch is a full
 * remount and every read a surface owns fires again unless something caches it.
 * This probe instruments the IPC layer itself — every `volli:` invoke handler
 * in main is wrapped, so one call is one count, whatever renderer path issued
 * it — and prints a per-scenario count of the reads a ticket open spends.
 *
 * What it measures, in the order a person crosses the surface:
 *
 *   1. open ticket A (cold)      — the baseline fan-out.
 *   2. switch to ticket B        — B is cold, so this is B's baseline.
 *   3. back to A                 — A is WARM: the acceptance's targets say no
 *                                 `listForTicket` (roster), no
 *                                 `retention-ttl-get`, no `usage-report`
 *                                 (nothing settled in between), no automations
 *                                 enablement/list/arming/order, and no
 *                                 duplicate `blob-materialized`.
 *   4. Doc → file → Doc          — no `ticket-events` or `comment-list`: the
 *                                 feed paints the cache it left behind.
 *   5. Now → Diffs → Now         — reported, not all-zero: the worktree reads
 *                                 belong to VC-372, and a ticket's Runs are a
 *                                 per-ticket read by design.
 *   6. split a terminal          — zero roster reads: the split is a durable
 *                                 Session fact `volli:session-activity`
 *                                 announces, not a reason to re-read the list.
 *
 * `--measure-only` (or `VC373_MEASURE_ONLY=1`) prints the counts and skips the
 * target assertions, which is how the BEFORE numbers are taken on a commit
 * that does not yet meet them.
 *
 * MANUALLY RUN (needs a display + the built app):
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/ticket-open-ipc-smoke.mjs
 */
import { promises as fs } from "node:fs";

import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedProjects,
  sleep,
  startTerminalSession,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const measureOnly =
  process.env.VC373_MEASURE_ONLY === "1" || process.argv.includes("--measure-only");

const { must, attempt, check, summarize } = createRunner();
const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-ticket-open-ipc-");
const worktreeHome = `${scratch}/worktree-home`;
const projectDir = await makeGitRepo(scratch, "project-");
await fs.mkdir(worktreeHome, { recursive: true });

let app = null;
/** The window under measurement — module scope so `scenario` can count broadcasts. */
let page = null;
let exitCode = 0;

/** The channels a ticket open is expected to spend; everything else is printed too. */
const READ_CHANNELS = [
  "volli:session-list-for-ticket",
  "volli:session-list",
  "volli:usage-report",
  "volli:retention-ttl-get",
  "volli:retention-state",
  "volli:worktree-status",
  "volli:worktree-change-set",
  "volli:ticket-events",
  "volli:comment-list",
  "volli:blob-list",
  "volli:blob-materialized",
  "volli:automation-list",
  "volli:automation-arming-list",
  "volli:automation-enablement",
  "volli:automation-column-order-list",
  "volli:automation-runs-for-ticket",
];

/**
 * Wrap every `volli:` invoke handler in main so each call counts.
 *
 * The private `_invokeHandlers` map is the only place a wrapper can reach the
 * already-registered handler — `ipcMain.on` does NOT see `invoke()` messages,
 * and the renderer's `window.api` is a frozen contextBridge object, so neither
 * of the public doors works for an invocation counter. This is a probe, and
 * the `instanceof` guard fails loudly if a future Electron renames the map.
 */
async function installIpcCounters(application) {
  await application.evaluate(({ ipcMain }) => {
    /* eslint-disable no-underscore-dangle -- `_invokeHandlers` is Electron's
       own private name for the registered invoke-handler map; the underscore
       is theirs, not this codebase's. */
    const handlers = ipcMain._invokeHandlers;
    if (!(handlers instanceof Map)) {
      throw new Error("ipcMain._invokeHandlers is no longer a Map — the counter needs updating");
    }
    const counts = {};
    globalThis.vc373Counts = counts;
    // `set` on keys the iteration already visited is safe: a Map re-visits
    // only entries ADDED during iteration, and this adds none.
    for (const [channel, handler] of handlers) {
      if (!channel.startsWith("volli:")) continue;
      handlers.set(channel, (event, ...args) => {
        counts[channel] = (counts[channel] ?? 0) + 1;
        return handler(event, ...args);
      });
    }
    /* eslint-enable no-underscore-dangle */
  });
}

function snapshot() {
  return app.evaluate(() => JSON.parse(JSON.stringify(globalThis.vc373Counts ?? {})));
}

/** `after - before`, keeping only channels that moved. */
function delta(before, after) {
  const moved = {};
  for (const channel of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[channel] ?? 0) - (before[channel] ?? 0);
    if (change !== 0) moved[channel] = change;
  }
  return moved;
}

/** Print one scenario's counts, read channels first and in their listed order. */
function printScenario(label, counts) {
  console.log(`\n  ── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}`);
  const seen = new Set();
  for (const channel of READ_CHANNELS) {
    seen.add(channel);
    console.log(`     ${channel.padEnd(36)} ${counts[channel] ?? 0}`);
  }
  for (const [channel, count] of Object.entries(counts)) {
    if (seen.has(channel)) continue;
    console.log(`     ${channel.padEnd(36)} ${count}`);
  }
  globalThis.vc373Report[label] = counts;
}

async function scenario(label, body) {
  const before = await snapshot();
  const changesBefore = await page.evaluate(() => window.vc373Changes.length);
  await body();
  // One beat for any read issued on the last frame to reach main.
  await sleep(250);
  const counts = delta(before, await snapshot());
  const changes = await page.evaluate((from) => window.vc373Changes.slice(from), changesBefore);
  printScenario(label, counts);
  if (changes.length > 0) {
    console.log(`     ── planning broadcasts inside the scenario: ${JSON.stringify(changes)}`);
  }
  return counts;
}

const cardById = (id) =>
  page
    .locator("article")
    .filter({ has: page.locator("span.font-mono", { hasText: new RegExp(`^${id}$`) }) });

const docTab = (id) => page.getByRole("tab", { name: id, exact: true });

async function openTicket(id) {
  await cardById(id).dblclick();
  await waitUntil(`detail ${id} to open`, async () => (await docTab(id).count()) === 1);
  // The rail's own blocks land on their own reads; a moment past the tab so a
  // scenario's counts include the full open rather than part of it.
  await sleep(900);
}

async function leaveToBoard(id) {
  await docTab(id).click();
  await page.keyboard.press("Escape");
  await waitUntil("board to return", async () => (await cardById(id).count()) === 1);
  await sleep(200);
}

async function railPage(mode) {
  const testid = `ticket-rail-tab-${mode}`;
  try {
    await page.getByTestId(testid).click({ timeout: 5000 });
  } catch (error) {
    console.log(
      `  [note] rail tab ${mode}: locator click failed (${error.message.split("\n")[0]}); dispatching directly`,
    );
    const clicked = await page.evaluate((id) => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      if (element === null) return false;
      element.click();
      return true;
    }, testid);
    if (!clicked) throw new Error(`no rail tab ${testid}`, { cause: error });
  }
}

const REPORT = (globalThis.vc373Report = {});

try {
  app = await launch({ dbPath, userDataDir, extraEnv: { VOLLI_WORKTREE_HOME_DIR: worktreeHome } });
  await assertProfileIsolated(app, userDataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await assertBuiltRendererLoaded(page);
  await sleep(800);

  await installIpcCounters(app);

  await must(1, "seed one project with tickets VC-1 and VC-2", async () => {
    await seedProjects(page, [
      { id: "vc373-project", name: "IPC Fanout", path: projectDir, prefix: "VC" },
    ]);
    const project = (await readSeededProjects(page)).byName["IPC Fanout"];
    if (project === undefined) return { ok: false, detail: "project not imported" };
    const seeded = await page.evaluate(async (projectId) => {
      const first = await window.api.tickets.create({
        projectId,
        status: "todo",
        title: "Ticket A measures a cold open",
        priority: "medium",
      });
      const second = await window.api.tickets.create({
        projectId,
        status: "todo",
        title: "Ticket B measures a switch",
        priority: "medium",
      });
      return { a: first.ok ? first.ticket.id : null, b: second.ok ? second.ticket.id : null };
    }, project.id);
    // One attachment on ticket A, from OUTSIDE the repo so it snapshots: the
    // strip then changes revision when it loads, which is the case that used to
    // pay `blob-materialized` twice (once against the not-yet-loaded strip).
    const attachmentPath = `${scratch}/attached-note.txt`;
    await fs.writeFile(attachmentPath, "attached for the fan-out count\n");
    const attached = await page.evaluate(
      async ({ ticketId, sourcePath }) => {
        const result = await window.api.attachments.attach({
          fileName: "attached-note.txt",
          owner: { ticketId },
          sourcePath,
        });
        return result.ok;
      },
      { ticketId: seeded.a, sourcePath: attachmentPath },
    );
    if (!attached) return { ok: false, detail: "attachment seeding failed" };
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("both cards to render", async () => {
      return (await cardById("VC-1").count()) === 1 && (await cardById("VC-2").count()) === 1;
    });
    return { ok: seeded.a !== null && seeded.b !== null, detail: JSON.stringify(seeded) };
  });

  // Every planning broadcast bumps the board's version, and a bump is exactly
  // what re-opens the rail's question — counted here so a scenario's reads can
  // be read against how many changes landed inside it.
  await page.evaluate(() => {
    window.vc373Changes = [];
    window.api.data.onChanged((event) => {
      window.vc373Changes.push({
        ticketId: event.ticketId ?? null,
        kind: event.kind ?? null,
        at: Date.now(),
      });
    });
  });

  // ---- 1. open ticket A (cold) -------------------------------------------
  const coldA = await scenario("open ticket A (cold)", async () => {
    await openTicket("VC-1");
  });
  check(
    "1",
    "cold open spends the ticket's baseline reads",
    (coldA["volli:ticket-events"] ?? 0) >= 1 &&
      (coldA["volli:comment-list"] ?? 0) >= 1 &&
      (coldA["volli:session-list-for-ticket"] ?? 0) >= 1,
    `events=${coldA["volli:ticket-events"] ?? 0} comments=${coldA["volli:comment-list"] ?? 0} roster=${coldA["volli:session-list-for-ticket"] ?? 0}`,
  );

  // ---- setup: a live terminal (also materializes ticket A's worktree) -----
  await must(2, "start a ticket session so a split has a pane to split", async () => {
    await startTerminalSession(page.locator("aside"));
    await waitUntil(
      "terminal",
      () =>
        page.evaluate(
          () =>
            Array.from(document.querySelectorAll(".xterm")).filter(
              (element) => element.offsetParent !== null && element.clientWidth > 0,
            ).length === 1,
        ),
      { timeout: 45000 },
    );
    await waitUntil(
      "ticket A's worktree",
      async () => {
        const ticket = await page.evaluate(async () => {
          const boot = await window.api.data.bootstrap();
          if (!boot.ok) return null;
          for (const list of Object.values(boot.data.ticketsByProject ?? {})) {
            const found = list.find((candidate) => candidate.title.startsWith("Ticket A"));
            if (found) return found.worktreePath;
          }
          return null;
        });
        return typeof ticket === "string" && ticket.length > 0;
      },
      { timeout: 60000 },
    );
    return { ok: true };
  });

  // ---- 2/3. switch to B, then back to A ----------------------------------
  const switchB = await scenario("switch to ticket B", async () => {
    await leaveToBoard("VC-1");
    await openTicket("VC-2");
  });
  check(
    "2",
    "ticket B's own open spends its baseline (context for the warm return)",
    (switchB["volli:session-list-for-ticket"] ?? 0) >= 1,
    `roster=${switchB["volli:session-list-for-ticket"] ?? 0}`,
  );

  const backA = await scenario("back to ticket A (warm)", async () => {
    await leaveToBoard("VC-2");
    await openTicket("VC-1");
  });
  if (measureOnly) {
    console.log("\n  measure-only: warm-return targets reported, not asserted");
  } else {
    await attempt(
      "3",
      "warm re-open of A re-reads no roster, TTL, usage, automations, and pays no duplicate materialized read",
      async () => {
        const checks = {
          roster: backA["volli:session-list-for-ticket"] ?? 0,
          ttl: backA["volli:retention-ttl-get"] ?? 0,
          usage: backA["volli:usage-report"] ?? 0,
          automations:
            (backA["volli:automation-enablement"] ?? 0) +
            (backA["volli:automation-list"] ?? 0) +
            (backA["volli:automation-arming-list"] ?? 0) +
            (backA["volli:automation-column-order-list"] ?? 0),
          materialized: backA["volli:blob-materialized"] ?? 0,
        };
        return {
          ok:
            checks.roster === 0 &&
            checks.ttl === 0 &&
            checks.usage === 0 &&
            checks.automations === 0 &&
            checks.materialized <= 1,
          detail: JSON.stringify(checks),
        };
      },
    );
  }

  // ---- 4. Doc → file → Doc ------------------------------------------------
  const docFlip = await scenario("Doc → file → Doc", async () => {
    await docTab("VC-1").click();
    await railPage("files");
    const row = page.locator('[data-testid="ticket-files-row"][data-path="README.md"]').first();
    await waitUntil("README row in the Files rail", async () => (await row.count()) === 1, {
      timeout: 30000,
    });
    await row.click();
    await waitUntil(
      "file tab",
      async () => (await page.getByRole("tab", { name: "README.md", exact: true }).count()) === 1,
      { timeout: 20000 },
    );
    await sleep(400);
    await docTab("VC-1").click();
    await sleep(400);
  });
  if (!measureOnly) {
    await attempt("4", "a Doc-tab return spends no events or comments read", async () => {
      const events = docFlip["volli:ticket-events"] ?? 0;
      const comments = docFlip["volli:comment-list"] ?? 0;
      return {
        ok: events === 0 && comments === 0,
        detail: `events=${events} comments=${comments}`,
      };
    });
  }

  // ---- 5. Now → Diffs → Now ----------------------------------------------
  const railFlip = await scenario("Now → Diffs → Now", async () => {
    await railPage("now");
    await sleep(500);
    await railPage("changes");
    await sleep(900);
    await railPage("now");
    await sleep(900);
  });
  check(
    "5",
    "a rail page flip is counted and reported (worktree reads are VC-372's; a ticket's Runs are per-ticket by design)",
    Object.keys(railFlip).length > 0,
    `channels=${Object.keys(railFlip).length}`,
  );

  // ---- 6. split a terminal ------------------------------------------------
  const split = await scenario("split a terminal", async () => {
    const sessionTab = page.getByRole("tab", { name: /^Session \d+$/ }).first();
    await sessionTab.click();
    const box = await page.evaluate(() => {
      const terminal = Array.from(document.querySelectorAll(".xterm")).find(
        (candidate) => candidate.offsetParent !== null && candidate.clientWidth > 0,
      );
      if (!terminal) return null;
      const rect = terminal.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    if (box === null) throw new Error("no visible terminal to focus");
    await page.mouse.click(box.x, box.y);
    await sleep(250);
    await page.keyboard.press("Meta+d");
    await waitUntil(
      "two live panes",
      () =>
        page.evaluate(
          () =>
            Array.from(document.querySelectorAll(".xterm")).filter(
              (element) => element.offsetParent !== null && element.clientWidth > 0,
            ).length === 2,
        ),
      { timeout: 30000 },
    );
    await sleep(1200);
  });
  if (!measureOnly) {
    await attempt("6", "a split spends zero roster reads", async () => {
      const roster = split["volli:session-list-for-ticket"] ?? 0;
      return { ok: roster === 0, detail: `roster=${roster}` };
    });
  }

  console.log("\n  ── VC-373 counts (JSON) ─────────────────────────────");
  console.log(JSON.stringify(REPORT, null, 2));
  console.log("  exit: measure-only\n");
} catch (error) {
  console.error("smoke aborted:", error?.stack ?? error);
  exitCode = 1;
} finally {
  exitCode = measureOnly ? 0 : Math.max(exitCode, summarize());
  if (app !== null) await closeAppBounded(app);
  // A helper process can still be flushing a scratch file the instant the
  // window closes; one retry after a beat, then let it go (an uncleaned /tmp
  // dir is a nuisance, not a failed check).
  try {
    await cleanup();
  } catch {
    await sleep(750);
    await cleanup().catch(() => {});
  }
}
process.exit(exitCode);
