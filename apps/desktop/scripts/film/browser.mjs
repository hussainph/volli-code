import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

/** Reuse a cached test browser, never a person's Chrome profile. */
export function captureBrowser() {
  const installed = chromium.executablePath();
  if (existsSync(installed)) return installed;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  for (const version of readdirSync(cache)
    .filter((v) => /^chromium-\d+$/.test(v))
    .toSorted()
    .toReversed()) {
    const path = join(
      cache,
      version,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
    if (existsSync(path)) return path;
  }
  throw new Error("Install a Playwright Chromium test browser before capturing.");
}

/** Chromium's --window-size includes its 87px chrome even headless. Size the
 * real window to obtain the authored CSS viewport without DPR emulation. */
export async function sizeCaptureViewport(page, viewport) {
  const chrome = await page.evaluate(() => ({
    width: outerWidth - innerWidth,
    height: outerHeight - innerHeight,
  }));
  const client = await page.context().newCDPSession(page);
  const { windowId } = await client.send("Browser.getWindowForTarget");
  await client.send("Browser.setWindowBounds", {
    windowId,
    bounds: { width: viewport.width + chrome.width, height: viewport.height + chrome.height },
  });
  await page.waitForFunction(
    ({ width, height }) => innerWidth === width && innerHeight === height,
    viewport,
  );
  await client.detach();
}
