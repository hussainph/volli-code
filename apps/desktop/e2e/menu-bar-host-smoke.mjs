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
 *      quit path, exit 0, socket removed.
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

/** The settle window plus teardown, with room for a loaded runner. */
const DRAIN_EXIT_TIMEOUT_MS = 30_000;

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
    extraEnv: { VOLLI_EXPERIMENTAL: "cloud", VOLLI_SMOKE_MENU_BAR_HOST: "1" },
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
        // window (5s) at once: checks 2 and 3 read fast and reopen inside it.
        // Entry hides every window at once, asks each renderer to flush its
        // pending drafts, and destroys the windows only after the ack
        // (bounded at 1s; `client-state-flush.ts`), so the count is polled.
        const entered = await app.evaluate(({ BrowserWindow }) => {
          const host = globalThis.volliMenuBarHost;
          const startedAt = Date.now();
          host.enter();
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
          { timeout: 5000 },
        ).catch(() => -1);
        const socket = await identifies();
        const alive = !childHasExited(child);
        return {
          ok: entered.visible === 0 && entered.resident && destroyedAfterMs >= 0 && socket && alive,
          detail:
            `visibleAfterEnter=${entered.visible} resident=${entered.resident} ` +
            `destroyedAfterMs=${destroyedAfterMs} socket=${socket} alive=${alive}`,
        };
      },
    );

    await must(3, "macOS reopen with no window recreates it and leaves the mode", async () => {
      const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        electronApp.emit("activate");
        return {
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
      return {
        ok: state.windows === 1 && state.resident === false && socket,
        detail: `windows=${state.windows} resident=${state.resident} socket=${socket}`,
      };
    });

    await attempt(4, "with no live work, menu-bar mode drains and exits 0 on its own", async () => {
      await app.evaluate(() => globalThis.volliMenuBarHost.enter());
      const exit = await waitForChildExit(child, "drain-then-exit", {
        timeout: DRAIN_EXIT_TIMEOUT_MS,
      });
      const socketGone = await waitUntil(
        "socket removal",
        async () => (!(await pathExists(socketPath)) ? true : null),
        { timeout: 10000 },
      ).catch(() => false);
      return {
        ok: exit.code === 0 && socketGone === true,
        detail: `exit=${exit.code} signal=${exit.signal ?? "none"} socketGone=${socketGone === true}`,
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
