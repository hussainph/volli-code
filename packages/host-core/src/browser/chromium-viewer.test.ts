/**
 * The viewer seam's races without a real browser (VC-619 review B4, B8):
 * the screencast's serialized reconfiguration — a stop that answers late, a
 * last viewer leaving mid-start, a burst of resizes and scales — and a shown
 * tab's dialog waiting for the person, then falling back when nobody answers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CHROMIUM_DIALOG_ANSWER_TIMEOUT_MS, ChromiumBrowserBackend } from "./chromium-backend";
import { eventually, suitePorts } from "./test-support/backend-suite";
import { fakeChromium, settle, type FakeChromium } from "./test-support/fake-chromium";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The smallest bytes {@link jpegSize} reads as a JPEG of this size. */
function fakeJpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
  ]);
}

let frameCount = 0;
function frame(fake: FakeChromium, width: number, height: number): void {
  frameCount += 1;
  fake.event(
    "Page.screencastFrame",
    { data: fakeJpeg(width, height).toString("base64"), sessionId: frameCount, metadata: {} },
    "session-1",
  );
}

async function shownTab(deviceScaleFactor = 2) {
  const fake = fakeChromium();
  const profileRoot = mkdtempSync(join(tmpdir(), "volli-viewer-test-"));
  roots.push(profileRoot);
  const backend = new ChromiumBrowserBackend(suitePorts(), {
    executablePath: "/fake",
    profileRoot,
    noSandbox: false,
    deviceScaleFactor,
    screencastQuality: 70,
    spawn: fake.spawn,
  });
  // A person's tab is shown from birth.
  const tab = backend.open({
    url: "about:blank",
    projectId: "p",
    ticketId: null,
    createdBy: "user",
  });
  await eventually(
    async () => fake.commands,
    (commands) =>
      commands.some(
        (command) =>
          command.method === "Runtime.runIfWaitingForDebugger" && command.sessionId === "session-1",
      ),
  );
  return { fake, backend, tabId: tab.tabId };
}

const castOps = (fake: FakeChromium) =>
  fake.commands.filter(
    (command) =>
      command.method === "Page.startScreencast" || command.method === "Page.stopScreencast",
  );

/** Waits until the n-th start has been answered and the cast is live. */
const started = (fake: FakeChromium, n: number) =>
  eventually(
    async () => fake.commands.filter((command) => command.method === "Page.startScreencast"),
    (starts) => starts.length >= n,
  ).then(() => settle());

describe("the screencast's reconfiguration (B4)", () => {
  it("never offers a frame from before a stop that answers late, nor shows new metadata early", async () => {
    const { fake, backend, tabId } = await shownTab();
    try {
      const one = backend.attachScreencast(tabId, { deviceScaleFactor: 1 });
      await started(fake, 1);
      frame(fake, 1_280, 720);
      expect((await one.next(AbortSignal.timeout(2_000)))?.seq).toBe(1);

      fake.hold("Page.stopScreencast");
      const heard: number[] = [];
      one.onMetadata((metadata) => heard.push(metadata.deviceScaleFactor));
      const two = backend.attachScreencast(tabId, { deviceScaleFactor: 2 });
      await settle();
      // The old cast is still drawing while its stop is unanswered.
      frame(fake, 1_280, 720);
      await settle();
      const early = new AbortController();
      const waiting = two.next(early.signal).catch(() => "nothing");
      await settle();
      early.abort();
      expect(await waiting).toBe("nothing");
      expect(heard).toEqual([]);
      expect(one.metadata().deviceScaleFactor).toBe(1);

      fake.release("Page.stopScreencast");
      fake.hold("Page.stopScreencast", false);
      await started(fake, 2);
      expect(heard).toEqual([2]);
      // A 1x frame now is the wrong size for the 2x cast: dropped.
      frame(fake, 1_280, 720);
      frame(fake, 2_560, 1_440);
      const sharp = await two.next(AbortSignal.timeout(2_000));
      expect(sharp?.bytes).toEqual(fakeJpeg(2_560, 1_440));
      // Every frame was acknowledged, offered or not.
      const acks = fake.commands.filter((command) => command.method === "Page.screencastFrameAck");
      await eventually(
        async () => acks.length,
        () => true,
      );
      expect(
        fake.commands.filter((command) => command.method === "Page.screencastFrameAck"),
      ).toHaveLength(4);
    } finally {
      await backend.dispose();
    }
  });

  it("ends on a stop when the last viewer leaves while a start is still unanswered", async () => {
    const { fake, backend, tabId } = await shownTab();
    try {
      fake.hold("Page.startScreencast");
      const only = backend.attachScreencast(tabId, { deviceScaleFactor: 2 });
      await eventually(
        async () => fake.held.get("Page.startScreencast") ?? [],
        (h) => h.length === 1,
      );
      only.detach();
      fake.hold("Page.startScreencast", false);
      fake.release("Page.startScreencast");
      await eventually(
        async () => castOps(fake).at(-1)?.method,
        (m) => m === "Page.stopScreencast",
      );
      await settle(10);
      expect(castOps(fake).at(-1)?.method).toBe("Page.stopScreencast");
      // No frame is offered after the last viewer left.
      frame(fake, 2_560, 1_440);
      await expect(only.next()).resolves.toBeNull();
    } finally {
      await backend.dispose();
    }
  });

  it("coalesces a burst of resizes and scale changes into the newest cast", async () => {
    const { fake, backend, tabId } = await shownTab();
    try {
      fake.hold("Page.stopScreencast");
      const one = backend.attachScreencast(tabId, { deviceScaleFactor: 1 });
      await settle();
      for (const width of [800, 900, 1_000, 1_100]) {
        backend.setBounds(tabId, { x: 0, y: 0, width, height: 600 });
      }
      const two = backend.attachScreencast(tabId, { deviceScaleFactor: 2 });
      two.detach();
      const three = backend.attachScreencast(tabId, { deviceScaleFactor: 2 });
      fake.hold("Page.stopScreencast", false);
      fake.release("Page.stopScreencast");
      await eventually(
        async () => one.metadata(),
        (metadata) => metadata.width === 1_100 && metadata.deviceScaleFactor === 2,
      );
      const starts = fake.commands.filter((command) => command.method === "Page.startScreencast");
      expect(starts.at(-1)?.params).toMatchObject({ maxWidth: 2_200, maxHeight: 1_200 });
      // One start for the whole burst, not one per request.
      expect(starts.length).toBeLessThanOrEqual(2);
      // The window was its final size before the cast that draws it began.
      const lastResize = fake.commands.findLastIndex(
        (command) => command.method === "Browser.setContentsSize",
      );
      expect(lastResize).toBeLessThan(fake.commands.indexOf(starts.at(-1)!));
      frame(fake, 2_000, 1_200);
      frame(fake, 2_200, 1_200);
      expect((await three.next(AbortSignal.timeout(2_000)))?.bytes).toEqual(fakeJpeg(2_200, 1_200));
      expect(three.metadata()).toEqual({
        encoding: "image/jpeg",
        width: 1_100,
        height: 600,
        deviceScaleFactor: 2,
      });
    } finally {
      await backend.dispose();
    }
  });
});

const dialogOpens = (fake: FakeChromium, type: string, message: string) =>
  fake.event(
    "Page.javascriptDialogOpening",
    { url: "about:blank", frameId: "target-1", message, type, defaultPrompt: "" },
    "session-1",
  );
const answers = (fake: FakeChromium) =>
  fake.commands.filter((command) => command.method === "Page.handleJavaScriptDialog");

describe("a shown tab's dialog (B8)", () => {
  it("waits for the person while a viewer is attached, and sends their answer", async () => {
    const { fake, backend, tabId } = await shownTab();
    try {
      const viewer = backend.attachScreencast(tabId, { deviceScaleFactor: 1 });
      const seen: Array<string | null> = [];
      viewer.onDialog((dialog) => seen.push(dialog?.type ?? null));
      dialogOpens(fake, "beforeunload", "");
      await eventually(
        async () => backend.pendingDialog(tabId),
        (dialog) => dialog !== null,
      );
      const pending = backend.pendingDialog(tabId)!;
      expect(pending).toMatchObject({ type: "beforeunload", message: "" });
      expect(viewer.dialog()).toEqual(pending);
      await settle();
      expect(answers(fake)).toEqual([]);
      expect(backend.respondToDialog(tabId, "an-older-dialog", { accept: true })).toBe(false);
      // The person may leave a page; Volli never decides that for them.
      expect(backend.respondToDialog(tabId, pending.dialogId, { accept: true })).toBe(true);
      await settle();
      expect(answers(fake).map((command) => command.params)).toEqual([{ accept: true }]);
      expect(backend.pendingDialog(tabId)).toBeNull();
      expect(seen).toEqual(["beforeunload", null]);
      expect(backend.respondToDialog(tabId, pending.dialogId, { accept: false })).toBe(false);
    } finally {
      await backend.dispose();
    }
  });

  it("gives the safe answer when the last viewer leaves, and when nobody answers in time", async () => {
    const { fake, backend, tabId } = await shownTab();
    try {
      const viewer = backend.attachScreencast(tabId, { deviceScaleFactor: 1 });
      dialogOpens(fake, "beforeunload", "");
      await eventually(
        async () => backend.pendingDialog(tabId),
        (dialog) => dialog !== null,
      );
      viewer.detach();
      await settle();
      expect(answers(fake).map((command) => command.params)).toEqual([{ accept: false }]);
      expect(backend.list({ projectId: "p" })[0]!.error).toBe(
        "The page asked to confirm leaving it; Volli stayed on the page.",
      );

      backend.attachScreencast(tabId, { deviceScaleFactor: 1 });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      dialogOpens(fake, "prompt", "Name?");
      await eventually(
        async () => backend.pendingDialog(tabId),
        (dialog) => dialog !== null,
      );
      vi.advanceTimersByTime(CHROMIUM_DIALOG_ANSWER_TIMEOUT_MS);
      vi.useRealTimers();
      await settle();
      expect(answers(fake).at(-1)?.params).toEqual({ accept: false });
      expect(backend.pendingDialog(tabId)).toBeNull();
      const record = backend.consoleOf(tabId);
      expect(record.messages.map((message) => message.text)).toContain(
        "The page opened a prompt dialog nobody answered in time; Volli declined it (prompt returned null): Name?",
      );
    } finally {
      vi.useRealTimers();
      await backend.dispose();
    }
  });
});
