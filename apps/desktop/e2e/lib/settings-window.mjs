/**
 * Driving the native Settings window from a Playwright smoke.
 *
 * Settings is a real second BrowserWindow that loads the same renderer entry as
 * `#settings`. The workbench page must never grow a Settings dialog again, so
 * every smoke that used to click Settings and then read the main page's rail
 * goes through here instead: open the real sidebar button, find the new native
 * page, and hand that page back for the actual assertions.
 *
 * The window is a singleton. A second Settings entry must reuse it, which means
 * a click may create a `window` event or may simply raise the existing page —
 * both paths are handled and the result is the same page object.
 */
import { waitUntil } from "./smoke-kit.mjs";

const SETTINGS_HASH = "#settings";
const SETTINGS_PANEL = "[data-settings-panel]";

/** The URL's hash, or "" while a page is still `about:blank` / malformed. */
function hashOf(page) {
  try {
    return new URL(page.url()).hash;
  } catch {
    return "";
  }
}

/** Every live page whose URL is the native Settings entry. */
export function settingsPages(app) {
  return app.windows().filter((page) => !page.isClosed() && hashOf(page) === SETTINGS_HASH);
}

/** The one live Settings page, or null. */
export function settingsPageOf(app) {
  return settingsPages(app).at(-1) ?? null;
}

/** The Settings button every workbench surface carries in its sidebar footer. */
async function clickSettings(mainPage, timeout) {
  const button = mainPage.getByRole("button", { name: "Settings", exact: true }).first();
  await button.waitFor({ state: "visible", timeout });
  await button.click();
}

async function waitForSettingsHash(page, timeout) {
  await waitUntil(
    "the native Settings page to carry #settings",
    () => {
      if (page.isClosed()) throw new Error("the Settings page closed before it settled");
      return hashOf(page) === SETTINGS_HASH ? page : null;
    },
    { timeout },
  );
}

/**
 * Native windows, split by role. Read in Electron main so the answer is about
 * BrowserWindows rather than Playwright Pages.
 */
async function nativeWindowState(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map((window) => {
        let url = "";
        try {
          url = window.webContents.getURL();
        } catch {
          // A window being torn down still counts; its page is simply gone.
        }
        let hash = "";
        try {
          hash = new URL(url).hash;
        } catch {
          // `about:blank` while the renderer is still booting.
        }
        return {
          id: window.id,
          url,
          hash,
          title: window.getTitle(),
          visible: window.isVisible(),
        };
      });
    return {
      windows,
      settings: windows.filter((window) => window.hash === "#settings"),
    };
  });
}

/**
 * Assert the native/window story behind one open Settings page:
 *
 *  - the workbench has no Settings dialog (`[data-settings-panel]`) in it;
 *  - the Settings surface is in a separate BrowserWindow, and that window is
 *    visible (native `ready-to-show` + renderer-ready, not just a loaded page);
 *  - the two pages expose the same preload hydration (`window.api` keys), so
 *    the Settings window is not a second, reduced bridge.
 *
 * Returns the evidence used by the caller's PASS line. Throws with the whole
 * reading when any part is false — a smoke should fail on the cause, not on a
 * later locator timeout.
 */
export async function assertSettingsWindow(app, mainPage, settingsPage, { timeout = 10_000 } = {}) {
  if (mainPage.isClosed()) throw new Error("the workbench page is closed");
  if (settingsPage.isClosed()) throw new Error("the Settings page is closed");

  await waitUntil(
    "the workbench to have no in-page Settings dialog",
    async () => ((await mainPage.locator(SETTINGS_PANEL).count()) === 0 ? true : null),
    { timeout },
  );

  const [mainApiKeys, settingsApiKeys] = await Promise.all([
    mainPage.evaluate(() => Object.keys(window.api ?? {}).toSorted()),
    settingsPage.evaluate(() => Object.keys(window.api ?? {}).toSorted()),
  ]);
  const samePreloadHydration =
    mainApiKeys.length > 0 &&
    mainApiKeys.length === settingsApiKeys.length &&
    mainApiKeys.every((key, index) => key === settingsApiKeys[index]) &&
    settingsApiKeys.includes("settingsWindow");

  const native = await waitUntil(
    "the native Settings BrowserWindow to show",
    async () => {
      const state = await nativeWindowState(app);
      return state.settings.length === 1 && state.settings[0].visible ? state : null;
    },
    { timeout },
  );

  const pageUrl = settingsPage.url();
  const nativeSettings =
    native.settings.find((window) => window.url === pageUrl) ?? native.settings[0];
  const mainHasSettingsDialog =
    (await mainPage.locator(SETTINGS_PANEL).count()) > 0 ||
    (await mainPage.getByRole("navigation", { name: "Settings categories" }).count()) > 0;
  const settingsHasPanel = (await settingsPage.locator(SETTINGS_PANEL).count()) > 0;
  const settingsHash = hashOf(settingsPage);
  const mainHash = hashOf(mainPage);

  const evidence = {
    nativeWindowId: nativeSettings?.id ?? null,
    nativeWindowCount: native.windows.length,
    nativeSettingsCount: native.settings.length,
    mainHasSettingsDialog,
    settingsHash,
    mainHash,
    samePreloadHydration,
    mainApiKeyCount: mainApiKeys.length,
    settingsApiKeyCount: settingsApiKeys.length,
  };

  const ok =
    !mainHasSettingsDialog &&
    native.windows.length >= 2 &&
    native.settings.length === 1 &&
    nativeSettings !== undefined &&
    nativeSettings.visible &&
    settingsHasPanel &&
    settingsHash === SETTINGS_HASH &&
    mainHash !== SETTINGS_HASH &&
    samePreloadHydration;

  if (!ok) {
    throw new Error(
      `Settings is not a separate, visible, same-preload native window: ${JSON.stringify(evidence)}`,
    );
  }
  return evidence;
}

/**
 * Open Settings from the real workbench button, or raise the existing window.
 *
 * The click is armed with `waitForEvent("window")` only when no Settings page
 * exists. A singleton reuse has no event to wait for, so `app.windows()` is the
 * fallback for both paths — and for the narrow race where the old page is
 * closing as the next one is created.
 */
export async function openSettingsWindow(app, mainPage, { timeout = 20_000 } = {}) {
  const existing = settingsPageOf(app);
  const created =
    existing === null ? app.waitForEvent("window", { timeout }).catch(() => null) : null;
  // An existing window that has not reached #settings yet emits no `window`
  // event, so the page scan races the event rather than waiting it out.
  const discovered = waitUntil("the native Settings page", () => settingsPageOf(app), {
    timeout,
  }).catch(() => null);

  await clickSettings(mainPage, timeout);

  let settingsPage = existing;
  if (settingsPage === null || settingsPage.isClosed()) {
    settingsPage = await Promise.race([created ?? Promise.resolve(null), discovered]);
  }
  if (settingsPage === null || settingsPage.isClosed()) settingsPage = await discovered;

  await settingsPage.waitForLoadState("domcontentloaded", { timeout });
  await waitForSettingsHash(settingsPage, timeout);
  await settingsPage.locator(SETTINGS_PANEL).waitFor({ state: "attached", timeout });
  await assertSettingsWindow(app, mainPage, settingsPage, { timeout });
  return settingsPage;
}

/**
 * Close one Settings page through its BrowserWindow (the native close path),
 * then wait until no Settings BrowserWindow is left. The workbench is never
 * touched; close/reopen journeys assert that separately.
 */
export async function closeSettingsWindow(app, settingsPage, { timeout = 10_000 } = {}) {
  if (settingsPage.isClosed()) return;
  const pageUrl = settingsPage.url();
  const closed = settingsPage.waitForEvent("close", { timeout }).catch(() => null);

  await app.evaluate(({ BrowserWindow }, targetUrl) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      try {
        return candidate.webContents.getURL() === targetUrl;
      } catch {
        return false;
      }
    });
    if (window === undefined) throw new Error("no BrowserWindow carries the Settings page URL");
    window.close();
  }, pageUrl);

  await closed;
  await waitUntil(
    "the native Settings BrowserWindow to close",
    async () => ((await nativeWindowState(app)).settings.length === 0 ? true : null),
    { timeout },
  );
}
