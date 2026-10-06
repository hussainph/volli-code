/**
 * The Chromium backend against a real Chrome for Testing (VC-619): the shared
 * browser tool suite, then what only this engine has — browser contexts per
 * scope, denied permissions, the page-navigation guard, dialogs, the
 * screencast and the viewer's input. Skips without a browser unless
 * `VOLLI_REQUIRE_CHROMIUM=1` (CI's "Test (packages)" lane) makes that a failure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { browserAgentPort } from "./agent-port";
import { ChromiumBrowserBackend } from "./chromium-backend";
import {
  describeBrowserBackendSuite,
  eventually,
  refNamed,
  suitePorts,
} from "./test-support/backend-suite";
import { testChromium } from "./test-support/chromium";
import { jpegSize } from "./test-support/jpeg";
import { startBrowserFixture, type BrowserFixture } from "./test-support/fixture-server";

const chromium = testChromium();
const profileRoot = mkdtempSync(join(tmpdir(), "volli-chromium-test-"));

function chromiumBackend(deviceScaleFactor = 1): ChromiumBrowserBackend {
  return new ChromiumBrowserBackend(suitePorts(), {
    executablePath: chromium!.executablePath,
    profileRoot,
    noSandbox: chromium!.noSandbox,
    deviceScaleFactor,
    screencastQuality: 70,
  });
}

describeBrowserBackendSuite(
  "Chromium over a CDP pipe",
  chromium === null
    ? null
    : async (ports) => {
        const backend = new ChromiumBrowserBackend(ports, {
          executablePath: chromium.executablePath,
          profileRoot,
          noSandbox: chromium.noSandbox,
          deviceScaleFactor: 1,
          screencastQuality: 70,
        });
        return { backend, dispose: () => backend.dispose() };
      },
);

const PROJECT = "chromium-project";
const signal = (): AbortSignal => new AbortController().signal;

describe.skipIf(chromium === null)("ChromiumBrowserBackend's engine facts", () => {
  let fixture: BrowserFixture;
  let backend: ChromiumBrowserBackend;

  beforeAll(async () => {
    fixture = await startBrowserFixture();
    // Drawn at 2x, so one browser can serve a Retina viewer and a 1x one.
    backend = chromiumBackend(2);
  });

  afterAll(async () => {
    await backend?.dispose();
    await fixture?.close();
    rmSync(profileRoot, { recursive: true, force: true });
  }, 30_000);

  const port = (sessionId: string, ticketId: string | null) =>
    browserAgentPort({
      backend,
      scope: { projectId: PROJECT, ticketId },
      session: { sessionId, attachmentId: `${sessionId}-a` },
      cursorFor: () => undefined,
    });

  it("keeps cookies inside one Ticket's context", async () => {
    const first = port("ticket-one-a", "T-1");
    const sibling = port("ticket-one-b", "T-1");
    const other = port("ticket-two", "T-2");
    await first.navigate({
      navigation: { kind: "url", url: fixture.url("/cookie-set") },
      signal: signal(),
    });
    const same = await sibling.navigate({
      navigation: { kind: "url", url: fixture.url("/cookie-read") },
      signal: signal(),
    });
    const elsewhere = await other.navigate({
      navigation: { kind: "url", url: fixture.url("/cookie-read") },
      signal: signal(),
    });
    expect(same.title).toBe("cookie:volli_fixture=present");
    expect(elsewhere.title).toBe("cookie:none");
    for (const each of [first, sibling, other]) each.dispose();
  });

  it("denies permissions", async () => {
    const asker = port("permission", null);
    const nav = await asker.navigate({
      navigation: { kind: "url", url: fixture.url("/permission") },
      signal: signal(),
    });
    const settled = await eventually(
      () => asker.snapshot({ tabId: nav.tabId, signal: signal() }),
      (snap) => snap.title.startsWith("geolocation:"),
    );
    expect(settled.title).toBe("geolocation:denied");
    asker.dispose();
  });

  it("returns a main frame that commits a non-HTTP(S) address to the blank page", async () => {
    const driver = port("blob", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/blob") },
      signal: signal(),
    });
    await driver.act({
      tabId: nav.tabId,
      generation: nav.generation,
      kind: "click",
      ref: refNamed(nav.snapshotText, "Go to blob"),
      signal: signal(),
    });
    const settled = await eventually(
      async () => backend.list({ projectId: PROJECT }).find((tab) => tab.tabId === nav.tabId)!,
      (tab) => tab.url === "about:blank" && !tab.loading,
      4_000,
    );
    expect(settled).toMatchObject({ url: "about:blank", loading: false });
    const record = await driver.console({ tabId: nav.tabId, signal: signal() });
    expect(record.messages.map((message) => message.text)).toContain(
      "Blocked a page navigation to a non-HTTP(S) address",
    );
    driver.dispose();
  });

  it("dismisses a page dialog rather than hanging the page", async () => {
    const driver = port("dialog", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/dialog") },
      signal: signal(),
    });
    await driver.act({
      tabId: nav.tabId,
      generation: nav.generation,
      kind: "click",
      ref: refNamed(nav.snapshotText, "Raise alert"),
      signal: signal(),
    });
    const settled = await eventually(
      () => driver.snapshot({ tabId: nav.tabId, signal: signal() }),
      (snap) => snap.title === "Dialog dismissed",
    );
    expect(settled.title).toBe("Dialog dismissed");
    driver.dispose();
  });

  it("serves a shown tab's frames at 1x and 2x, latest wins, and ends them when it goes headless", async () => {
    const driver = port("viewer", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/latency") },
      signal: signal(),
    });
    expect(() => backend.attachScreencast(nav.tabId, { deviceScaleFactor: 1 })).toThrow(/Headless/);
    backend.setPresentation(nav.tabId, "preview");
    expect(() => backend.attachScreencast(nav.tabId, { deviceScaleFactor: 4 })).toThrow(RangeError);

    const one = backend.attachScreencast(nav.tabId, { deviceScaleFactor: 1 });
    expect(one.metadata()).toEqual({
      encoding: "image/jpeg",
      width: 1_280,
      height: 720,
      deviceScaleFactor: 1,
    });
    const first = await one.next(AbortSignal.timeout(5_000));
    expect(first?.seq).toBe(1);
    expect(jpegSize(first!.bytes)).toEqual({ width: 1_280, height: 720 });

    // A Retina viewer: the page is drawn at 2x for every attachment, and both are told.
    const scales: number[] = [];
    one.onMetadata((metadata) => scales.push(metadata.deviceScaleFactor));
    const two = backend.attachScreencast(nav.tabId, { deviceScaleFactor: 2 });
    expect(two.metadata().deviceScaleFactor).toBe(2);
    expect(scales).toEqual([2]);
    // The person's click reaches the page, and closes the camera for the quiet window.
    for (const type of ["pressed", "released"] as const) {
      await backend.viewerInput(nav.tabId, {
        kind: "mouse",
        type,
        x: 50,
        y: 50,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      });
    }
    const sharp = await eventually(
      async () => jpegSize((await two.next(AbortSignal.timeout(5_000)))!.bytes),
      (size) => size?.width === 2_560,
    );
    expect(sharp).toEqual({ width: 2_560, height: 1_440 });
    expect(await backend.capturePicture(nav.tabId)).toBeNull();

    two.detach();
    expect(scales).toEqual([2, 1]);
    backend.setPresentation(nav.tabId, "headless");
    await expect(one.next()).resolves.toBeNull();
    await expect(backend.viewerInput(nav.tabId, { kind: "text", text: "x" })).rejects.toThrow(
      /Headless/,
    );
    driver.dispose();
  }, 30_000);

  it("forgets every tab when the browser exits, and launches again for the next", async () => {
    const lonely = chromiumBackend();
    const tab = lonely.open({
      url: fixture.url("/second"),
      projectId: PROJECT,
      ticketId: null,
      createdBy: "user",
    });
    await lonely.waitForLoad(tab.tabId, signal(), "current");
    await lonely.dispose();
    expect(lonely.list({ projectId: PROJECT })).toEqual([]);
  });
});
