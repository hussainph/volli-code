/**
 * Integration test for the update IPC handlers (VC-59) — the sidebar's
 * contract with the updater. Mocks only electron (capturing
 * `ipcMain.handle`); the handler module and its guard envelope are REAL. The
 * riskiest behavior here is the install path: exactly one prompt means the
 * quit-gate latch must be raised strictly BEFORE `quitAndInstall()` is
 * issued, and lowered again if that issue throws — a latch left raised would
 * let the next ordinary ⌘Q bypass every destructive-work confirm.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { UpdateUiState, VolliIpcChannel } from "../ipc/contract";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
}));

import { registerUpdateIpcHandlers, type UpdateIpcDeps } from "./update-ipc";

const fakeEvent = { sender: {} };

function invoke<T>(channel: VolliIpcChannel, ...args: unknown[]): T | Promise<T> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)(fakeEvent, ...args);
}

function testState(overrides: Partial<UpdateUiState> = {}): UpdateUiState {
  return {
    supported: true,
    phase: "idle",
    currentVersion: "0.1.0",
    targetVersion: null,
    percent: null,
    error: null,
    ...overrides,
  };
}

interface Fixture {
  deps: UpdateIpcDeps;
  state: { current: UpdateUiState };
  calls: string[];
  installError: { throwWith: Error | null };
}

function makeFixture(): Fixture {
  const state = { current: testState() };
  const calls: string[] = [];
  const installError: { throwWith: Error | null } = { throwWith: null };
  const deps: UpdateIpcDeps = {
    update: {
      state: () => state.current,
      checkNow: () => {
        calls.push("checkNow");
        return Promise.resolve();
      },
      quitAndInstall: () => {
        calls.push("quitAndInstall");
        if (installError.throwWith !== null) throw installError.throwWith;
      },
    },
    busyCommands: () => ["claude", "pnpm"],
    openAgentTurns: () => Promise.resolve(1),
    unsavedDrafts: () => ["notes.md"],
    beginInstall: () => calls.push("beginInstall"),
    abandonInstall: () => calls.push("abandonInstall"),
  };
  return { deps, state, calls, installError };
}

beforeEach(() => {
  handlers.clear();
});

describe("registerUpdateIpcHandlers", () => {
  it("serves the updater's current state", () => {
    const fixture = makeFixture();
    fixture.state.current = testState({
      phase: "downloading",
      targetVersion: "0.2.0",
      percent: 40,
    });
    registerUpdateIpcHandlers(fixture.deps);

    expect(invoke("volli:update-state-get")).toEqual({
      ok: true,
      state: fixture.state.current,
    });
  });

  it("update-check triggers a check without waiting on it", () => {
    const fixture = makeFixture();
    registerUpdateIpcHandlers(fixture.deps);

    expect(invoke("volli:update-check")).toEqual({ ok: true });
    expect(fixture.calls).toEqual(["checkNow"]);
  });

  it("refuses an install when nothing is downloaded — latch untouched, updater untouched", () => {
    const fixture = makeFixture();
    fixture.state.current = testState({ phase: "downloading", percent: 80 });
    registerUpdateIpcHandlers(fixture.deps);

    const result = invoke<{ ok: boolean }>("volli:update-install");

    expect(result).toEqual({ ok: false, error: "No update has been downloaded yet." });
    expect(fixture.calls).toEqual([]);
  });

  it("a confirmed install raises the quit latch strictly before quitAndInstall", () => {
    const fixture = makeFixture();
    fixture.state.current = testState({ phase: "downloaded", targetVersion: "0.2.0" });
    registerUpdateIpcHandlers(fixture.deps);

    expect(invoke("volli:update-install")).toEqual({ ok: true });
    expect(fixture.calls).toEqual(["beginInstall", "quitAndInstall"]);
  });

  it("a quitAndInstall that throws lowers the latch again and reports the failure", () => {
    const fixture = makeFixture();
    fixture.state.current = testState({ phase: "downloaded", targetVersion: "0.2.0" });
    fixture.installError.throwWith = new Error("squirrel refused");
    registerUpdateIpcHandlers(fixture.deps);

    const result = invoke<{ ok: boolean }>("volli:update-install");

    expect(result).toEqual({ ok: false, error: "squirrel refused" });
    expect(fixture.calls).toEqual(["beginInstall", "quitAndInstall", "abandonInstall"]);
  });

  it("counts the live work the install dialog must name — each surface separately", async () => {
    const fixture = makeFixture();
    registerUpdateIpcHandlers(fixture.deps);

    await expect(invoke("volli:update-live-work")).resolves.toEqual({
      ok: true,
      busyCommands: ["claude", "pnpm"],
      openAgentSessions: 1,
      unsavedDrafts: ["notes.md"],
    });
  });

  it("reads and writes the persisted release channel", () => {
    const fixture = makeFixture();
    let channel: "stable" | "canary" = "stable";
    fixture.deps.channel = {
      read: () => channel,
      write: (next) => {
        channel = next;
        return channel;
      },
    };
    registerUpdateIpcHandlers(fixture.deps);

    expect(invoke("volli:update-channel-get")).toEqual({ ok: true, channel: "stable" });
    expect(invoke("volli:update-channel-set", "canary")).toEqual({ ok: true, channel: "canary" });
    expect(invoke("volli:update-channel-get")).toEqual({ ok: true, channel: "canary" });
  });

  it("refuses release-channel reads and writes without persistent storage", () => {
    const fixture = makeFixture();
    registerUpdateIpcHandlers(fixture.deps);

    expect(invoke("volli:update-channel-get")).toEqual({
      ok: false,
      error: "The release channel isn't readable right now.",
    });
    expect(invoke("volli:update-channel-set", "canary")).toEqual({
      ok: false,
      error: "The release channel isn't writable right now.",
    });
  });

  it("rejects stray arguments through the shared guard envelope", () => {
    const fixture = makeFixture();
    registerUpdateIpcHandlers(fixture.deps);

    expect(invoke("volli:update-install", { stray: true })).toEqual({
      ok: false,
      error: "Invalid request",
    });
    expect(fixture.calls).toEqual([]);
  });
});
