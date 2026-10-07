/**
 * The parity bench (VC-619, host-protocol.md's parity bar): what a person
 * would feel in a viewer of a Chromium-backed tab, measured on a loopback
 * fixture through the backend's own doors — `viewerInput` in, `watchFrames`
 * out.
 *
 * - **Input to frame**, for a click and for typing: from the moment the input
 *   is handed to the backend to the first screencast frame after it. The
 *   fixture pages are static until touched and draw no caret, so the first
 *   frame after an input is that input's effect. p50 and p95.
 * - **Frames per second** while the page changes: during a run of wheel
 *   scrolling, and during a CSS animation.
 *
 * The bar is p95 input-to-frame at most 100 ms and at least 30 fps. The
 * numbers always print (`[volli] chromium parity`); they are asserted only
 * under `VOLLI_CHROMIUM_PARITY_ASSERT=1`, because a shared CI runner's timing
 * says more about the runner than the engine. Agent-verb parity is the
 * backend suite's job (`test-support/backend-suite.ts`), not this file's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { ChromiumBrowserBackend } from "./chromium-backend";
import { suitePorts } from "./test-support/backend-suite";
import { testChromium } from "./test-support/chromium";
import { consume, type Consumer } from "./test-support/parity-consumer";
import { startBrowserFixture, type BrowserFixture } from "./test-support/fixture-server";

const chromium = testChromium();
const ASSERT = process.env["VOLLI_CHROMIUM_PARITY_ASSERT"] === "1";
const SAMPLES = 30;
const PROJECT = "parity";

function percentile(values: number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

const round = (value: number): number => Math.round(value * 10) / 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(chromium === null)("Chromium viewer parity bench", () => {
  let fixture: BrowserFixture;
  let profileRoot: string;
  const results: Record<string, Record<string, unknown>> = {};

  beforeAll(async () => {
    fixture = await startBrowserFixture();
    profileRoot = mkdtempSync(join(tmpdir(), "volli-chromium-parity-"));
  });

  afterAll(async () => {
    console.log(`[volli] chromium parity: ${JSON.stringify(results)}`);
    await fixture?.close();
    rmSync(profileRoot, { recursive: true, force: true });
  }, 30_000);

  // Each scale on a browser launched at it: a 1x host pays for no 2x pixels.
  describe.each([1, 2])("at %ix", (scale) => {
    let backend: ChromiumBrowserBackend;
    beforeAll(() => {
      backend = new ChromiumBrowserBackend(suitePorts(), {
        executablePath: chromium!.executablePath,
        profileRoot,
        noSandbox: chromium!.noSandbox,
        deviceScaleFactor: scale,
        screencastQuality: 70,
      });
    });
    afterAll(async () => {
      await backend?.dispose();
    }, 30_000);

    const record = (key: string, value: unknown): void => {
      results[`${scale}x`] = { ...results[`${scale}x`], [key]: value };
    };

    /** Opens a person's tab on `path`, attaches at this scale, and waits for the page to rest. */
    const show = async (
      path: string,
      rest = true,
    ): Promise<{ tabId: string; frames: Consumer }> => {
      const tab = backend.open({
        url: fixture.url(path),
        projectId: PROJECT,
        ticketId: null,
        createdBy: "user",
      });
      await backend.waitForLoad(tab.tabId, new AbortController().signal, "current");
      // An empty frame history is not a quiet page: wait for actual cast readiness.
      const frames = await consume(
        backend.attachScreencast(tab.tabId, { deviceScaleFactor: scale }),
      );
      if (rest) await quiet(frames);
      return { tabId: tab.tabId, frames };
    };

    /** The first frame taken after `since`, bounded. */
    const frameAfter = async (frames: Consumer, since: number): Promise<number> => {
      const deadline = performance.now() + 2_000;
      for (;;) {
        const arrived = frames.arrivals.find((at) => at > since);
        if (arrived !== undefined) return arrived;
        if (performance.now() > deadline) throw new Error("no screencast frame followed the input");
        await sleep(1);
      }
    };

    /** Waits until no frame has come for `quietMs`: the page is at rest. */
    const quiet = async (frames: Consumer, quietMs = 150): Promise<void> => {
      for (let i = 0; i < 100; i += 1) {
        if (performance.now() - (frames.arrivals.at(-1) ?? 0) >= quietMs) return;
        await sleep(quietMs / 3);
      }
    };

    const summary = (samples: number[]) => ({
      p50: round(percentile(samples, 0.5)),
      p95: round(percentile(samples, 0.95)),
    });

    it("measures click and typing input to frame", async () => {
      const { tabId, frames } = await show("/latency");
      expect(frames.size).toEqual({ width: 1_280 * scale, height: 720 * scale });
      const target = { x: 100, y: 100, modifiers: 0 };
      await backend.viewerInput(tabId, {
        kind: "mouse",
        type: "moved",
        button: "none",
        buttons: 0,
        clickCount: 0,
        ...target,
      });
      await quiet(frames);
      const clicks: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const started = performance.now();
        await backend.viewerInput(tabId, {
          kind: "mouse",
          type: "pressed",
          button: "left",
          buttons: 1,
          clickCount: 1,
          ...target,
        });
        clicks.push((await frameAfter(frames, started)) - started);
        await backend.viewerInput(tabId, {
          kind: "mouse",
          type: "released",
          button: "left",
          buttons: 0,
          clickCount: 1,
          ...target,
        });
        await quiet(frames);
      }
      record("clickToFrameMs", summary(clicks));

      const field = { x: 100, y: 340, modifiers: 0 };
      for (const type of ["pressed", "released"] as const) {
        await backend.viewerInput(tabId, {
          kind: "mouse",
          type,
          button: "left",
          buttons: type === "pressed" ? 1 : 0,
          clickCount: 1,
          ...field,
        });
      }
      await quiet(frames);
      const keys: number[] = [];
      const key = { key: "a", code: "KeyA", keyCode: 65, modifiers: 0 };
      for (let i = 0; i < SAMPLES; i += 1) {
        const started = performance.now();
        await backend.viewerInput(tabId, { kind: "key", type: "down", text: "a", ...key });
        keys.push((await frameAfter(frames, started)) - started);
        await backend.viewerInput(tabId, { kind: "key", type: "up", ...key });
        await quiet(frames);
      }
      record("typeToFrameMs", summary(keys));
      frames.stop();
      backend.close(tabId);
      if (ASSERT) {
        expect(percentile(clicks, 0.95)).toBeLessThanOrEqual(100);
        expect(percentile(keys, 0.95)).toBeLessThanOrEqual(100);
      }
    }, 60_000);

    it("measures frames per second while scrolling and animating", async () => {
      const scroll = await show("/scroll");
      let before = scroll.frames.arrivals.length;
      let started = performance.now();
      while (performance.now() - started < 2_000) {
        await backend.viewerInput(scroll.tabId, {
          kind: "wheel",
          x: 400,
          y: 300,
          deltaX: 0,
          deltaY: 40,
          modifiers: 0,
        });
        await sleep(8);
      }
      const scrollFps =
        ((scroll.frames.arrivals.length - before) * 1_000) / (performance.now() - started);
      record("scrollFps", round(scrollFps));
      scroll.frames.stop();
      backend.close(scroll.tabId);

      const animated = await show("/animate", false);
      before = animated.frames.arrivals.length;
      started = performance.now();
      await sleep(2_000);
      const animationFps =
        ((animated.frames.arrivals.length - before) * 1_000) / (performance.now() - started);
      record("animationFps", round(animationFps));
      animated.frames.stop();
      backend.close(animated.tabId);
      if (ASSERT) {
        expect(scrollFps).toBeGreaterThanOrEqual(30);
        expect(animationFps).toBeGreaterThanOrEqual(30);
      }
    }, 30_000);
  });
});
