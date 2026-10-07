/**
 * The browser tool suite, parameterised by backend (VC-619): the real agent
 * port (`browserAgentPort`) and the agent-runtime browser tools over it,
 * against a loopback fixture. Any backend that answers {@link BrowserBackend}
 * must pass it unchanged; that is what "every agent browser tool verb behaves
 * identically on both backends" (host-protocol.md, the parity bar) means in
 * code. Scenarios follow `apps/desktop/e2e/browser-tools-stress.mjs` and
 * `browser-page-navigation-smoke.mjs`, which drive desktop's backend.
 *
 * One backend per suite run, shared by its cases in order, as the stress smoke
 * shares one app: launching an engine per case would measure the launch.
 */
import {
  createBrowserFindTool,
  createBrowserHoldTool,
  createBrowserTool,
  type BrowserRefusal,
} from "@volli/agent-runtime";
import type {
  RuntimeBrowserActResult,
  RuntimeBrowserConsole,
  RuntimeBrowserFind,
  RuntimeBrowserPage,
  RuntimeBrowserScreenshot,
  RuntimeBrowserSnapshot,
  RuntimeBrowserTab,
} from "@volli/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { browserAgentPort, type AgentBrowserPort } from "../agent-port";
import { BROWSER_MAX_TABS_PER_SESSION, type BrowserBackend } from "../backend";
import { BrowserPictureStore } from "../picture-store";
import type { BrowserTabRegistryPorts } from "../tab-registry";
import { startBrowserFixture, type BrowserFixture } from "./fixture-server";

export interface BackendUnderTest {
  backend: BrowserBackend;
  dispose(): Promise<void>;
}

/** Builds the backend under test over the registry ports the suite supplies. */
export type BackendFactory = (ports: BrowserTabRegistryPorts) => Promise<BackendUnderTest>;

const PROJECT = "suite-project";
const signal = (): AbortSignal => new AbortController().signal;

/**
 * Every field each verb answers with, by the shared types. `satisfies` keeps
 * the lists honest: a field added to a result type fails to compile here until
 * the suite checks it on every backend.
 */
const PAGE_KEYS = {
  tabId: true,
  url: true,
  title: true,
  ownerSessionId: true,
  error: true,
} satisfies Record<keyof RuntimeBrowserPage, true>;
const SNAPSHOT_KEYS = {
  ...PAGE_KEYS,
  snapshotText: true,
  generation: true,
  truncated: true,
  picture: true,
} satisfies Record<keyof RuntimeBrowserSnapshot, true>;
export const RESULT_KEYS = {
  tab: {
    tabId: true,
    url: true,
    title: true,
    createdBy: true,
    ownerSessionId: true,
    heldBy: true,
  } satisfies Record<keyof RuntimeBrowserTab, true>,
  snapshot: SNAPSHOT_KEYS,
  act: { ...SNAPSHOT_KEYS, target: true } satisfies Record<keyof RuntimeBrowserActResult, true>,
  find: {
    ...PAGE_KEYS,
    query: true,
    findText: true,
    generation: true,
    matches: true,
    shown: true,
    truncated: true,
    empty: true,
  } satisfies Record<keyof RuntimeBrowserFind, true>,
  screenshot: {
    ...PAGE_KEYS,
    base64Png: true,
    picture: true,
    width: true,
    height: true,
  } satisfies Record<keyof RuntimeBrowserScreenshot, true>,
  console: { ...PAGE_KEYS, messages: true, truncated: true } satisfies Record<
    keyof RuntimeBrowserConsole,
    true
  >,
} as const;

const keysOf = (value: object): string[] => Object.keys(value).toSorted();
const expectedKeys = (shape: object): string[] => Object.keys(shape).toSorted();

/** The ref the snapshot printed for an accessible name: `- role "name" [ref=eN]`. */
export function refNamed(snapshotText: string, name: string): string {
  const line = snapshotText
    .split("\n")
    .find((candidate) => candidate.includes(`"${name}"`) && candidate.includes("[ref="));
  const ref = /\[ref=(e\d+)\]/.exec(line ?? "")?.[1];
  if (ref === undefined)
    throw new Error(`no ref named ${JSON.stringify(name)} in:\n${snapshotText}`);
  return ref;
}

/** Polls a port read until it satisfies `done`, bounded. */
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await read();
  }
  return last;
}

/** The refusal a call raised, or a failure when it did not refuse. */
async function refusalOf(call: Promise<unknown>): Promise<BrowserRefusal> {
  try {
    await call;
  } catch (error) {
    if (error instanceof Error && error.name === "BrowserRefusal") return error as BrowserRefusal;
    throw error;
  }
  throw new Error("expected a BrowserRefusal, but the call answered");
}

/** The suite's registry ports: plain ids, an in-memory picture store, a record of publishes. */
export function suitePorts(): BrowserTabRegistryPorts & { closed: string[] } {
  let next = 0;
  let picture = 0;
  const closed: string[] = [];
  return {
    closed,
    createId: () => `tab-${++next}`,
    publishState: () => undefined,
    publishClosed: (tabId) => closed.push(tabId),
    pictures: new BrowserPictureStore({ createId: () => `picture-${++picture}`, now: Date.now }),
  };
}

/**
 * Registers the suite under `name`. `create` null skips it, with the reason
 * the caller printed (no browser on this machine).
 */
export function describeBrowserBackendSuite(name: string, create: BackendFactory | null): void {
  describe.skipIf(create === null)(`browser tool suite: ${name}`, () => {
    let fixture: BrowserFixture;
    let under: BackendUnderTest;
    let backend: BrowserBackend;
    let ports: ReturnType<typeof suitePorts>;
    const open: AgentBrowserPort[] = [];
    const portFor = (sessionId: string, ticketId: string | null = null): AgentBrowserPort => {
      const port = browserAgentPort({
        backend,
        scope: { projectId: PROJECT, ticketId },
        session: { sessionId, attachmentId: `${sessionId}-attachment` },
        cursorFor: () => undefined,
      });
      open.push(port);
      return port;
    };
    let alpha: AgentBrowserPort;
    let tabA = "";
    let tabB = "";

    beforeAll(async () => {
      fixture = await startBrowserFixture();
      ports = suitePorts();
      under = await create!(ports);
      backend = under.backend;
      alpha = portFor("alpha");
    }, 60_000);

    afterAll(async () => {
      for (const port of open) port.dispose();
      await under?.dispose();
      await fixture?.close();
    }, 30_000);

    it("lists no tabs before any exists", async () => {
      const listing = await alpha.tabs({ signal: signal() });
      expect(listing.tabs).toEqual([]);
    });

    it("opens a headless tab owned and held by the Session on a tabId-less navigate", async () => {
      const nav = await alpha.navigate({
        navigation: { kind: "url", url: fixture.url("/start") },
        signal: signal(),
      });
      tabA = nav.tabId;
      expect(keysOf(nav)).toEqual(expectedKeys(RESULT_KEYS.snapshot));
      expect(nav).toMatchObject({
        url: fixture.url("/start"),
        title: "Stress Start",
        ownerSessionId: "alpha",
        error: null,
        truncated: false,
      });
      expect(nav.snapshotText).toContain("Increment");
      expect(nav.generation).toBeGreaterThanOrEqual(1);
      const listing = await alpha.tabs({ signal: signal() });
      expect(listing.tabs).toHaveLength(1);
      expect(keysOf(listing.tabs[0]!)).toEqual(expectedKeys(RESULT_KEYS.tab));
      expect(listing.tabs[0]).toMatchObject({
        tabId: tabA,
        createdBy: "session",
        ownerSessionId: "alpha",
        heldBy: { kind: "session", sessionId: "alpha", self: true },
      });
      expect(backend.list({ projectId: PROJECT })[0]?.presentation).toBe("headless");
    });

    it("opens a second headless tab that is never shown", async () => {
      const nav = await alpha.navigate({
        navigation: { kind: "url", url: fixture.url("/console") },
        signal: signal(),
      });
      tabB = nav.tabId;
      expect(tabB).not.toBe(tabA);
      expect(backend.list({ projectId: PROJECT }).map((tab) => tab.presentation)).toEqual([
        "headless",
        "headless",
      ]);
    });

    it("snapshots a never-shown tab with refs, a title and a generation", async () => {
      const snap = await alpha.snapshot({ tabId: tabA, signal: signal() });
      expect(snap.title).toBe("Stress Start");
      expect(snap.snapshotText).toMatch(/\[ref=e\d+\]/);
      expect(snap.picture).toBeNull();
    });

    it("clicks: the counter moves and the act names its target", async () => {
      const snap = await alpha.snapshot({ tabId: tabA, signal: signal() });
      const acted = await alpha.act({
        tabId: tabA,
        generation: snap.generation,
        kind: "click",
        ref: refNamed(snap.snapshotText, "Increment"),
        signal: signal(),
      });
      expect(keysOf(acted)).toEqual(expectedKeys(RESULT_KEYS.act));
      expect(acted.target).toEqual({ ref: expect.any(String), name: "Increment" });
      const after = await eventually(
        () => alpha.snapshot({ tabId: tabA, signal: signal() }),
        (read) => read.snapshotText.includes("Count: 1"),
      );
      expect(after.snapshotText).toContain("Count: 1");
    });

    it("types, then presses Enter to submit the form", async () => {
      const snap = await alpha.snapshot({ tabId: tabA, signal: signal() });
      await alpha.act({
        tabId: tabA,
        generation: snap.generation,
        kind: "type",
        ref: refNamed(snap.snapshotText, "Note"),
        text: "stressed",
        signal: signal(),
      });
      await alpha.act({
        tabId: tabA,
        generation: snap.generation,
        kind: "press",
        key: "Enter",
        signal: signal(),
      });
      const after = await eventually(
        () => alpha.snapshot({ tabId: tabA, signal: signal() }),
        (read) => read.title === "Stress Typed:stressed",
      );
      expect(after.title).toBe("Stress Typed:stressed");
    });

    it("selects an option", async () => {
      const snap = await alpha.snapshot({ tabId: tabA, signal: signal() });
      await alpha.act({
        tabId: tabA,
        generation: snap.generation,
        kind: "select",
        ref: refNamed(snap.snapshotText, "Choose"),
        text: "beta",
        signal: signal(),
      });
      const after = await eventually(
        () => alpha.snapshot({ tabId: tabA, signal: signal() }),
        (read) => read.title === "Stress Selected:beta",
      );
      expect(after.title).toBe("Stress Selected:beta");
    });

    it("hovers", async () => {
      const snap = await alpha.snapshot({ tabId: tabA, signal: signal() });
      await alpha.act({
        tabId: tabA,
        generation: snap.generation,
        kind: "hover",
        ref: refNamed(snap.snapshotText, "Hover target"),
        signal: signal(),
      });
      const after = await eventually(
        () => alpha.snapshot({ tabId: tabA, signal: signal() }),
        (read) => read.title === "Stress Hovered",
      );
      expect(after.title).toBe("Stress Hovered");
    });

    it("scrolls, and the page hears it", async () => {
      const snap = await alpha.snapshot({ tabId: tabA, signal: signal() });
      const acted = await alpha.act({
        tabId: tabA,
        generation: snap.generation,
        kind: "scroll",
        direction: "down",
        signal: signal(),
      });
      expect(acted.target).toBeNull();
      const record = await eventually(
        () => alpha.console({ tabId: tabA, signal: signal() }),
        (read) => read.messages.some((message) => message.text === "stress-scroll-marker"),
      );
      expect(record.messages.map((message) => message.text)).toContain("stress-scroll-marker");
    });

    it("waits within its bound and answers a snapshot", async () => {
      const snap = await alpha.snapshot({ tabId: tabA, signal: signal() });
      const started = Date.now();
      const acted = await alpha.act({
        tabId: tabA,
        generation: snap.generation,
        kind: "wait",
        waitMs: 200,
        signal: signal(),
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
      expect(acted.snapshotText.length).toBeGreaterThan(0);
    });

    it("finds by accessible name, with refs an act can use", async () => {
      const found = await alpha.find({ tabId: tabA, query: "increment", signal: signal() });
      expect(keysOf(found)).toEqual(expectedKeys(RESULT_KEYS.find));
      expect(found.matches).toBeGreaterThanOrEqual(1);
      expect(found.empty).toBe(false);
      const ref = refNamed(found.findText, "Increment");
      const acted = await alpha.act({
        tabId: tabA,
        generation: found.generation,
        kind: "click",
        ref,
        signal: signal(),
      });
      expect(acted.target?.name).toBe("Increment");
    });

    it("reads the console record at its levels", async () => {
      const record = await alpha.console({ tabId: tabB, signal: signal() });
      expect(keysOf(record)).toEqual(expectedKeys(RESULT_KEYS.console));
      expect(record.messages).toEqual(
        expect.arrayContaining([
          { level: "info", text: "stress-console-log-marker" },
          { level: "warn", text: "stress-console-warn-marker" },
          { level: "error", text: "stress-console-error-marker" },
        ]),
      );
      expect(record.truncated).toBe(false);
    });

    it("screenshots real PNG bytes, kept as the person's picture", async () => {
      const shot = await alpha.screenshot({ tabId: tabA, signal: signal() });
      expect(keysOf(shot)).toEqual(expectedKeys(RESULT_KEYS.screenshot));
      const png = Buffer.from(shot.base64Png, "base64");
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(shot.width).toBeGreaterThan(0);
      expect(shot.height).toBeGreaterThan(0);
      expect(shot.picture).not.toBeNull();
      expect(backend.pictureOf(shot.picture!)).toMatch(/^data:image\/png;base64,/);
    });

    it("walks history: back, forward and reload", async () => {
      const first = await alpha.navigate({
        navigation: { kind: "url", url: fixture.url("/hist-a") },
        signal: signal(),
      });
      const tab = first.tabId;
      await alpha.navigate({
        tabId: tab,
        navigation: { kind: "url", url: fixture.url("/hist-b") },
        signal: signal(),
      });
      const back = await alpha.navigate({
        tabId: tab,
        navigation: { kind: "back" },
        signal: signal(),
      });
      expect(back.url).toBe(fixture.url("/hist-a"));
      expect(back.title).toBe("Stress hist-a");
      const forward = await alpha.navigate({
        tabId: tab,
        navigation: { kind: "forward" },
        signal: signal(),
      });
      expect(forward.url).toBe(fixture.url("/hist-b"));
      const hits = fixture.hits("/hist-b");
      const reloaded = await alpha.navigate({
        tabId: tab,
        navigation: { kind: "reload" },
        signal: signal(),
      });
      expect(reloaded.url).toBe(fixture.url("/hist-b"));
      expect(reloaded.generation).toBeGreaterThan(forward.generation);
      expect(fixture.hits("/hist-b")).toBe(hits + 1);
    });

    it("fails a dead navigation without killing the tab, and recovers", async () => {
      const dead = await alpha.navigate({
        tabId: tabB,
        navigation: { kind: "url", url: fixture.url("/dead") },
        signal: signal(),
      });
      expect(dead.error).toMatch(/^Could not load page: /);
      const recovered = await alpha.navigate({
        tabId: tabB,
        navigation: { kind: "url", url: fixture.url("/second") },
        signal: signal(),
      });
      expect(recovered.error).toBeNull();
      expect(recovered.title).toBe("Stress second");
    });

    it("refuses a ref from before a navigation as stale, and a ref no read printed as unknown", async () => {
      const before = await alpha.navigate({
        tabId: tabA,
        navigation: { kind: "url", url: fixture.url("/start") },
        signal: signal(),
      });
      const ref = refNamed(before.snapshotText, "Increment");
      const after = await alpha.navigate({
        tabId: tabA,
        navigation: { kind: "url", url: fixture.url("/start") },
        signal: signal(),
      });
      expect(after.generation).toBeGreaterThan(before.generation);
      const stale = await refusalOf(
        alpha.act({
          tabId: tabA,
          generation: before.generation,
          kind: "click",
          ref,
          signal: signal(),
        }),
      );
      expect(stale.rule).toBe("browser.stale-ref");
      const unknown = await refusalOf(
        alpha.act({
          tabId: tabA,
          generation: after.generation,
          kind: "click",
          ref: "e9999",
          signal: signal(),
        }),
      );
      expect(unknown.rule).toBe("browser.unknown-ref");
      const snapshot = await alpha.snapshot({ tabId: tabA, signal: signal() });
      expect(snapshot.snapshotText).toContain("Count: 0");
    });

    it("refuses an unknown tab and a non-HTTP(S) target", async () => {
      expect((await refusalOf(alpha.snapshot({ tabId: "nope", signal: signal() }))).rule).toBe(
        "browser.unknown-tab",
      );
      expect(
        (
          await refusalOf(
            alpha.navigate({
              navigation: { kind: "url", url: "file:///etc/hosts" },
              signal: signal(),
            }),
          )
        ).rule,
      ).toBe("browser.navigation-policy");
    });

    it("follows page-owned navigation: a link, a submit button, and Enter in a field", async () => {
      const link = await alpha.navigate({
        navigation: { kind: "url", url: fixture.url("/link") },
        signal: signal(),
      });
      const linked = await alpha.act({
        tabId: link.tabId,
        generation: link.generation,
        kind: "click",
        ref: refNamed(link.snapshotText, "Follow plain link"),
        signal: signal(),
      });
      expect(linked.url).toBe(fixture.url("/linked"));
      expect(linked.generation).toBeGreaterThan(link.generation);

      const form = await alpha.navigate({
        tabId: link.tabId,
        navigation: { kind: "url", url: fixture.url("/form-button") },
        signal: signal(),
      });
      const typed = await alpha.act({
        tabId: form.tabId,
        generation: form.generation,
        kind: "type",
        ref: refNamed(form.snapshotText, "Button query"),
        text: "button terms",
        signal: signal(),
      });
      const submitted = await alpha.act({
        tabId: form.tabId,
        generation: typed.generation,
        kind: "click",
        ref: refNamed(typed.snapshotText, "Submit by button"),
        signal: signal(),
      });
      expect(submitted.url).toBe(fixture.url("/submitted-button?q=button+terms"));
      expect(submitted.generation).toBeGreaterThan(typed.generation);

      const enter = await alpha.navigate({
        tabId: link.tabId,
        navigation: { kind: "url", url: fixture.url("/form-enter") },
        signal: signal(),
      });
      const enterTyped = await alpha.act({
        tabId: enter.tabId,
        generation: enter.generation,
        kind: "type",
        ref: refNamed(enter.snapshotText, "Enter query"),
        text: "enter terms",
        signal: signal(),
      });
      const pressed = await alpha.act({
        tabId: enter.tabId,
        generation: enterTyped.generation,
        kind: "press",
        key: "Enter",
        signal: signal(),
      });
      expect(pressed.url).toBe(fixture.url("/submitted-enter?q=enter+terms"));
      expect(pressed.generation).toBeGreaterThan(enterTyped.generation);
    });

    it("turns a popup into a headless tab under the opener's owner", async () => {
      const opener = await alpha.navigate({
        navigation: { kind: "url", url: fixture.url("/popup") },
        signal: signal(),
      });
      const before = backend.list({ projectId: PROJECT }).length;
      await alpha.act({
        tabId: opener.tabId,
        generation: opener.generation,
        kind: "click",
        ref: refNamed(opener.snapshotText, "Open in a new window"),
        signal: signal(),
      });
      const listing = await eventually(
        async () => backend.list({ projectId: PROJECT }),
        (tabs) => tabs.length > before,
      );
      const popup = listing.find(
        (tab) => tab.url === fixture.url("/linked") && tab.tabId !== opener.tabId,
      );
      expect(popup).toMatchObject({
        createdBy: "session",
        ownerSessionId: "alpha",
        presentation: "headless",
      });
      backend.close(popup!.tabId);
      backend.close(opener.tabId);
    });

    it("holds: acquire, contention between Sessions naming the holder, release", async () => {
      const personal = backend.open({
        url: fixture.url("/start"),
        projectId: PROJECT,
        ticketId: null,
        createdBy: "user",
      });
      const beta = portFor("beta");
      await alpha.snapshot({ tabId: personal.tabId, signal: signal() });
      expect(await alpha.acquire({ tabId: personal.tabId, signal: signal() })).toEqual({
        kind: "held",
        tabId: personal.tabId,
      });
      expect(await beta.acquire({ tabId: personal.tabId, signal: signal() })).toEqual({
        kind: "refused",
        tabId: personal.tabId,
        holder: { kind: "session", sessionId: "alpha", self: false },
      });
      const snap = await beta.snapshot({ tabId: personal.tabId, signal: signal() });
      const held = await refusalOf(
        beta.act({
          tabId: personal.tabId,
          generation: snap.generation,
          kind: "click",
          ref: refNamed(snap.snapshotText, "Increment"),
          signal: signal(),
        }),
      );
      expect(held.rule).toBe("browser.tab-held");
      expect(await alpha.release({ tabId: personal.tabId, signal: signal() })).toEqual({
        tabId: personal.tabId,
      });
      expect((await beta.acquire({ tabId: personal.tabId, signal: signal() })).kind).toBe("held");
      // A Session never sees another Session's tabs.
      expect((await refusalOf(beta.snapshot({ tabId: tabA, signal: signal() }))).rule).toBe(
        "browser.unknown-tab",
      );
      beta.turnEnded();
      backend.close(personal.tabId);
    });

    // Six complete navigations: retain the usual 5 s allowance per call,
    // rather than making the aggregate quota assertion a 5 s latency bench.
    it(
      "caps a Session's headless tabs",
      async () => {
        const capped = portFor("capped");
        for (let i = 0; i < BROWSER_MAX_TABS_PER_SESSION; i += 1) {
          await capped.navigate({
            navigation: { kind: "url", url: fixture.url("/second") },
            signal: signal(),
          });
        }
        const refused = await refusalOf(
          capped.navigate({
            navigation: { kind: "url", url: fixture.url("/second") },
            signal: signal(),
          }),
        );
        expect(refused.rule).toBe("browser.session-tab-limit");
        capped.dispose();
        await eventually(
          async () =>
            backend.list({ projectId: PROJECT }).filter((tab) => tab.ownerSessionId === "capped"),
          (tabs) => tabs.length === 0,
        );
      },
      BROWSER_MAX_TABS_PER_SESSION * 5_000,
    );

    it("cancels a withdrawn call cleanly, and the port keeps working", async () => {
      const controller = new AbortController();
      controller.abort(new Error("withdrawn"));
      await expect(alpha.snapshot({ tabId: tabA, signal: controller.signal })).rejects.toThrow(
        "withdrawn",
      );
      const midway = new AbortController();
      const pending = alpha.act({
        tabId: tabA,
        generation: (await alpha.snapshot({ tabId: tabA, signal: signal() })).generation,
        kind: "wait",
        waitMs: 2_000,
        signal: midway.signal,
      });
      setTimeout(() => midway.abort(new Error("withdrawn midway")), 100);
      await expect(pending).rejects.toThrow();
      const snap = await alpha.snapshot({ tabId: tabA, signal: signal() });
      expect(snap.title).toBe("Stress Start");
    });

    it("runs concurrent calls across tabs", async () => {
      const answers = await Promise.all([
        alpha.tabs({ signal: signal() }),
        alpha.snapshot({ tabId: tabA, signal: signal() }),
        alpha.snapshot({ tabId: tabB, signal: signal() }),
        alpha.console({ tabId: tabB, signal: signal() }),
        alpha.screenshot({ tabId: tabB, signal: signal() }),
      ]);
      expect(answers).toHaveLength(5);
    });

    it("drives the agent-runtime browser tools over the port", async () => {
      const tools = new Map(
        [
          createBrowserTool("browser_tabs", alpha),
          createBrowserTool("browser_navigate", alpha),
          createBrowserTool("browser_snapshot", alpha),
          createBrowserTool("browser_act", alpha),
          createBrowserTool("browser_screenshot", alpha),
          createBrowserTool("browser_console", alpha),
          createBrowserFindTool(alpha),
          createBrowserHoldTool("browser_acquire", alpha),
          createBrowserHoldTool("browser_release", alpha),
        ].map((tool) => [tool.name, tool]),
      );
      const run = async (tool: string, params: object): Promise<string> => {
        const result = await tools.get(tool)!.execute(`call-${tool}`, params as never);
        const first = result.content[0];
        return first?.type === "text" ? first.text : "";
      };
      expect(await run("browser_tabs", {})).toContain(tabA);
      expect(await run("browser_navigate", { tabId: tabA, url: fixture.url("/start") })).toContain(
        "Increment",
      );
      expect(await run("browser_snapshot", { tabId: tabA })).toContain("Stress Start");
      expect(await run("browser_find", { tabId: tabA, query: "Increment" })).toContain("Increment");
      expect(await run("browser_console", { tabId: tabA })).toContain("stress-console-page-marker");
      expect(await run("browser_acquire", { tabId: tabA })).toContain(tabA);
      expect(await run("browser_release", { tabId: tabA })).toContain("released");
      const shot = await tools
        .get("browser_screenshot")!
        .execute("call-shot", { tabId: tabA } as never);
      expect(shot.content.some((part) => part.type === "image")).toBe(true);
      expect(await run("browser_navigate", { url: "file:///etc/hosts" })).toMatch(/http and https/);
    });

    it("ends holds at turn end and closes every headless tab on dispose", async () => {
      const gamma = portFor("gamma");
      const nav = await gamma.navigate({
        navigation: { kind: "url", url: fixture.url("/second") },
        signal: signal(),
      });
      expect(
        backend.list({ projectId: PROJECT }).find((tab) => tab.tabId === nav.tabId)?.heldBy,
      ).toMatchObject({
        kind: "session",
        sessionId: "gamma",
      });
      gamma.turnEnded();
      await eventually(
        async () =>
          backend.list({ projectId: PROJECT }).find((tab) => tab.tabId === nav.tabId)?.heldBy ??
          null,
        (holder) => holder === null,
      );
      gamma.dispose();
      const remaining = await eventually(
        async () =>
          backend.list({ projectId: PROJECT }).filter((tab) => tab.ownerSessionId === "gamma"),
        (tabs) => tabs.length === 0,
      );
      expect(remaining).toEqual([]);
      expect(ports.closed).toContain(nav.tabId);
    });
  });
}
