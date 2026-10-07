/**
 * The Chromium backend's lifetimes without a real browser (VC-619 review
 * B1/B3/B5, N2, N10): one shutdown however the browser ends — against real
 * child processes with a survivor in their group — and nothing retained
 * across tab churn, cancelled attaches or a browser that stops answering.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CHROMIUM_HISTORY_TIMEOUT_MS,
  CHROMIUM_LOAD_TIMEOUT_MS,
  ChromiumBrowserBackend,
} from "./chromium-backend";
import {
  CHROMIUM_ENV_ALLOWLIST,
  chromiumEnvironment,
  launchChromium,
  sweepStaleChromiumProfiles,
} from "./chromium-launch";
import { CdpPipeConnection } from "./chromium-pipe";
import {
  BLOCKED_BROWSER_NAVIGATION,
  CHROMIUM_NAVIGATION_GUARD_BINDING,
  CHROMIUM_NAVIGATION_GUARD_SOURCE,
  CHROMIUM_NAVIGATION_GUARD_WORLD,
} from "./chromium-navigation-guard";
import { eventually, suitePorts } from "./test-support/backend-suite";
import { fakeChromium, settle, type FakeChromium } from "./test-support/fake-chromium";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const root = (): string => {
  const made = mkdtempSync(join(tmpdir(), "volli-lifecycle-test-"));
  roots.push(made);
  return made;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stand-in browser as a real executable: it speaks CDP on fds 3/4, starts
 * a survivor in its own process group that ignores SIGTERM, and then does
 * what `mode` says.
 */
function fakeBrowserExecutable(dir: string, mode: "serve" | "crash" | "pipe-error"): string {
  const script = join(dir, "fake-chrome");
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const survivor = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(path.join(__dirname, "survivor.pid"), String(survivor.pid));
fs.writeFileSync(path.join(__dirname, "env.json"), JSON.stringify(process.env));
// Sockets, not fs streams: a blocking fs read on fd 3 would hold exit hostage.
const net = require("node:net");
const input = new net.Socket({ fd: 3, readable: true, writable: false });
const output = new net.Socket({ fd: 4, readable: false, writable: true });
let buffered = "";
input.on("data", (chunk) => {
  buffered += chunk;
  let end;
  while ((end = buffered.indexOf("\\0")) !== -1) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    output.write(JSON.stringify({ id: message.id, result: {} }) + "\\0");
    if (message.method === "Browser.close") setTimeout(() => process.exit(0), 10);
    if (message.method === "Browser.getVersion") after();
  }
});
function after() {
  if (${JSON.stringify(mode)} === "crash") setTimeout(() => process.exit(3), 50);
  // Cut the pipe and keep running, deaf to SIGTERM: only SIGKILL ends it.
  if (${JSON.stringify(mode)} === "pipe-error") {
    process.on("SIGTERM", () => {});
    setTimeout(() => output.destroy(), 50);
  }
}
setInterval(() => {}, 1000);
`,
  );
  chmodSync(script, 0o755);
  return script;
}

const survivorOf = (dir: string): number => Number(readFileSync(join(dir, "survivor.pid"), "utf8"));

describe.skipIf(process.platform === "win32")(
  "launchChromium's one shutdown (real processes)",
  () => {
    it("closes on request: the browser, the survivors in its group, and the profile", async () => {
      const dir = root();
      const profileRoot = root();
      const browser = await launchChromium({
        executablePath: fakeBrowserExecutable(dir, "serve"),
        profileRoot,
        noSandbox: false,
        deviceScaleFactor: 1,
      });
      const survivor = survivorOf(dir);
      expect(isAlive(survivor)).toBe(true);
      expect(readdirSync(profileRoot)).toHaveLength(1);
      const gone = vi.fn();
      browser.onExit(gone);
      await browser.close();
      expect(gone).toHaveBeenCalledWith("the browser was closed");
      await eventually(
        async () => isAlive(survivor),
        (alive) => !alive,
        3_000,
      );
      expect(readdirSync(profileRoot)).toEqual([]);
      // Only the allowlisted environment reached the browser (N1).
      const env = JSON.parse(readFileSync(join(dir, "env.json"), "utf8")) as Record<string, string>;
      for (const name of Object.keys(env)) {
        expect([...CHROMIUM_ENV_ALLOWLIST, "__CF_USER_TEXT_ENCODING"]).toContain(name);
      }
    }, 15_000);

    it("finalizes a crash: listeners hear it, the group's survivors die, the profile goes", async () => {
      const dir = root();
      const profileRoot = root();
      const browser = await launchChromium({
        executablePath: fakeBrowserExecutable(dir, "crash"),
        profileRoot,
        noSandbox: false,
        deviceScaleFactor: 1,
      });
      const survivor = survivorOf(dir);
      const gone = await new Promise<string>((resolve) => browser.onExit(resolve));
      // Whichever the host hears first: the exit, or the pipe it took with it.
      expect(gone).toMatch(/exited with code 3|pipe/);
      expect(browser.connection.closed).toBe(true);
      await eventually(
        async () => isAlive(survivor),
        (alive) => !alive,
        3_000,
      );
      await eventually(
        async () => readdirSync(profileRoot),
        (left) => left.length === 0,
        3_000,
      );
      await browser.close();
    }, 15_000);

    it("finalizes a pipe failure: a browser still running but unreachable is ended, SIGKILL past SIGTERM", async () => {
      const dir = root();
      const profileRoot = root();
      const browser = await launchChromium({
        executablePath: fakeBrowserExecutable(dir, "pipe-error"),
        profileRoot,
        noSandbox: false,
        deviceScaleFactor: 1,
      });
      const survivor = survivorOf(dir);
      const leader = browser.pid!;
      const gone = await new Promise<string>((resolve) => browser.onExit(resolve));
      expect(gone).toMatch(/pipe/);
      await browser.close();
      expect(isAlive(leader)).toBe(false);
      await eventually(
        async () => isAlive(survivor),
        (alive) => !alive,
        3_000,
      );
      expect(readdirSync(profileRoot)).toEqual([]);
    }, 15_000);
  },
);

describe("launchChromium's spawn", () => {
  it("starts the browser in its own process group with only the allowlisted environment", async () => {
    const fake = fakeChromium();
    const browser = await launchChromium(
      { executablePath: "/fake", profileRoot: root(), noSandbox: false, deviceScaleFactor: 1 },
      fake.spawn,
    );
    expect(fake.lastOptions?.detached).toBe(process.platform !== "win32");
    expect(fake.lastOptions?.env).toEqual(chromiumEnvironment(process.env));
    await browser.close();
  });

  it("keeps only allowlisted names", () => {
    expect(
      chromiumEnvironment({ PATH: "/bin", HOME: "/home/v", AWS_SECRET_ACCESS_KEY: "s", TZ: "UTC" }),
    ).toEqual({ PATH: "/bin", HOME: "/home/v", TZ: "UTC" });
  });
});

describe("sweepStaleChromiumProfiles (N10)", () => {
  it("removes profiles of dead hosts and this host's unused ones, and keeps the rest", async () => {
    const profileRoot = root();
    const make = (name: string): string => {
      const dir = join(profileRoot, name);
      mkdirSync(dir);
      return dir;
    };
    const dead = make("volli-chromium-999999-abcdef");
    const mineStale = make(`volli-chromium-${process.pid}-0123ab`);
    const otherLive = make("volli-chromium-424242-0123ab");
    const unrelated = make("something-else");
    const removed = await sweepStaleChromiumProfiles(profileRoot, (pid) => pid === 424242);
    expect(removed.toSorted()).toEqual([dead, mineStale].toSorted());
    expect(existsSync(otherLive)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("never sweeps a live browser's profile", async () => {
    const profileRoot = root();
    const fake = fakeChromium();
    const browser = await launchChromium(
      { executablePath: "/fake", profileRoot, noSandbox: false, deviceScaleFactor: 1 },
      fake.spawn,
    );
    expect(await sweepStaleChromiumProfiles(profileRoot)).toEqual([]);
    expect(existsSync(browser.profileDir)).toBe(true);
    await browser.close();
    expect(existsSync(browser.profileDir)).toBe(false);
  });
});

/** The backend over a fake browser, with the live connection captured. */
function backendOver(fake: FakeChromium, profileRoot = root()) {
  const connections: CdpPipeConnection[] = [];
  const original = CdpPipeConnection.prototype.onEvent;
  const spy = vi
    .spyOn(CdpPipeConnection.prototype, "onEvent")
    .mockImplementation(function (this: CdpPipeConnection, listener) {
      connections.push(this);
      return original.call(this, listener);
    });
  const backend = new ChromiumBrowserBackend(suitePorts(), {
    executablePath: "/fake",
    profileRoot,
    noSandbox: false,
    deviceScaleFactor: 1,
    screencastQuality: 70,
    spawn: fake.spawn,
  });
  return {
    backend,
    connection: () => connections.at(-1)!,
    restore: () => spy.mockRestore(),
  };
}

const open = (backend: ChromiumBrowserBackend) =>
  backend.open({ url: "about:blank", projectId: "p", ticketId: null, createdBy: "user" });

/** Waits until the fake browser has let the tab's n-th target run. */
const opened = (fake: FakeChromium, n: number) =>
  eventually(
    async () => fake.commands,
    (commands) =>
      commands.some(
        (command) =>
          command.method === "Runtime.runIfWaitingForDebugger" &&
          command.sessionId === `session-${n}`,
      ),
  );

describe("ChromiumBrowserBackend over a fake browser", () => {
  it("closes the browser's startup page instead of parking it (N2)", async () => {
    const fake = fakeChromium();
    const { backend, restore } = backendOver(fake);
    try {
      const tab = open(backend);
      await opened(fake, 1);
      expect(tab.tabId).toBeTruthy();
      expect(
        fake.commands.some(
          (command) =>
            command.method === "Target.closeTarget" &&
            command.params["targetId"] === "startup-page",
        ),
      ).toBe(true);
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it("does not settle the requested navigation on the target's startup about:blank load", async () => {
    const fake = fakeChromium();
    fake.hold("Runtime.runIfWaitingForDebugger");
    fake.hold("Page.navigate");
    const { backend, restore } = backendOver(fake);
    try {
      const url = "http://fixture.test/blob";
      const tab = backend.open({ url, projectId: "p", ticketId: null, createdBy: "user" });
      let settled = false;
      const waiting = backend.waitForLoad(tab.tabId, AbortSignal.timeout(2_000)).then(() => {
        settled = true;
      });
      await opened(fake, 1);
      fake.event(
        "Page.frameNavigated",
        { frame: { id: "target-1", url: "about:blank" } },
        "session-1",
      );
      fake.event("Page.frameStoppedLoading", { frameId: "target-1" }, "session-1");
      await settle();
      expect(settled).toBe(false);
      fake.release("Runtime.runIfWaitingForDebugger");
      await settle();
      expect(fake.held.get("Page.navigate")).toHaveLength(1);
      expect(settled).toBe(false);
      fake.event("Page.frameStartedLoading", { frameId: "target-1" }, "session-1");
      fake.event("Page.frameNavigated", { frame: { id: "target-1", url } }, "session-1");
      fake.release("Page.navigate", { loaderId: "fixture-loader" });
      await settle();
      expect(settled).toBe(false);
      fake.event("Page.frameStoppedLoading", { frameId: "target-1" }, "session-1");
      await waiting;
      expect(backend.list({ projectId: "p" })[0]).toMatchObject({ url, loading: false });
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it.each(["abort", "timeout"] as const)(
    "keeps a pending product navigation's load wait bounded by %s",
    async (end) => {
      const fake = fakeChromium();
      fake.hold("Page.navigate");
      const { backend, restore } = backendOver(fake);
      try {
        const tab = open(backend);
        await opened(fake, 1);
        await settle();
        // The startup load stops, but the requested navigation has not answered.
        fake.event("Page.frameStoppedLoading", { frameId: "target-1" }, "session-1");
        await settle();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const controller = new AbortController();
        let settled = false;
        const waiting = backend.waitForLoad(tab.tabId, controller.signal).then(() => {
          settled = true;
        });
        await settle();
        expect(settled).toBe(false);
        if (end === "abort") controller.abort();
        else await vi.advanceTimersByTimeAsync(CHROMIUM_LOAD_TIMEOUT_MS);
        await waiting;
        expect(settled).toBe(true);
        // A bounded wait is not a claim that an unanswered navigation loaded.
        expect(backend.list({ projectId: "p" })[0]!.loading).toBe(true);
      } finally {
        vi.useRealTimers();
        fake.release("Page.navigate", { loaderId: "late-loader" });
        restore();
        await backend.dispose();
      }
    },
  );

  it.each([false, true])(
    "pins the blob guard's backstop when the commit beats stopLoading: %s",
    async (commits) => {
      const fake = fakeChromium();
      const { backend, restore } = backendOver(fake);
      try {
        const url = "http://fixture.test/blob";
        const tab = backend.open({ url, projectId: "p", ticketId: null, createdBy: "user" });
        await opened(fake, 1);
        await settle();
        fake.event("Page.frameNavigated", { frame: { id: "target-1", url } }, "session-1");
        fake.event("Page.frameStoppedLoading", { frameId: "target-1" }, "session-1");
        await backend.waitForLoad(tab.tabId, AbortSignal.timeout(2_000));
        const blob = "blob:http://fixture.test/document";
        fake.event(
          "Page.frameRequestedNavigation",
          { frameId: "target-1", url: blob },
          "session-1",
        );
        fake.event("Page.frameStartedLoading", { frameId: "target-1" }, "session-1");
        if (commits) {
          fake.event("Page.frameNavigated", { frame: { id: "target-1", url: blob } }, "session-1");
        }
        await settle();
        expect(fake.commands).toContainEqual(
          expect.objectContaining({ method: "Page.stopLoading", sessionId: "session-1" }),
        );
        const fallback = fake.commands.filter(
          (command) =>
            command.method === "Page.navigate" && command.params["url"] === "about:blank",
        );
        expect(fallback).toHaveLength(commits ? 1 : 0);
        if (commits) {
          fake.event("Page.frameStartedLoading", { frameId: "target-1" }, "session-1");
          fake.event(
            "Page.frameNavigated",
            { frame: { id: "target-1", url: "about:blank" } },
            "session-1",
          );
        }
        fake.event("Page.frameStoppedLoading", { frameId: "target-1" }, "session-1");
        await backend.waitForLoad(tab.tabId, AbortSignal.timeout(2_000));
        expect(backend.list({ projectId: "p" })[0]).toMatchObject({
          url: commits ? "about:blank" : url,
          loading: false,
        });
        expect(backend.consoleOf(tab.tabId).messages.map((message) => message.text)).toEqual(
          Array(commits ? 2 : 1).fill("Blocked a page navigation to a non-HTTP(S) address"),
        );
      } finally {
        restore();
        await backend.dispose();
      }
    },
  );

  it("ends a pending navigation wait on a renderer crash, without awaiting the command", async () => {
    const fake = fakeChromium();
    fake.hold("Page.navigate");
    const { backend, restore } = backendOver(fake);
    try {
      const tab = open(backend);
      await opened(fake, 1);
      await settle();
      const waiting = backend.waitForLoad(tab.tabId, AbortSignal.timeout(2_000));
      fake.event("Target.targetCrashed", { targetId: "target-1", status: "crashed" });
      await waiting;
      expect(fake.held.get("Page.navigate")).toHaveLength(1);
      expect(backend.list({ projectId: "p" })[0]).toMatchObject({
        loading: false,
        error: "The page stopped responding and its renderer exited (crashed).",
      });
    } finally {
      fake.release("Page.navigate", { errorText: "net::ERR_ABORTED" });
      restore();
      await backend.dispose();
    }
  });

  it("installs the isolated navigation guard before letting page scripts run", async () => {
    const fake = fakeChromium();
    const { backend, restore } = backendOver(fake);
    try {
      open(backend);
      await opened(fake, 1);
      const guard = fake.commands.findIndex(
        (command) => command.method === "Page.addScriptToEvaluateOnNewDocument",
      );
      const resumed = fake.commands.findIndex(
        (command) =>
          command.method === "Runtime.runIfWaitingForDebugger" && command.sessionId === "session-1",
      );
      const binding = fake.commands.findIndex((command) => command.method === "Runtime.addBinding");
      expect(binding).toBeGreaterThanOrEqual(0);
      expect(binding).toBeLessThan(guard);
      expect(fake.commands[binding]!.params).toEqual({
        name: CHROMIUM_NAVIGATION_GUARD_BINDING,
        executionContextName: CHROMIUM_NAVIGATION_GUARD_WORLD,
      });
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(resumed);
      expect(fake.commands[guard]!.params).toEqual({
        source: CHROMIUM_NAVIGATION_GUARD_SOURCE,
        worldName: CHROMIUM_NAVIGATION_GUARD_WORLD,
        runImmediately: true,
      });
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it("accepts only the guard binding's fixed refusal notice", async () => {
    const fake = fakeChromium();
    const { backend, restore } = backendOver(fake);
    try {
      const tab = open(backend);
      await opened(fake, 1);
      for (const params of [
        { name: "other", payload: BLOCKED_BROWSER_NAVIGATION },
        { name: CHROMIUM_NAVIGATION_GUARD_BINDING, payload: "arbitrary page bytes" },
        { name: CHROMIUM_NAVIGATION_GUARD_BINDING, payload: BLOCKED_BROWSER_NAVIGATION },
      ])
        fake.event("Runtime.bindingCalled", params, "session-1");
      expect(backend.consoleOf(tab.tabId).messages).toEqual([
        { level: "error", text: BLOCKED_BROWSER_NAVIGATION },
      ]);
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it("forgets its tabs when the browser crashes, and the next tab launches another (B1)", async () => {
    const fake = fakeChromium();
    const profileRoot = root();
    const { backend, restore } = backendOver(fake, profileRoot);
    try {
      const tab = open(backend);
      await opened(fake, 1);
      expect(backend.list({ projectId: "p" })).toHaveLength(1);
      fake.child().emit("exit", null, "SIGSEGV");
      await eventually(
        async () => readdirSync(profileRoot),
        (left) => left.length === 0,
      );
      expect(backend.list({ projectId: "p" }).some((each) => each.tabId === tab.tabId)).toBe(false);
      open(backend);
      await opened(fake, 2);
      expect(fake.spawns).toBe(2);
      expect(backend.list({ projectId: "p" })).toHaveLength(1);
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it("forgets the browser when its pipe fails, and ends it (B1)", async () => {
    const fake = fakeChromium();
    const { backend, connection, restore } = backendOver(fake);
    try {
      open(backend);
      await opened(fake, 1);
      const kill = vi.spyOn(fake.child(), "kill");
      (
        fake.child().stdio[4] as NodeJS.ReadableStream & { emit: (e: string, x: Error) => void }
      ).emit("error", new Error("broken pipe"));
      await settle(10);
      expect(connection().closed).toBe(true);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(backend.list({ projectId: "p" })).toEqual([]);
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it("keeps listener and session counts flat over repeated open and close (B3)", async () => {
    const fake = fakeChromium();
    const { backend, connection, restore } = backendOver(fake);
    try {
      const baseline: number[] = [];
      for (let round = 0; round < 10; round += 1) {
        const tab = open(backend);
        await opened(fake, round + 1);
        const transport = backend.transportFor(tab.tabId);
        await transport.ensureReady?.();
        transport.dispose?.();
        backend.close(tab.tabId);
        await settle();
        baseline.push(connection().closeListenerCount);
      }
      // The launch's own pipe watcher, and nothing per tab.
      expect(new Set(baseline)).toEqual(new Set([1]));
      const attached = fake.commands.filter((c) => c.method === "Target.attachToTarget").length;
      const detached = fake.commands.filter((c) => c.method === "Target.detachFromTarget").length;
      expect(attached).toBe(10);
      expect(detached).toBe(10);
      expect(connection().pendingCount).toBe(0);
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it("cancels a closed tab's target claim at once: no timer, listener or target waits for an attach (B3)", async () => {
    const fake = fakeChromium();
    const { backend, connection, restore } = backendOver(fake);
    try {
      const first = open(backend);
      await opened(fake, 1);
      backend.close(first.tabId);
      await settle();
      const baseline = connection().closeListenerCount;
      // The browser is slow to attach what it creates: nothing attaches.
      const deliver = fake.event;
      const late: Array<[string, object, string | undefined]> = [];
      fake.event = (method, params, sessionId) => {
        if (method === "Target.attachedToTarget") late.push([method, params, sessionId]);
        else deliver(method, params, sessionId);
      };
      const counts: number[] = [];
      for (let round = 0; round < 10; round += 1) {
        const created = fake.commands.filter((c) => c.method === "Target.createTarget").length;
        const tab = open(backend);
        await eventually(
          async () => fake.commands.filter((c) => c.method === "Target.createTarget").length,
          (count) => count > created,
        );
        await settle();
        backend.close(tab.tabId);
        await settle();
        counts.push(connection().closeListenerCount);
      }
      expect(counts).toEqual(Array(10).fill(baseline));
      // Every target made for a cancelled tab was closed at once, not at the attach timeout.
      const created = fake.commands
        .filter((c) => c.method === "Target.createTarget")
        .map((_, index) => `target-${index + 1}`);
      const closed = new Set(
        fake.commands
          .filter((c) => c.method === "Target.closeTarget")
          .map((c) => c.params["targetId"]),
      );
      for (const targetId of created.slice(1)) expect(closed.has(targetId)).toBe(true);
      expect(connection().pendingCount).toBe(0);
      // An attach that arrives late anyway is discarded: closed, never a tab.
      fake.event = deliver;
      const closesBefore = fake.commands.filter((c) => c.method === "Target.closeTarget").length;
      const [, params, sessionId] = late.at(-1)!;
      deliver("Target.attachedToTarget", params, sessionId);
      await settle();
      expect(fake.commands.filter((c) => c.method === "Target.closeTarget").length).toBe(
        closesBefore + 1,
      );
      expect(backend.list({ projectId: "p" })).toEqual([]);
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it("detaches an agent session whose attach answered after the transport was disposed (B3)", async () => {
    const fake = fakeChromium();
    const { backend, restore } = backendOver(fake);
    try {
      const tab = open(backend);
      await opened(fake, 1);
      fake.hold("Target.attachToTarget");
      const transport = backend.transportFor(tab.tabId);
      const ready = transport.ensureReady!.call(transport).catch((error: unknown) => error);
      await settle();
      expect(fake.held.get("Target.attachToTarget")).toHaveLength(1);
      transport.dispose?.();
      fake.release("Target.attachToTarget", { sessionId: "late-agent-session" });
      expect(await ready).toBeInstanceOf(Error);
      await settle();
      expect(
        fake.commands.some(
          (command) =>
            command.method === "Target.detachFromTarget" &&
            command.params["sessionId"] === "late-agent-session",
        ),
      ).toBe(true);
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it("ends a load wait's title read when the caller withdraws, leaving nothing pending (B5)", async () => {
    const fake = fakeChromium();
    const { backend, connection, restore } = backendOver(fake);
    try {
      const tab = open(backend);
      await opened(fake, 1);
      fake.event("Page.frameStoppedLoading", { frameId: "target-1" }, "session-1");
      await eventually(
        async () => backend.list({ projectId: "p" })[0]!,
        (state) => !state.loading,
      );
      fake.hold("Page.getNavigationHistory");
      const controller = new AbortController();
      let settled = false;
      const waiting = backend.waitForLoad(tab.tabId, controller.signal).then(() => {
        settled = true;
      });
      await settle();
      expect(fake.held.get("Page.getNavigationHistory")).toHaveLength(1);
      const before = connection().pendingCount;
      controller.abort(new Error("withdrawn"));
      await settle();
      expect(settled).toBe(true);
      expect(connection().pendingCount).toBe(before - 1);
      await waiting;
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it("bounds a title read the browser never answers (B5)", async () => {
    const fake = fakeChromium();
    const { backend, connection, restore } = backendOver(fake);
    try {
      const tab = open(backend);
      await opened(fake, 1);
      fake.event("Page.frameStoppedLoading", { frameId: "target-1" }, "session-1");
      await eventually(
        async () => backend.list({ projectId: "p" })[0]!,
        (state) => !state.loading,
      );
      fake.ignore("Page.getNavigationHistory");
      const started = Date.now();
      await backend.waitForLoad(tab.tabId, new AbortController().signal);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(CHROMIUM_HISTORY_TIMEOUT_MS - 50);
      expect(took).toBeLessThan(CHROMIUM_HISTORY_TIMEOUT_MS + 1_000);
      expect(connection().pendingCount).toBe(0);
    } finally {
      restore();
      await backend.dispose();
    }
  }, 10_000);

  it("accepts an empty title as the page's real title (B5)", async () => {
    const fake = fakeChromium();
    const { backend, restore } = backendOver(fake);
    try {
      const tab = open(backend);
      await opened(fake, 1);
      fake.event("Page.frameStoppedLoading", { frameId: "target-1" }, "session-1");
      await eventually(
        async () => backend.list({ projectId: "p" })[0]!,
        (s) => s.title === "fixture",
      );
      fake.hold("Page.getNavigationHistory");
      const read = backend.waitForLoad(tab.tabId, new AbortController().signal);
      await settle();
      fake.release("Page.getNavigationHistory", {
        currentIndex: 0,
        entries: [{ id: 1, title: "" }],
      });
      await read;
      expect(backend.list({ projectId: "p" })[0]!.title).toBe("");
    } finally {
      restore();
      await backend.dispose();
    }
  });

  it.each(["Fetch.enable", "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument"])(
    "closes a target whose %s setup failed, rather than leave it paused and unclosable",
    async (method) => {
      const fake = fakeChromium();
      const { backend, restore } = backendOver(fake);
      try {
        fake.fail(method);
        const tab = open(backend);
        const closed = await eventually(
          async () => fake.commands,
          (commands) =>
            commands.some(
              (command) =>
                command.method === "Target.closeTarget" &&
                command.params["targetId"] === "target-1",
            ),
        );
        expect(closed).toBeTruthy();
        // It never ran unguarded.
        expect(
          fake.commands.some(
            (command) =>
              command.method === "Runtime.runIfWaitingForDebugger" &&
              command.sessionId === "session-1",
          ),
        ).toBe(false);
        await eventually(
          async () => backend.list({ projectId: "p" })[0]!,
          (state) => !state.loading,
        );
        expect(backend.list({ projectId: "p" })[0]!.error).toMatch(/could not open this tab/);
        backend.close(tab.tabId);
      } finally {
        restore();
        await backend.dispose();
      }
    },
  );

  it("waits, on dispose, for a browser that was already shutting down", async () => {
    const fake = fakeChromium();
    const profileRoot = root();
    const { backend, restore } = backendOver(fake, profileRoot);
    try {
      open(backend);
      await opened(fake, 1);
      const child = fake.child();
      const signals: string[] = [];
      // Deaf to SIGTERM: only the group SIGKILL, past the grace, ends it.
      child.kill = ((signal: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
        return true;
      }) as typeof child.kill;
      (child.stdio[4] as NodeJS.ReadableStream & { emit: (e: string, x: Error) => void }).emit(
        "error",
        new Error("broken pipe"),
      );
      await settle();
      await backend.dispose();
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(readdirSync(profileRoot)).toEqual([]);
    } finally {
      restore();
    }
  }, 10_000);
});

describe("launchChromium's shutdown runs once", () => {
  it("whichever way the browser ends first: exit, then its pipe, then the host's close", async () => {
    const fake = fakeChromium();
    const profileRoot = root();
    const browser = await launchChromium(
      { executablePath: "/fake", profileRoot, noSandbox: false, deviceScaleFactor: 1 },
      fake.spawn,
    );
    const child = fake.child();
    const kill = vi.spyOn(child, "kill");
    const heard = vi.fn();
    browser.onExit(heard);
    child.emit("exit", 1, null);
    (child.stdio[4] as NodeJS.ReadableStream & { emit: (e: string) => void }).emit("close");
    await browser.close();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(kill.mock.calls.filter(([signal]) => signal === "SIGKILL")).toHaveLength(1);
    expect(readdirSync(profileRoot)).toEqual([]);
  });
});
