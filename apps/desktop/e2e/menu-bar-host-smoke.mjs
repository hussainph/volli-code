/**
 * Menu-bar mode's mechanics on the BUILT app (VC-577), credential-free so the
 * macOS CI lane runs it.
 *
 * A runner has no model, so nothing can keep a turn live; the turn journey —
 * ⌘Q mid-turn, the turn finishes windowless, the relaunch shows it completed —
 * is `menu-bar-turn-smoke.mjs`, which needs real Pi credentials and is
 * therefore excluded from CI structurally (see `run-smokes.mjs`). This probe
 * enters the mode through the controller itself (the dev-only
 * `VOLLI_SMOKE_MENU_BAR_HOST` seam, two locks like the browser-host seam) and
 * proves everything around the turn:
 *
 *   1. With `VOLLI_EXPERIMENTAL=cloud`, the app boots and exposes the seam.
 *   2. Entering menu-bar mode closes every window, keeps the process and the
 *      agent socket alive (raw `volli` identify still answers), and holds the
 *      mode.
 *   3. macOS reopen (`activate`) with no window brings a window back with the
 *      renderer loaded and leaves the mode — the same in-process host.
 *   4. Entering again with no live work drains then exits on its own: today's
 *      quit path, exit 0, socket removed — and no sooner than the settle.
 *
 * Nothing is live, so each entry starts the drain-exit's settle window at
 * once, and checks 2 and 3 must finish inside it. A release's 5 s is less
 * than the draft flush alone can take on a contended runner (VC-709: main
 * stalls for seconds while the app boots, and entry plus flush ran 0.3–6 s),
 * so the smoke asks for a longer settle through
 * `VOLLI_SMOKE_MENU_BAR_SETTLE_MS` — behind the same two locks as the seam,
 * and only ever longer than a release's (`menuBarSmokeSettleMs`).
 *
 * Run after the desktop build:
 *   node apps/desktop/e2e/menu-bar-host-smoke.mjs
 *
 * MANUALLY-RUN locally (needs a display + the built app); CI runs it in the
 * desktop smoke lanes.
 */
import {
  identifyRequest,
  makeShortScratch,
  requestOverSocket,
  socketPathFor,
} from "./lib/agent-kit.mjs";
import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  childHasExited,
  closeAppBounded,
  createRunner,
  launch,
  pathExists,
  waitForChildExit,
  waitUntil,
} from "./lib/smoke-kit.mjs";

if (process.platform !== "darwin") {
  console.error(
    `menu-bar-host-smoke is macOS-only (got platform "${process.platform}"): ` +
      "menu-bar mode is the Mac host's quit path.",
  );
  process.exit(1);
}

const { userDataDir, dbPath, cleanup } = await makeShortScratch("mbar");
const { must, attempt, summarize } = createRunner();
const socketPath = socketPathFor(userDataDir);

/**
 * Main's own bound on the windows' draft flush (`MENU_BAR_FLUSH_OVERDUE_MS`):
 * past it main logs the windows as overdue and keeps them hidden, never
 * destroyed, so a window still alive here is a failure, not a slow runner.
 */
const FLUSH_OVERDUE_MS = 10_000;
/**
 * The drain-exit's settle window for this run (VC-709): the flush bound plus
 * room for the socket read and the reopen, so checks 2 and 3 never race the
 * host's own exit. `menuBarSmokeSettleMs` only honours values above a
 * release's 5 s.
 */
const SETTLE_MS = 20_000;
/** The settle window plus teardown, with room for a loaded runner. */
const DRAIN_EXIT_TIMEOUT_MS = SETTLE_MS + 30_000;

// DIAGNOSTIC (VC-716).
const DIAG_DIR = process.env.VOLLI_DIAG_SMOKE_DIR || undefined;
const DIAG_TAG = `shard-${Date.now()}`;
const diagSide = { tag: DIAG_TAG };
async function diagEval(app, fn, arg) {
  if (DIAG_DIR === undefined) return null;
  return app.evaluate(fn, arg).catch((error) => ({ error: String(error?.message ?? error) }));
}

async function identifies() {
  try {
    const response = await requestOverSocket(socketPath, identifyRequest(userDataDir));
    return response?.v === 1 && typeof response?.ok === "boolean";
  } catch {
    return false;
  }
}

async function main() {
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      VOLLI_EXPERIMENTAL: "cloud",
      VOLLI_SMOKE_MENU_BAR_HOST: "1",
      VOLLI_SMOKE_MENU_BAR_SETTLE_MS: String(SETTLE_MS),
      // DIAGNOSTIC (VC-716): this one app only, never its shard neighbours.
      ...(DIAG_DIR === undefined
        ? {}
        : { VOLLI_DIAG_DIR: DIAG_DIR, VOLLI_DIAG_TAG: DIAG_TAG, VOLLI_DIAG_PROFILE: "1" }),
    },
  });
  const child = app.process();
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    assertBuiltRendererLoaded(page);

    await must(1, "the cloud flag is on and the menu-bar seam is present", async () => {
      const seam = await app.evaluate(
        () => typeof globalThis.volliMenuBarHost?.enter === "function",
      );
      const socket = await waitUntil("agent socket", () => identifies().then((ok) => ok || null), {
        timeout: 20000,
      }).catch(() => false);
      return { ok: seam && socket === true, detail: `seam=${seam} socket=${socket === true}` };
    });

    await must(
      2,
      "entering menu-bar mode closes every window; process and socket live on",
      async () => {
        // Nothing is running, so this entry starts the drain-exit's settle
        // window (SETTLE_MS) at once: checks 2 and 3 run inside it.
        // Entry hides every window at once, asks each renderer to flush its
        // pending drafts, and destroys each window only from its own ack
        // (`client-state-flush.ts`; overdue after FLUSH_OVERDUE_MS), so the
        // count is polled up to main's own bound.
        diagSide.startupPhase = await diagEval(app, () => globalThis.volliDiag.phase("startup"));
        diagSide.rendererAge = await page.evaluate(() => Math.round(performance.now()));
        diagSide.homeRail = await page.getByTestId("home-rail").count();
        const entered = await app.evaluate(({ BrowserWindow }) => {
          const host = globalThis.volliMenuBarHost;
          const startedAt = Date.now();
          const perfAt = globalThis.volliDiag?.now();
          host.enter();
          if (perfAt !== undefined) {
            globalThis.volliDiagEnter = { at: perfAt, syncMs: globalThis.volliDiag.now() - perfAt };
          }
          globalThis.volliMenuBarEnteredAt = startedAt;
          return {
            visible: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
            resident: host.isResident(),
          };
        });
        const destroyedAfterMs = await waitUntil(
          "windows destroyed after the draft flush",
          () =>
            app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().length === 0
                ? Date.now() - globalThis.volliMenuBarEnteredAt
                : null,
            ),
          { timeout: FLUSH_OVERDUE_MS },
        ).catch(() => -1);
        const socket = await identifies();
        const alive = !childHasExited(child);
        // Still in the mode after the reads: the socket answered a resident
        // host, not one already on its way out.
        const after = alive
          ? await app.evaluate(() => ({
              resident: globalThis.volliMenuBarHost.isResident(),
              ms: Date.now() - globalThis.volliMenuBarEnteredAt,
            }))
          : { resident: false, ms: -1 };
        return {
          ok:
            entered.visible === 0 &&
            entered.resident &&
            destroyedAfterMs >= 0 &&
            socket &&
            alive &&
            after.resident,
          detail:
            `visibleAfterEnter=${entered.visible} resident=${entered.resident} ` +
            `destroyedAfterMs=${destroyedAfterMs} socket=${socket} alive=${alive} ` +
            `residentAfter=${after.resident} readAtMs=${after.ms}`,
        };
      },
    );

    await must(3, "macOS reopen with no window recreates it and leaves the mode", async () => {
      const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        // Inside the settle: the host has not begun its own exit.
        const atMs = Date.now() - globalThis.volliMenuBarEnteredAt;
        electronApp.emit("activate");
        return {
          atMs,
          windows: BrowserWindow.getAllWindows().length,
          resident: globalThis.volliMenuBarHost.isResident(),
        };
      });
      const reopened = await waitUntil(
        "the reopened window's renderer",
        async () => {
          const pages = app.windows();
          const live = pages.at(-1);
          if (live === undefined || live.isClosed()) return null;
          await live.waitForLoadState("domcontentloaded");
          return live;
        },
        { timeout: 20000 },
      );
      assertBuiltRendererLoaded(reopened);
      const socket = await identifies();
      if (DIAG_DIR !== undefined) {
        diagSide.enter = await diagEval(app, () => globalThis.volliDiagEnter);
        diagSide.postEnterPhase = await diagEval(app, () =>
          globalThis.volliDiag.phase("post-enter"),
        );
        diagSide.dump = await diagEval(app, () => globalThis.volliDiag.dump("end"));
        diagSide.processStartOffset = await diagEval(
          app,
          () => Date.now() - globalThis.volliDiag.now(),
        );
        const { writeFile } = await import("node:fs/promises");
        await writeFile(`${DIAG_DIR}/${DIAG_TAG}-smoke.json`, JSON.stringify(diagSide)).catch(
          () => {},
        );
        console.log(`  [DIAG] ${JSON.stringify(diagSide)}`);
      }
      return {
        ok: state.windows === 1 && state.resident === false && socket,
        detail:
          `windows=${state.windows} resident=${state.resident} socket=${socket} ` +
          `activateAtMs=${state.atMs}`,
      };
    });

    await attempt(4, "with no live work, menu-bar mode drains and exits 0 on its own", async () => {
      // Taken before entry, so the elapsed time can only overstate how long
      // after entry the host exited: under SETTLE_MS is an exit that did not
      // wait out the settle.
      const before = Date.now();
      await app.evaluate(() => globalThis.volliMenuBarHost.enter());
      const exit = await waitForChildExit(child, "drain-then-exit", {
        timeout: DRAIN_EXIT_TIMEOUT_MS,
      });
      const exitAfterMs = Date.now() - before;
      const socketGone = await waitUntil(
        "socket removal",
        async () => (!(await pathExists(socketPath)) ? true : null),
        { timeout: 10000 },
      ).catch(() => false);
      return {
        ok: exit.code === 0 && socketGone === true && exitAfterMs >= SETTLE_MS,
        detail:
          `exit=${exit.code} signal=${exit.signal ?? "none"} socketGone=${socketGone === true} ` +
          `exitAfterMs=${exitAfterMs} settleMs=${SETTLE_MS}`,
      };
    });
  } finally {
    if (!childHasExited(child)) await closeAppBounded(app).catch(() => {});
  }
  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup().catch(() => {});
}
process.exit(code);
