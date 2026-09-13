/**
 * VC-329: real-layout regression for the SortableTicketShell update-depth loop.
 * Run a worktree Lab first, then:
 *   VOLLI_LAB_PORT=5189 pnpm smoke:board-sort-loop
 * Uses fixture IPC only; no real tickets, Automations, or Sessions are started.
 * DOM order and parentage must stay fixed while the detached card previews a move.
 * Repeated cross-column drags exercise both successful commits and rollbacks.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

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

try {
  for (const refuse of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1480, height: 920 },
      reducedMotion: "no-preference",
    });
    // Dev-server startup can be slow on a machine running several worktrees;
    // gesture waits below are bounded independently of module loading.
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /Maximum update depth|Too many re-renders/.test(message.text())
      )
        errors.push(message.text());
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300000 });
    await page.locator('[data-column-arming="doing"][data-arming-state="ready"]').waitFor();
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
    await page.evaluate((simulateRefusal) => {
      const bridge = window.api;
      window.labMoveResults = [];
      const ticketBridge = new Proxy(bridge.tickets, {
        get(target, key) {
          if (key !== "move" && key !== "moveMany") return Reflect.get(target, key);
          return async (input) => {
            const result = simulateRefusal
              ? { ok: false, error: "Simulated move refusal for regression check" }
              : await target[key](input);
            window.labMoveResults.push({ input, ok: result.ok, error: result.error });
            return result;
          };
        },
      });
      window.api = new Proxy(bridge, {
        get(target, key) {
          return key === "tickets" ? ticketBridge : Reflect.get(target, key);
        },
      });
    }, refuse);
    const checkErrors = () =>
      assert.deepEqual(errors, [], `React errors (${refuse ? "rollback" : "commit"})`);
    const column = (status) => page.locator(`[data-column-dropzone="${status}"]`);
    const ids = (status) =>
      column(status)
        .locator("[data-board-ticket-slot]")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.boardTicketSlot));
    const snapshot = () =>
      page.evaluate(async () => {
        const { useBoardStore } = await import("/src/stores/board.ts");
        return useBoardStore
          .getState()
          .ticketsByProject["prj-voltaic"].map(({ id, status, order }) => ({ id, status, order }));
      });
    for (let turn = 0; turn < 6; turn++) {
      const from = turn % 2 ? "doing" : "todo";
      const to = turn % 2 ? "todo" : "doing";
      const before = await snapshot();
      const sourceIds = await ids(from);
      const targetIds = await ids(to);
      const sourceId = sourceIds[turn % sourceIds.length];
      const source = column(from).locator(`[data-board-ticket-slot="${sourceId}"]`);
      await source.scrollIntoViewIfNeeded();
      const start = await source.boundingBox();
      const target = await column(to).boundingBox();
      await page.mouse.move(start.x + start.width / 2, start.y + 20);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2 + 10, start.y + 22, { steps: 3 });
      await page.locator("[data-board-drag]").waitFor();
      // Hover a sibling before crossing; only transforms may preview this order.
      const siblingId = sourceIds.find((id) => id !== sourceId);
      const sibling = await column(from)
        .locator(`[data-board-ticket-slot="${siblingId}"]`)
        .boundingBox();
      await page.mouse.move(sibling.x + sibling.width / 2, sibling.y + 20, { steps: 6 });
      assert.deepEqual(await ids(from), sourceIds, "same-column hover reordered measured nodes");
      for (const fraction of [0.1, 0.5, 0.9, 0.3, 0.7, 0.02, 0.95]) {
        const x = target.x + target.width / 2;
        const y = target.y + target.height * fraction;
        await page.mouse.move(x, y, { steps: 6 });
        if (turn % 2) {
          await page.keyboard.down("Alt");
          await page.mouse.move(x + 2, y + 1);
          await page.locator('[data-offered-panel="expanded"]').waitFor();
          await page.keyboard.up("Alt");
        }
        checkErrors();
        assert.deepEqual(
          await ids(from),
          sourceIds,
          "cross-column hover reparented the measured source",
        );
        assert.deepEqual(
          await ids(to),
          targetIds,
          "cross-column hover changed the measured target",
        );
      }
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector("[data-board-drag]"));
      // Let the 200ms drop transition finish: layout changes after release were
      // also part of the reported failure, especially after a refused mutation.
      await page.waitForTimeout(300);
      checkErrors();
      const after = await snapshot();
      if (refuse) assert.deepEqual(after, before, "refused move did not roll back");
      else
        assert.equal(
          after.find((ticket) => ticket.id === sourceId).status,
          to,
          JSON.stringify(await page.evaluate(() => window.labMoveResults)),
        );
      console.log(`${refuse ? "rollback" : "commit"}: drag ${turn + 1}/6 passed`);
    }
    // Escape must leave the durable fixture untouched, even after those drags.
    const beforeCancel = await snapshot();
    const source = await column("todo").locator("[data-board-ticket-slot]").first().boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + 20);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 20, source.y + 24, { steps: 4 });
    await page.locator("[data-board-drag]").waitFor();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.deepEqual(await snapshot(), beforeCancel);
    checkErrors();
    await page.close();
  }
  console.log(
    "PASS: stable measured order/parents, 12 cross-column commits/rollbacks, Option picker, and cancellation",
  );
} finally {
  await browser.close();
}
