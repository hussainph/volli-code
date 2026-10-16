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

import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { browserAgentPort } from "./agent-port";
import { CHROMIUM_LOAD_TIMEOUT_MS, ChromiumBrowserBackend } from "./chromium-backend";
import { CdpPipeConnection } from "./chromium-pipe";
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

/** Launch/attach is fixture setup, not part of the first test's 5 s budget. */
async function readyBackend(backend: ChromiumBrowserBackend): Promise<void> {
  const tab = backend.open({
    url: "about:blank",
    projectId: "chromium-readiness",
    ticketId: null,
    createdBy: "user",
  });
  try {
    const ready = AbortSignal.timeout(CHROMIUM_LOAD_TIMEOUT_MS);
    await backend.waitForLoad(tab.tabId, ready, "current");
    ready.throwIfAborted();
    expect(backend.list({ projectId: "chromium-readiness" })[0]).toMatchObject({
      url: "about:blank",
      loading: false,
      error: null,
    });
    backend.close(tab.tabId);
  } catch (error) {
    await backend.dispose();
    throw error;
  }
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
        await readyBackend(backend);
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
    await readyBackend(backend);
    // The readiness wait uses the existing 10 s load bound; allow setup and
    // failure cleanup here, without increasing any individual test's budget.
  }, 30_000);

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

  const BLOCKED = "Blocked a page navigation to a non-HTTP(S) address";

  it("refuses a main frame's own blob: navigation before it commits", async () => {
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
    const record = await eventually(
      () => driver.console({ tabId: nav.tabId, signal: signal() }),
      (read) => read.messages.some((message) => message.text === BLOCKED),
    );
    expect(record.messages.map((message) => message.text)).toContain(BLOCKED);
    // Refused before commit, the page stays where it was, as desktop's
    // `will-navigate` keeps it; the commit check is only the backstop.
    const settled = await eventually(
      async () => backend.list({ projectId: PROJECT }).find((tab) => tab.tabId === nav.tabId)!,
      (tab) => !tab.loading,
    );
    expect(settled.url).toBe(fixture.url("/blob"));
    expect(settled.title).toBe("Blob opener");
    driver.dispose();
  });

  it("refuses an external scheme before it commits", async () => {
    const driver = port("external", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/external") },
      signal: signal(),
    });
    await driver.act({
      tabId: nav.tabId,
      generation: nav.generation,
      kind: "click",
      ref: refNamed(nav.snapshotText, "Go external"),
      signal: signal(),
    });
    await eventually(
      () => driver.console({ tabId: nav.tabId, signal: signal() }),
      (read) => read.messages.some((message) => message.text === BLOCKED),
    );
    const tab = backend.list({ projectId: PROJECT }).find((each) => each.tabId === nav.tabId)!;
    expect(tab.url).toBe(fixture.url("/external"));
    driver.dispose();
  });

  it.each([false, true])(
    "refuses a blob synchronously despite no CDP stop and page tampering (process swap: %s)",
    async (swap) => {
      const driver = port("blob-no-cdp-stop", null);
      const send = CdpPipeConnection.prototype.send;
      const fellBack = vi.fn();
      const stopped = vi
        .spyOn(CdpPipeConnection.prototype, "send")
        .mockImplementation(function (this: CdpPipeConnection, method, params, sessionId, options) {
          // Model a stop that cannot win: never send it to Chromium. The guard
          // must cancel in the renderer, not depend on the Node/pipe round trip.
          if (method === "Page.stopLoading") return Promise.resolve({});
          if (
            method === "Page.navigate" &&
            (params as { url?: unknown } | undefined)?.url === "about:blank"
          )
            fellBack();
          return send.call(this, method, params, sessionId, options);
        });
      try {
        // A cross-site navigation moves the renderer, not the installed policy.
        const previous = swap
          ? await driver.navigate({
              navigation: { kind: "url", url: fixture.url("/start") },
              signal: signal(),
            })
          : undefined;
        const url = swap
          ? fixture.url("/blob-tampered").replace("127.0.0.1", "localhost")
          : fixture.url("/blob-tampered");
        const nav = await driver.navigate({
          ...(previous === undefined ? {} : { tabId: previous.tabId }),
          navigation: { kind: "url", url },
          signal: signal(),
        });
        await driver.act({
          tabId: nav.tabId,
          generation: nav.generation,
          kind: "click",
          ref: refNamed(nav.snapshotText, "Go to blob"),
          signal: signal(),
        });
        const tab = backend.list({ projectId: PROJECT }).find((each) => each.tabId === nav.tabId)!;
        expect(tab.url).toBe(url);
        expect(tab.title).toBe("Blob opener");
        expect(tab.loading).toBe(false);
        expect(tab.generation).toBe(nav.generation);
        expect(fellBack).not.toHaveBeenCalled();
        expect(backend.consoleOf(nav.tabId).messages.map((message) => message.text)).toContain(
          BLOCKED,
        );
      } finally {
        stopped.mockRestore();
        driver.dispose();
      }
    },
  );

  it("preserves long HTTP(S) in-page state updates", async () => {
    const driver = port("long-hash", null);
    try {
      const nav = await driver.navigate({
        navigation: { kind: "url", url: fixture.url("/long-hash") },
        signal: signal(),
      });
      const changed = await driver.act({
        tabId: nav.tabId,
        generation: nav.generation,
        kind: "click",
        ref: refNamed(nav.snapshotText, "Long fragment"),
        signal: signal(),
      });
      expect(changed.title).toBe("hash-length:9001");
      expect(changed.url).toContain("/long-hash#xxx");
      expect(backend.consoleOf(nav.tabId).messages.map((message) => message.text)).not.toContain(
        BLOCKED,
      );
    } finally {
      driver.dispose();
    }
  });

  it("guards frames: out-of-process iframes and redirect hops are held to HTTP(S)", async () => {
    const driver = port("frames", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/frames") },
      signal: signal(),
    });
    // Every frame that may run has run: the cross-site frame (out of
    // process) and the allowed redirect.
    const ran = await eventually(
      () => driver.snapshot({ tabId: nav.tabId, signal: signal() }),
      (snap) => snap.title.includes("oopif") && snap.title.includes("hop-ok"),
      6_000,
    );
    // Give the refused navigations time they would need to land.
    await new Promise((resolve) => setTimeout(resolve, 750));
    const final = await driver.snapshot({ tabId: nav.tabId, signal: signal() });
    const said = final.title.replace(/^frames:/, "").split(",");
    // The out-of-process frame's own navigation to an address the policy
    // refuses (an over-long URL Chromium itself would load) never ran: the
    // frame's session carries the page's document guard.
    expect(said).not.toContain("oopif-long");
    // A redirect hop to a refused address is refused before it is sent.
    expect(said).not.toContain("hop");
    expect(ran.title).toContain("oopif");
    /*
     * The residual, pinned (B6(c)): same-process `data:`, `blob:` and
     * `srcdoc` frames are made without a network request, so no `Fetch`
     * guard sees them, and CDP has no per-frame pre-commit refusal. They run
     * here; desktop's `will-frame-navigate` refuses them. None gains a
     * privilege the page lacks (`blob:`/`srcdoc` share its origin, `data:` is
     * opaque), but it is not desktop parity: VC-571 must not wire hostd's
     * browser for people until this is resolved. See the host-core README.
     * When a mechanism lands, flip these to `not.toContain`.
     */
    expect(said).toEqual(expect.arrayContaining(["data", "blob", "srcdoc"]));
    driver.dispose();
  });

  const click = async (
    driver: ReturnType<typeof port>,
    nav: { tabId: string; generation: number; snapshotText: string },
    name: string,
  ) =>
    driver.act({
      tabId: nav.tabId,
      generation: nav.generation,
      kind: "click",
      ref: refNamed(nav.snapshotText, name),
      signal: signal(),
    });

  it("answers dialogs nobody can see safely, and says so: alert acknowledged, confirm and prompt declined", async () => {
    const driver = port("dialogs", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/dialogs") },
      signal: signal(),
    });
    const titleAfter = async (name: string, expected: string) => {
      const current = await driver.snapshot({ tabId: nav.tabId, signal: signal() });
      await click(driver, current, name);
      const settled = await eventually(
        () => driver.snapshot({ tabId: nav.tabId, signal: signal() }),
        (snap) => snap.title === expected,
      );
      expect(settled.title).toBe(expected);
    };
    await titleAfter("Raise alert", "alert:done");
    await titleAfter("Ask confirm", "confirm:false");
    await titleAfter("Ask prompt", "prompt:null");
    const record = await driver.console({ tabId: nav.tabId, signal: signal() });
    const texts = record.messages.map((message) => message.text);
    expect(texts).toContain(
      "The page opened a alert dialog nobody could answer; Volli acknowledged it: fixture alert",
    );
    expect(texts).toContain(
      "The page opened a confirm dialog nobody could answer; Volli declined it (confirm returned false): Sure?",
    );
    expect(texts).toContain(
      "The page opened a prompt dialog nobody could answer; Volli declined it (prompt returned null): Name?",
    );
    driver.dispose();
  });

  it("never approves leaving a page that guards unsaved work: the tab stays, and the agent is told", async () => {
    const driver = port("guarded", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/guarded") },
      signal: signal(),
    });
    // Typing gives the page the activation a leave-page prompt needs.
    await driver.act({
      tabId: nav.tabId,
      generation: nav.generation,
      kind: "type",
      ref: refNamed(nav.snapshotText, "Draft"),
      text: "unsaved words",
      signal: signal(),
    });
    const typed = await driver.snapshot({ tabId: nav.tabId, signal: signal() });
    // The page's own departure (a link)...
    const followed = await click(driver, typed, "Leave the draft");
    expect(followed.url).toBe(fixture.url("/guarded"));
    expect(followed.error).toBe("The page asked to confirm leaving it; Volli stayed on the page.");
    // ...and the product door's (the agent's navigate) are both refused.
    const steered = await driver.navigate({
      tabId: nav.tabId,
      navigation: { kind: "url", url: fixture.url("/second") },
      signal: signal(),
    });
    expect(steered.url).toBe(fixture.url("/guarded"));
    expect(steered.error).toBe("The page asked to confirm leaving it; Volli stayed on the page.");
    expect(fixture.hits("/second")).toBe(0);
    const record = await driver.console({ tabId: nav.tabId, signal: signal() });
    expect(record.messages.map((message) => message.text)).toContain(
      "The page opened a beforeunload dialog nobody could answer; Volli declined it and stayed on the page",
    );
    // Closing the tab runs no unload veto: the way out is always open.
    backend.close(nav.tabId);
    expect(backend.list({ projectId: PROJECT }).some((tab) => tab.tabId === nav.tabId)).toBe(false);
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
    // The first viewer hears the new shape only once frames of it can follow.
    await eventually(
      async () => scales,
      (heard) => heard.length === 1,
    );
    expect(scales).toEqual([2]);
    // The person's click reaches the page, and closes the camera for the quiet window.
    for (const type of ["pressed", "released"] as const) {
      await backend.viewerInput(nav.tabId, {
        kind: "mouse",
        type,
        x: 50,
        y: 50,
        button: "left",
        buttons: type === "pressed" ? 1 : 0,
        clickCount: 1,
        modifiers: 0,
      });
    }
    // Every frame a 2x attachment is given is drawn at 2x: none from before.
    const sharp = jpegSize((await two.next(AbortSignal.timeout(5_000)))!.bytes);
    expect(sharp).toEqual({ width: 2_560, height: 1_440 });
    expect(await backend.capturePicture(nav.tabId)).toBeNull();

    two.detach();
    await eventually(
      async () => scales,
      (heard) => heard.length === 2,
    );
    expect(scales).toEqual([2, 1]);
    backend.setPresentation(nav.tabId, "headless");
    await expect(one.next()).resolves.toBeNull();
    await expect(backend.viewerInput(nav.tabId, { kind: "text", text: "x" })).rejects.toThrow(
      /Headless/,
    );
    driver.dispose();
  }, 30_000);

  it("drags with the pressed button held: the page sees event.buttons and selects text (B7)", async () => {
    const driver = port("drag", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/drag") },
      signal: signal(),
    });
    backend.setPresentation(nav.tabId, "preview");
    const holder = backend.heldBy(nav.tabId);
    const mouse = (
      type: "pressed" | "moved" | "released",
      x: number,
      buttons: number,
    ): Promise<void> =>
      backend.viewerInput(nav.tabId, {
        kind: "mouse",
        type,
        x,
        y: 24,
        button: type === "moved" ? "none" : "left",
        buttons,
        clickCount: type === "moved" ? 0 : 1,
        modifiers: 0,
      });
    await mouse("moved", 12, 0);
    await mouse("pressed", 12, 1);
    for (const x of [80, 160, 240, 320]) await mouse("moved", x, 1);
    await mouse("released", 320, 0);
    const settled = await eventually(
      () => driver.snapshot({ tabId: nav.tabId, signal: signal() }),
      (snap) => snap.title.startsWith("buttons:"),
    );
    expect(settled.title).toMatch(/^buttons:1 selected:Select these/);
    // The person's drag neither took nor moved the agent hold.
    expect(backend.heldBy(nav.tabId)).toEqual(holder);
    driver.dispose();
  });

  it("lets the person answer a shown tab's dialogs through the viewer seam (B8)", async () => {
    const driver = port("person-dialogs", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/dialogs") },
      signal: signal(),
    });
    backend.setPresentation(nav.tabId, "preview");
    const viewer = backend.attachScreencast(nav.tabId, { deviceScaleFactor: 1 });
    const heard: string[] = [];
    viewer.onDialog((dialog) => heard.push(dialog === null ? "gone" : dialog.type));
    const answer = async (button: string, response: { accept: boolean; promptText?: string }) => {
      const snap = await driver.snapshot({ tabId: nav.tabId, signal: signal() });
      // The person's click: an agent's would wait on the open dialog.
      const clicked = driver.act({
        tabId: nav.tabId,
        generation: snap.generation,
        kind: "click",
        ref: refNamed(snap.snapshotText, button),
        signal: signal(),
      });
      const dialog = await eventually(
        async () => backend.pendingDialog(nav.tabId),
        (pending) => pending !== null,
      );
      expect(backend.respondToDialog(nav.tabId, dialog!.dialogId, response)).toBe(true);
      await clicked;
      return dialog!;
    };
    const confirmDialog = await answer("Ask confirm", { accept: true });
    expect(confirmDialog).toMatchObject({ type: "confirm", message: "Sure?" });
    const promptDialog = await answer("Ask prompt", { accept: true, promptText: "Ada" });
    expect(promptDialog).toMatchObject({
      type: "prompt",
      message: "Name?",
      defaultPrompt: "default",
    });
    const settled = await eventually(
      () => driver.snapshot({ tabId: nav.tabId, signal: signal() }),
      (snap) => snap.title === "prompt:Ada",
    );
    expect(settled.title).toBe("prompt:Ada");
    expect(heard).toEqual(["confirm", "gone", "prompt", "gone"]);
    viewer.detach();
    driver.dispose();
  });

  describe("a separate browser lifetime", () => {
    let lonely: ChromiumBrowserBackend;
    beforeAll(async () => {
      lonely = chromiumBackend();
      await readyBackend(lonely);
    }, 30_000);
    afterAll(async () => {
      await lonely?.dispose();
    }, 30_000);

    it("forgets every tab when the browser exits, and launches again for the next", async () => {
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
});
