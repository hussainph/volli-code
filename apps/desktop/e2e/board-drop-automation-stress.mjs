/**
 * Stress: an Automation's roster broadcast landing WHILE a card is in the air.
 *
 * The crash under test: a drop into an armed column starts an Automation, its
 * Run's `data:changed` reaches the renderer as `hydrateProjectRoster` — a
 * wholesale replacement of the ticket and label slices (every object a new
 * identity, no visible change) — and if that lands mid-gesture the board
 * re-renders `DndContext` from outside the drag, dnd-kit re-measures, and React
 * throws #185 "Maximum update depth exceeded". jsdom cannot reproduce the
 * runaway loop (no layout); this runs the real Board in real Chromium layout
 * over the lab's fixture IPC, modeled on board-sort-loop-lab.mjs.
 *
 * Mechanism, per gesture:
 *   1. lift a card (real pointer events; dnd-kit's PointerSensor activates);
 *   2. while `[data-board-drag]` is present, a 15ms in-page pump calls the real
 *      store's `hydrateProjectRoster` with a clone of the current slice (new
 *      identities, same values) and re-broadcasts the armed-run projection;
 *      explicit bursts are also injected between pointer moves;
 *   3. release over an ARMED column (doing → Implement, needs_review →
 *      Standards, both seeded by the automation-improvements scratch);
 *   4. the wrapped `tickets.move` plays main's part: it records the arrival as a
 *      PendingArmedRun (the arming), then emits the Run's roster broadcast.
 *
 * Run a lab from THIS checkout first (the fix is what is being tested):
 *   (cd apps/desktop && ./node_modules/.bin/vp dev --mode lab --port 5191)
 *   VOLLI_LAB_PORT=5191 node apps/desktop/e2e/board-drop-automation-stress.mjs
 * Env: VOLLI_STRESS_ITERATIONS (default 24), VOLLI_CHROME,
 *      VOLLI_STRESS_SCALE (tickets per column, default 60 — above the 40-row
 *      threshold at which columns window (VC-316), so the ResizeObserver /
 *      row-stride measurement machinery is live; 0 keeps the scratch's own
 *      fixture of ~15 tickets).
 *
 * NEGATIVE CONTROL — `VOLLI_STRESS_CONTROL=<git-rev>` swaps the board module
 * for that revision's `board.tsx` WITHOUT touching the working tree: the file
 * is materialized under e2e/.control/, Vite serves it over `/@fs/` (its
 * `@renderer/*` imports resolve to the same module instances the live app
 * uses), and Playwright routes the `board.tsx` request to it. A stress test
 * that cannot fail against the pre-fix board proves nothing.
 *
 * The revision must be one that PREDATES the freeze. On this branch `HEAD` is
 * the fix, so `VOLLI_STRESS_CONTROL=HEAD` is not a control at all — it serves
 * the very board under test. Name the merge-base instead:
 *   VOLLI_STRESS_CONTROL=$(git merge-base HEAD origin/main) \
 *     VOLLI_LAB_PORT=5191 node apps/desktop/e2e/board-drop-automation-stress.mjs
 * The run announces which it got (`HAS` / `lacks` the frozen-reads fix) on the
 * first two lines; read them before trusting a control number.
 * Fixture IPC only; no real tickets, Automations, or Sessions are started.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ITERATIONS = Number(process.env.VOLLI_STRESS_ITERATIONS ?? "24");
const SCALE = Number(process.env.VOLLI_STRESS_SCALE ?? "60");
/** Escalation: every churn also rotates labels / bumps updatedAt on a few mounted tickets. */
const MUTATE = process.env.VOLLI_STRESS_MUTATE === "1";
const CONTROL_REV = process.env.VOLLI_STRESS_CONTROL;
const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const BOARD_MODULE = "apps/desktop/src/renderer/src/components/board/board.tsx";
const CONTROL_DIR = resolve(E2E_DIR, ".control");
const CONTROL_FILE = resolve(CONTROL_DIR, "board-control.tsx");
const PROJECT_ID = "prj-voltaic";
/** Column → the Automation the scratch's fixture arms it with. */
const ARMED = { doing: "automation-implement", needs_review: "automation-standards" };
/** Persisted and store rosters both land in `order` sequence; shared comparator. */
const byOrder = (a, b) => a.order - b.order;
const ERROR_PATTERN =
  /Maximum update depth|Too many re-renders|Minified React error #185|error #185|The board stopped responding/;

const executablePath = [
  process.env.VOLLI_CHROME,
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((path) => path && existsSync(path));
assert.ok(executablePath, "Set VOLLI_CHROME to an installed Chromium browser");
const url = `http://localhost:${process.env.VOLLI_LAB_PORT ?? "5174"}/lab/?preview=board#automation-improvements`;
const browser = await chromium.launch({ executablePath, headless: true });

const results = { passed: 0, failed: 0, failures: [] };

if (CONTROL_REV) {
  const repoRoot = resolve(E2E_DIR, "../../..");
  const source = execFileSync("git", ["show", `${CONTROL_REV}:${BOARD_MODULE}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.ok(
    !/from "\.\.?\//.test(source),
    "control board.tsx has relative imports; cannot relocate it",
  );
  mkdirSync(CONTROL_DIR, { recursive: true });
  writeFileSync(CONTROL_FILE, source);
  console.log(
    `CONTROL MODE: serving board.tsx from ${CONTROL_REV} (${source.includes("FrozenReads") ? "HAS" : "lacks"} the frozen-reads fix)`,
  );
}

try {
  const page = await browser.newPage({
    viewport: { width: 1480, height: 920 },
    reducedMotion: "no-preference",
  });
  page.setDefaultTimeout(15000);
  if (CONTROL_REV) {
    const origin = new URL(url).origin;
    await page.route("**/src/components/board/board.tsx*", async (route) => {
      const response = await page.request.get(`${origin}/@fs${CONTROL_FILE}`);
      const body = await response.text();
      console.log(
        `CONTROL: routed ${route.request().url()} → control module (${body.length} bytes, ` +
          `${body.includes("FrozenReads") ? "HAS" : "lacks"} FrozenReads)`,
      );
      await route.fulfill({ status: 200, body, headers: { "content-type": "text/javascript" } });
    });
  }
  const fatal = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => fatal.push(`pageerror: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    consoleErrors.push(text);
    if (ERROR_PATTERN.test(text)) fatal.push(`console: ${text}`);
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.locator('[data-column-arming="doing"][data-arming-state="ready"]').waitFor();
  await page.locator('[data-column-arming="needs_review"][data-arming-state="ready"]').waitFor();
  const fixtureProbe = await page.evaluate(() =>
    window.api.tickets.move({
      projectId: "not-a-fixture-project",
      ticketId: "missing",
      toStatus: "todo",
      toIndex: 0,
    }),
  );
  assert.equal(
    fixtureProbe.error,
    "No fixture board for this project.",
    "The server is not serving the move-enabled fixture",
  );

  // ---- in-page harness: churn pump, main's arming stand-in, move recorder ----
  await page.evaluate(
    async ({ projectId, armed, scale, mutate }) => {
      const { useBoardStore } = await import("/src/stores/board.ts");
      const { useArmedRunStore, receivePendingArmedRuns } =
        await import("/src/components/automations/armed-run.ts");
      // A big board, persisted by the lab's own in-memory move fixture so the
      // drop's IPC round-trip stays real (the scratch's fixture only knows its
      // own ~15 tickets, and the store adopts whatever roster the reply carries).
      let fixture = null;
      if (scale > 0) {
        const { createBoardMoveFixture } = await import("/lab/board-move-fixture.ts");
        const state = useBoardStore.getState();
        const template = state.ticketsByProject[projectId][0];
        const labelNames = (state.labelsByProject[projectId] ?? []).map((label) => label.name);
        const roster = [];
        let number = 1000;
        for (const status of ["backlog", "todo", "doing", "needs_review", "done"]) {
          for (let i = 0; i < scale; i++) {
            number += 1;
            roster.push({
              ...template,
              id: `stress-${status}-${i}`,
              ticketNumber: number,
              title: `Stress ${status} #${i} — ${"lorem ipsum ".repeat(i % 4)}`.trim(),
              status,
              order: i,
              priority: ["low", "medium", "high", "urgent"][i % 4],
              labels: i % 3 === 0 ? [] : labelNames.slice(0, (i % labelNames.length) + 1),
            });
          }
        }
        fixture = createBoardMoveFixture(projectId, roster);
        useBoardStore.setState({
          ticketsByProject: { ...state.ticketsByProject, [projectId]: fixture.read() },
        });
      }
      // Main-thread stalls: Long Tasks (>50ms, Chromium) plus a rAF gap monitor
      // (a frame more than 100ms after the last one is a blocked thread whether
      // or not the Long Tasks observer attributes it). Both read per gesture.
      const stalls = { longTasks: [], frameGaps: [], lastFrame: performance.now() };
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            stalls.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }).observe({ type: "longtask", buffered: true });
      } catch {
        stalls.longTasks = null;
      }
      const tick = (now) => {
        const gap = now - stalls.lastFrame;
        if (gap > 100) stalls.frameGaps.push({ at: now, gap });
        stalls.lastFrame = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // dnd-kit measures through getBoundingClientRect; counting calls is the
      // one layout-side signal that separates "the churn reached the drag
      // machinery" from "the board never re-rendered".
      let measures = 0;
      const nativeRect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        measures += 1;
        return nativeRect.call(this);
      };
      const lab = {
        scaled: fixture !== null,
        measures: () => measures,
        /** Stalls since `sinceMs` (performance.now() clock). */
        stallsSince: (sinceMs) => {
          const tasks =
            stalls.longTasks === null ? null : stalls.longTasks.filter((t) => t.start >= sinceMs);
          const gaps = stalls.frameGaps.filter((g) => g.at >= sinceMs);
          return {
            longTasks: tasks === null ? null : tasks.length,
            longTaskMs:
              tasks === null ? null : Math.round(tasks.reduce((sum, t) => sum + t.duration, 0)),
            longestTaskMs:
              tasks === null ? null : Math.round(Math.max(0, ...tasks.map((t) => t.duration))),
            frameGaps: gaps.length,
            worstFrameGapMs: Math.round(Math.max(0, ...gaps.map((g) => g.gap))),
          };
        },
        now: () => performance.now(),
        pickerDiagnostics: (x, y) => {
          const under = document.elementFromPoint(x, y);
          return {
            panels: [...document.querySelectorAll("[data-offered-panel]")].map((node) => ({
              state: node.dataset.offeredPanel,
              column: node.closest("[data-column-dropzone]")?.dataset.columnDropzone ?? null,
            })),
            underPointer: under
              ? `${under.tagName.toLowerCase()} in ${under.closest("[data-column-dropzone]")?.dataset.columnDropzone ?? "no column"}`
              : null,
            dragging: document.querySelector("[data-board-drag]") !== null,
          };
        },
        churns: 0,
        moves: [],
        armings: [],
        pump: null,
        pendingByTicket: new Map(),
      };
      window.lab = lab;
      const broadcastPending = () =>
        receivePendingArmedRuns(
          Array.from(lab.pendingByTicket.values(), (row) => Object.assign({}, row)),
        );
      /**
       * The roster broadcast's store write. `hydrateProjectRoster` where the
       * checkout has it (VC-387); on an older checkout the same wholesale
       * `set` it performs, so a pre-fix board can serve as a negative control.
       */
      const replaceRoster = (tickets, labels) => {
        const state = useBoardStore.getState();
        if (typeof state.hydrateProjectRoster === "function") {
          state.hydrateProjectRoster(
            projectId,
            tickets.map(({ body: _body, ...summary }) => ({ ...summary })),
            labels.map((label) => ({ ...label })),
          );
          return;
        }
        lab.rawSetState = true;
        useBoardStore.setState({
          ticketsByProject: {
            ...state.ticketsByProject,
            [projectId]: tickets.map((ticket) => ({ ...ticket })),
          },
          labelsByProject: {
            ...state.labelsByProject,
            [projectId]: labels.map((label) => ({ ...label })),
          },
        });
      };
      /**
       * One wholesale roster replacement: every ticket/label a new identity,
       * values unchanged — unless `mutate`, when every fifth mounted ticket also
       * gets a different label set and a fresh updatedAt (a visible DOM change
       * under dnd-kit's observers), which is what a Run's real broadcast can
       * carry. Only visible fields: status/order/id never move, so the drop's
       * expectations still hold.
       */
      lab.mutations = 0;
      lab.churn = () => {
        const state = useBoardStore.getState();
        let tickets = state.ticketsByProject[projectId] ?? [];
        const labels = state.labelsByProject[projectId] ?? [];
        if (mutate) {
          const names = labels.map((label) => label.name);
          const phase = lab.churns;
          tickets = tickets.map((ticket, index) => {
            if ((index + phase) % 5 !== 0) return ticket;
            lab.mutations += 1;
            const rotate = (phase + index) % (names.length + 1);
            return { ...ticket, labels: names.slice(0, rotate), updatedAt: Date.now() };
          });
        }
        replaceRoster(tickets, labels);
        broadcastPending();
        lab.churns += 1;
      };
      /** Flip the countdown read: clear the projection, then restore it. */
      lab.flipPending = () => {
        receivePendingArmedRuns([]);
        broadcastPending();
      };
      lab.startPump = (intervalMs) => {
        lab.stopPump();
        lab.pump = window.setInterval(() => {
          if (!document.querySelector("[data-board-drag]")) return;
          lab.churn();
        }, intervalMs);
      };
      lab.stopPump = () => {
        if (lab.pump !== null) window.clearInterval(lab.pump);
        lab.pump = null;
      };
      lab.pendingCount = () => Object.keys(useArmedRunStore.getState().pending).length;
      lab.snapshot = () =>
        (useBoardStore.getState().ticketsByProject[projectId] ?? []).map(
          ({ id, status, order }) => ({ id, status, order }),
        );

      const bridge = window.api;
      const wrap = (target, key) => async (input) => {
        const result = await (fixture === null ? target[key](input) : fixture[key](input));
        const record = { key, input, ok: result.ok, error: result.error, tickets: null };
        lab.moves.push(record);
        if (!result.ok) return result;
        record.tickets = result.tickets.map(({ id, status, order }) => ({ id, status, order }));
        const automationId = armed[input.toStatus];
        if (automationId !== undefined) {
          // Main's part: an arrival in an armed column opens one countdown
          // window keyed by ticket (a later move replaces the earlier one).
          const ticketIds = key === "move" ? [input.ticketId] : input.ticketIds;
          for (const ticketId of ticketIds) {
            const row = {
              id: `arrival-${lab.armings.length + 1}`,
              ticketId,
              projectId: input.projectId,
              ticketDisplayId: ticketId,
              automationId,
              automationName: automationId,
              status: input.toStatus,
              origin: "armed",
              openedAt: Date.now(),
              startAt: Date.now() + 10_000,
            };
            lab.pendingByTicket.set(ticketId, row);
            lab.armings.push({ ticketId, status: input.toStatus, automationId });
          }
          broadcastPending();
          // The Run's `data:changed` → hydrateProjectRoster, a tick later, with
          // the persisted roster (new identities).
          window.setTimeout(() => {
            replaceRoster(
              result.tickets,
              useBoardStore.getState().labelsByProject[projectId] ?? [],
            );
            lab.churns += 1;
          }, 0);
        }
        return result;
      };
      const ticketBridge = new Proxy(bridge.tickets, {
        get(target, key) {
          if (key !== "move" && key !== "moveMany") return Reflect.get(target, key);
          return wrap(target, key);
        },
      });
      window.api = new Proxy(bridge, {
        get(target, key) {
          return key === "tickets" ? ticketBridge : Reflect.get(target, key);
        },
      });
    },
    { projectId: PROJECT_ID, armed: ARMED, scale: SCALE, mutate: MUTATE },
  );
  // Let the scaled roster paint (and window) before the first lift.
  await page.waitForTimeout(500);
  const boardShape = await page.evaluate(() => {
    const canvas = document.querySelector("[data-board-ticket-count]");
    return {
      held: canvas?.getAttribute("data-board-ticket-count") ?? null,
      mounted: document.querySelectorAll("[data-board-ticket-slot]").length,
      columns: document.querySelectorAll("[data-column-dropzone]").length,
      canvasOverflow: canvas ? canvas.scrollWidth - canvas.clientWidth : null,
    };
  });
  console.log(`board: ${JSON.stringify(boardShape)} (scale=${SCALE}, mutate=${MUTATE})`);

  const column = (status) => page.locator(`[data-column-dropzone="${status}"]`);
  const domIds = (status) =>
    column(status)
      .locator("[data-board-ticket-slot]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.boardTicketSlot));
  const snapshot = () => page.evaluate(() => window.lab.snapshot());
  const churnBurst = (burstCount, burstFlip) =>
    page.evaluate(
      ({ count, flip }) => {
        for (let i = 0; i < count; i++) window.lab.churn();
        if (flip) window.lab.flipPending();
      },
      { count: burstCount, flip: burstFlip },
    );
  const health = async (label) => {
    if (fatal.length > 0) throw new Error(`${label}: ${fatal.join("\n")}`);
    const fallback = await page.locator("[data-board-boundary-fallback]").count();
    assert.equal(fallback, 0, `${label}: error-boundary fallback rendered`);
    const columns = await page.locator("[data-column-dropzone]").count();
    assert.ok(columns > 0, `${label}: blank board (no columns)`);
  };

  /**
   * Gesture phases, cycled per iteration pair:
   *  - steady: 5-step pointer travel, churn pump every 15ms, bursts between moves
   *    (the interleaving the crash reports name);
   *  - flick: 1-step jumps straight to the drop point and an immediate release,
   *    pump every 4ms: dnd-kit gets the fewest frames to settle before the
   *    Automation reply and the roster broadcast land on top of teardown;
   *  - heavy: steady travel with 30-churn bursts and a 4ms pump, saturating the
   *    main thread with store writes while the card is in the air.
   */
  const PHASES = ["steady", "flick", "heavy"];
  const stallTotals = {
    longTasks: 0,
    longTaskMs: 0,
    longestTaskMs: 0,
    frameGaps: 0,
    worstFrameGapMs: 0,
  };
  let altHeld = false;
  const alt = async (down) => {
    await page.keyboard[down ? "down" : "up"]("Alt");
    altHeld = down;
  };

  for (let turn = 0; turn < ITERATIONS; turn++) {
    const iteration = turn + 1;
    const to = turn % 2 === 0 ? "doing" : "needs_review";
    const from = turn % 2 === 0 ? "needs_review" : "doing";
    const usePicker = turn % 5 === 4;
    const phase = PHASES[Math.floor(turn / 2) % PHASES.length];
    const pumpMs = phase === "steady" ? 15 : 4;
    const burst = phase === "heavy" ? 30 : 8;
    const steps = phase === "flick" ? 1 : 5;
    const label = `iteration ${iteration} [${phase}] (${from} → ${to}${usePicker ? ", ⌥ picker" : ""})`;
    try {
      await health(`${label} pre`);
      const movesBefore = await page.evaluate(() => window.lab.moves.length);
      const armingsBefore = await page.evaluate(() => window.lab.armings.length);
      const churnsBefore = await page.evaluate(() => window.lab.churns);
      const measuresBefore = await page.evaluate(() => window.lab.measures());
      const startedAt = await page.evaluate(() => window.lab.now());
      const before = await snapshot();
      const sourceIds = await domIds(from);
      assert.ok(sourceIds.length > 0, `${label}: source column is empty`);
      const sourceId = sourceIds[turn % sourceIds.length];
      const source = column(from).locator(`[data-board-ticket-slot="${sourceId}"]`);
      await source.scrollIntoViewIfNeeded();
      const start = await source.boundingBox();
      const target = await column(to).boundingBox();

      // Lift.
      await page.mouse.move(start.x + start.width / 2, start.y + 20);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2 + 10, start.y + 22, { steps: 3 });
      await page.locator("[data-board-drag]").waitFor();
      // Churn the store for the whole time the card is in the air.
      await page.evaluate((ms) => window.lab.startPump(ms), pumpMs);
      await churnBurst(burst, false);

      // Cross to the armed column, churning in bursts between moves. A flick
      // jumps straight to the final point (two moves: enter, then settle).
      const finalFraction = [0.85, 0.5, 0.2][turn % 3];
      const fractions =
        phase === "flick" ? [0.9, finalFraction] : [0.15, 0.6, 0.9, 0.35, finalFraction];
      for (const [step, fraction] of fractions.entries()) {
        const x = target.x + target.width / 2;
        const y = target.y + target.height * fraction;
        await page.mouse.move(x, y, { steps });
        if (phase !== "flick") await churnBurst(burst, step % 2 === 1);
        if (usePicker && step === fractions.length - 2) {
          await alt(true);
          await page.mouse.move(x + 2, y + 1);
          try {
            await page.locator('[data-offered-panel="expanded"]').waitFor({ timeout: 4000 });
          } catch {
            const diagnostics = await page.evaluate(
              ([px, py]) => window.lab.pickerDiagnostics(px, py),
              [x + 2, y + 1],
            );
            throw new Error(
              `${label}: picker never expanded over ${to}: ${JSON.stringify(diagnostics)}`,
            );
          }
          await churnBurst(burst, true);
          await alt(false);
        }
        if (fatal.length > 0) throw new Error(`${label} mid-gesture: ${fatal.join("\n")}`);
      }
      const midChurns = (await page.evaluate(() => window.lab.churns)) - churnsBefore;
      const midMeasures = (await page.evaluate(() => window.lab.measures())) - measuresBefore;
      assert.ok(
        midChurns >= (phase === "flick" ? 10 : 40),
        `${label}: only ${midChurns} mid-gesture churns landed`,
      );

      // Drop, and let the 200ms drop transition + the Run's broadcast settle.
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector("[data-board-drag]"));
      await page.evaluate(() => window.lab.stopPump());
      await page.waitForTimeout(phase === "flick" ? 250 : 350);
      await health(`${label} post-drop`);
      const stall = await page.evaluate((since) => window.lab.stallsSince(since), startedAt);
      const gestureMs = Math.round((await page.evaluate(() => window.lab.now())) - startedAt);

      // Exactly one persisted move, for this ticket, into the armed column.
      const moves = await page.evaluate((n) => window.lab.moves.slice(n), movesBefore);
      assert.equal(moves.length, 1, `${label}: expected 1 move call, got ${JSON.stringify(moves)}`);
      const [move] = moves;
      assert.equal(move.ok, true, `${label}: move refused: ${move.error}`);
      assert.equal(
        move.input.ticketId ?? move.input.ticketIds?.[0],
        sourceId,
        `${label}: wrong ticket moved`,
      );
      assert.equal(move.input.toStatus, to, `${label}: wrong target column`);

      // Store == persisted truth; ticket sits at the slot the drop named.
      const after = await snapshot();
      const persistedTarget = move.tickets.filter((t) => t.status === to).toSorted(byOrder);
      const storeTarget = after.filter((t) => t.status === to).toSorted(byOrder);
      assert.deepEqual(
        storeTarget.map((t) => t.id),
        persistedTarget.map((t) => t.id),
        `${label}: store diverged from the persisted roster`,
      );
      const moved = after.find((t) => t.id === sourceId);
      assert.equal(moved?.status, to, `${label}: ticket did not land in ${to}`);
      const index = storeTarget.findIndex((t) => t.id === sourceId);
      assert.equal(
        index,
        move.input.toIndex,
        `${label}: landed at index ${index}, drop named ${move.input.toIndex}`,
      );
      assert.equal(after.length, before.length, `${label}: ticket count changed`);
      // The DOM agrees with the store (no blank/stale column after churn). A
      // windowed column (VC-316) mounts a contiguous slice, so the mounted ids
      // must be exactly the store's slice starting at the first mounted row.
      const mounted = await domIds(to);
      const storeIds = storeTarget.map((t) => t.id);
      const first = storeIds.indexOf(mounted[0]);
      assert.ok(mounted.length > 0 && first >= 0, `${label}: ${to} column mounted nothing known`);
      assert.deepEqual(
        mounted,
        storeIds.slice(first, first + mounted.length),
        `${label}: DOM ≠ store in ${to}`,
      );
      assert.ok(mounted.includes(sourceId), `${label}: dropped card not mounted in ${to}`);
      assert.equal(
        (await domIds(from)).includes(sourceId),
        false,
        `${label}: ticket still in ${from}`,
      );

      // The Automation armed exactly once, and the countdown projection holds it.
      const armings = await page.evaluate((n) => window.lab.armings.slice(n), armingsBefore);
      assert.equal(
        armings.length,
        1,
        `${label}: armed ${armings.length} times: ${JSON.stringify(armings)}`,
      );
      assert.deepEqual(armings[0], { ticketId: sourceId, status: to, automationId: ARMED[to] });
      const pending = await page.evaluate(
        (id) => ({
          held: window.lab.pendingByTicket.has(id),
          size: window.lab.pendingByTicket.size,
          projected: window.lab.pendingCount(),
        }),
        sourceId,
      );
      assert.equal(pending.held, true, `${label}: no pending armed run for the ticket`);
      assert.equal(pending.projected, pending.size, `${label}: armed-run projection out of sync`);

      results.passed += 1;
      stallTotals.longTasks += stall.longTasks ?? 0;
      stallTotals.longTaskMs += stall.longTaskMs ?? 0;
      stallTotals.longestTaskMs = Math.max(stallTotals.longestTaskMs, stall.longestTaskMs ?? 0);
      stallTotals.frameGaps += stall.frameGaps;
      stallTotals.worstFrameGapMs = Math.max(stallTotals.worstFrameGapMs, stall.worstFrameGapMs);
      console.log(
        `PASS ${label}: ${gestureMs}ms churns=${midChurns} rects=${midMeasures} toIndex=${move.input.toIndex} ` +
          `longTasks=${stall.longTasks ?? "n/a"} (${stall.longTaskMs ?? "n/a"}ms, longest ${stall.longestTaskMs ?? "n/a"}ms) ` +
          `frameGaps>100ms=${stall.frameGaps} (worst ${stall.worstFrameGapMs}ms)`,
      );
    } catch (error) {
      results.failed += 1;
      results.failures.push({ iteration, label, error: error.message });
      console.log(`FAIL ${label}: ${error.message}`);
      if (fatal.length > 0) {
        console.log("--- fatal console/page errors ---");
        for (const line of fatal) console.log(line);
        console.log("--- end ---");
        break; // the board is gone; further gestures would only report the same crash
      }
      // Leave no input held: a stuck modifier would steer every later drop through the picker.
      if (altHeld) await alt(false).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.mouse.up().catch(() => {});
      await page.evaluate(() => window.lab.stopPump()).catch(() => {});
      await page
        .waitForFunction(() => !document.querySelector("[data-board-drag]"), null, {
          timeout: 5000,
        })
        .catch(() => {});
    }
  }
  console.log(
    `stalls over passing gestures: longTasks=${stallTotals.longTasks} (${stallTotals.longTaskMs}ms total, ` +
      `longest ${stallTotals.longestTaskMs}ms), frameGaps>100ms=${stallTotals.frameGaps} (worst ${stallTotals.worstFrameGapMs}ms)`,
  );

  const totalChurns = await page.evaluate(() => window.lab.churns).catch(() => -1);
  const rawSetState = await page.evaluate(() => window.lab.rawSetState === true).catch(() => false);
  const mutations = await page.evaluate(() => window.lab.mutations).catch(() => 0);
  console.log(
    `\nSUMMARY: ${results.passed} passed, ${results.failed} failed of ${ITERATIONS}; ` +
      `${totalChurns} roster replacements injected via ${rawSetState ? "raw setState (old checkout)" : "hydrateProjectRoster"}` +
      `${MUTATE ? ` (${mutations} ticket value mutations)` : ""}; ` +
      `${consoleErrors.length} console errors total`,
  );
  if (consoleErrors.length > 0) {
    console.log("console errors (all):");
    for (const line of consoleErrors.slice(0, 20)) console.log(`  ${line.slice(0, 300)}`);
  }
  await page.close();
} finally {
  await browser.close();
  if (CONTROL_REV) rmSync(CONTROL_DIR, { recursive: true, force: true });
}

if (results.failed > 0) {
  console.log(`FAILURES: ${JSON.stringify(results.failures, null, 2)}`);
  process.exit(1);
}
console.log(
  `PASS: ${results.passed}/${ITERATIONS} drag→armed-column gestures under mid-gesture roster churn`,
);
