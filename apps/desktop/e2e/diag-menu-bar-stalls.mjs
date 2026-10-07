/**
 * DIAGNOSTIC (VC-716) — TEMPORARY, never in the final diff.
 *
 * One isolated app per invocation; main-thread stall attribution around
 * menu-bar entry. Variants (argv[2]):
 *   early        — enter as soon as the socket answers (what the smoke does)
 *   late         — enter 25 s after launch, once boot has quiesced
 *   late-dock    — `late` with VOLLI_QUIET_WINDOWS=0, so dock.hide() is real
 *   noenter-on   — cloud flag on, never enter: startup only
 *   noenter-off  — cloud flag OFF (a canary user's default), never enter
 * argv[3] is the run tag. Output: `$VOLLI_DIAG_OUT/<tag>-*.json|.cpuprofile`
 * from main, plus `<tag>-smoke.json` from this side (renderer long tasks,
 * flush and destroy timings).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  identifyRequest,
  makeShortScratch,
  requestOverSocket,
  socketPathFor,
} from "./lib/agent-kit.mjs";
import { closeAppBounded, childHasExited, launch, sleep, waitUntil } from "./lib/smoke-kit.mjs";

const variant = process.argv[2] ?? "early";
const tag = process.argv[3] ?? `${variant}-${Date.now()}`;
const outDir = process.env.VOLLI_DIAG_OUT ?? "/tmp/volli-diag";
const profile = process.env.VOLLI_DIAG_PROFILE ?? "1";

const { userDataDir, dbPath, cleanup } = await makeShortScratch("diag");
const socketPath = socketPathFor(userDataDir);

async function identifies() {
  try {
    const response = await requestOverSocket(socketPath, identifyRequest(userDataDir));
    return response?.v === 1 && typeof response?.ok === "boolean";
  } catch {
    return false;
  }
}

const flagOn = variant !== "noenter-off";
const dflDelay = /^dfl\+(\d+)/.exec(variant)?.[1];
const crashFirst = variant.endsWith("-crash");
const enters =
  variant === "early" || variant === "late" || variant === "late-dock" || dflDelay !== undefined;
const t0 = Date.now();
const smoke = { variant, tag, events: [] };
const ev = (name, extra = {}) => smoke.events.push({ name, ms: Date.now() - t0, ...extra });

const app = await launch({
  dbPath,
  userDataDir,
  extraEnv: {
    ...(flagOn ? { VOLLI_EXPERIMENTAL: "cloud" } : { VOLLI_EXPERIMENTAL: "" }),
    VOLLI_SMOKE_MENU_BAR_HOST: "1",
    VOLLI_SMOKE_MENU_BAR_SETTLE_MS: "120000",
    VOLLI_DIAG_DIR: outDir,
    VOLLI_DIAG_TAG: tag,
    VOLLI_DIAG_PROFILE: profile,
    ...(variant === "late-dock" ? { VOLLI_QUIET_WINDOWS: "0" } : {}),
    ...(crashFirst ? { VOLLI_DIAG_DESTROY_MODE: "crash-first" } : {}),
    ...(variant.endsWith("-nohide") ? { VOLLI_DIAG_SKIP_HIDE: "1" } : {}),
    ...(variant.endsWith("-loud") ? { VOLLI_QUIET_WINDOWS: "0" } : {}),
  },
});
const child = app.process();
let code = 0;
try {
  ev("launched");
  const page = await app.firstWindow();
  ev("firstWindow");
  await page.waitForLoadState("domcontentloaded");
  ev("domcontentloaded");
  await page.evaluate(() => {
    const tasks = [];
    globalThis.volliDiagLongTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.push([Math.round(entry.startTime), Math.round(entry.duration)]);
      }
    }).observe({ type: "longtask", buffered: true });
  });
  const socket = await waitUntil("agent socket", () => identifies().then((ok) => ok || null), {
    timeout: 30000,
  }).catch(() => false);
  ev("socket", { ok: socket === true });
  smoke.processStartOffset = await app.evaluate(() => Date.now() - globalThis.volliDiag.now());

  if (variant.startsWith("late")) await sleep(Math.max(0, 25_000 - (Date.now() - t0)));
  if (dflDelay !== undefined) {
    const sinceDfl = await waitUntil(
      "did-finish-load",
      () =>
        app.evaluate(() => {
          const d = globalThis.volliDiag;
          const at = d.markAt("mainWindow.did-finish-load");
          return at === undefined ? null : d.now() - at;
        }),
      { timeout: 30000, interval: 50 },
    );
    await sleep(Math.max(0, Number(dflDelay) - sinceDfl));
    if (variant.endsWith("-waitpaint")) {
      const t = Date.now();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
          ),
      );
      smoke.waitPaintMs = Date.now() - t;
    }
  }
  if (enters) {
    const rendererAge = await page.evaluate(() => Math.round(performance.now()));
    const homeRail = await page.getByTestId("home-rail").count();
    ev("pre-enter", { rendererAge, homeRail });
    smoke.startupPhase = await app.evaluate(() => globalThis.volliDiag.phase("startup"));
    smoke.preEnterLongTasks = await page.evaluate(() => globalThis.volliDiagLongTasks.slice());
    await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
    const entered = await app.evaluate(({ BrowserWindow }) => {
      const startedAt = globalThis.volliDiag.now();
      globalThis.volliMenuBarHost.enter();
      const syncMs = globalThis.volliDiag.now() - startedAt;
      globalThis.volliDiagEnteredAt = startedAt;
      return { at: startedAt, syncMs, windows: BrowserWindow.getAllWindows().length };
    });
    ev("entered", entered);
    const destroyedAfterMs = await waitUntil(
      "windows destroyed",
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().length === 0
            ? globalThis.volliDiag.now() - globalThis.volliDiagEnteredAt
            : null,
        ),
      { timeout: 15000, interval: 100 },
    ).catch(() => -1);
    smoke.metricsOverDestroy = await app.evaluate(({ app: electronApp }) =>
      electronApp
        .getAppMetrics()
        .map((m) => ({ type: m.type, name: m.name, cpu: Math.round(m.cpu.percentCPUUsage) })),
    );
    smoke.dflToEnter = await app.evaluate(
      () =>
        globalThis.volliDiagEnteredAt - globalThis.volliDiag.markAt("mainWindow.did-finish-load"),
    );
    ev("destroyed", { destroyedAfterMs });
    await sleep(10_000);
    smoke.postEnterPhase = await app.evaluate(() => globalThis.volliDiag.phase("post-enter"));
  } else {
    await sleep(Math.max(0, 40_000 - (Date.now() - t0)));
    smoke.startupPhase = await app.evaluate(() => globalThis.volliDiag.phase("startup-40s"));
    smoke.preEnterLongTasks = await page.evaluate(() => globalThis.volliDiagLongTasks.slice());
  }
  smoke.socketAtEnd = await identifies();
  smoke.dump = await app.evaluate(() => globalThis.volliDiag.dump("end"));
  ev("dumped");
} catch (error) {
  console.error("DIAG ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await writeFile(join(outDir, `${tag}-smoke.json`), JSON.stringify(smoke, null, 1)).catch(
    () => {},
  );
  if (!childHasExited(child)) await closeAppBounded(app).catch(() => {});
  await cleanup().catch(() => {});
}
console.log(JSON.stringify(smoke));
process.exit(code);
