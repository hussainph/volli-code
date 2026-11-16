import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QuitResumeResult, VolliIpcChannel } from "../../ipc/contract";
import { openTestDb, type TestDb } from "@volli/host-core/testing";
import { QUIT_RESUME_CHANNELS } from "../ipc-descriptors";

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

import { readAutoResumeAfterQuit } from "@volli/host-core/session-runtime";
import { registerQuitResumeIpcHandlers } from "./ipc";

const NOW = 1_800_000_000_000;
let ctx: TestDb;

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

async function invoke(channel: VolliIpcChannel, ...args: unknown[]): Promise<QuitResumeResult> {
  const handler = handlers.get(channel) as ((...args: unknown[]) => unknown) | undefined;
  if (handler === undefined) throw new Error(`No handler registered for ${channel}`);
  return (await handler({ sender: {} }, ...args)) as QuitResumeResult;
}

describe("quit resume IPC (VC-1245)", () => {
  it("registers its own complete surface", () => {
    registerQuitResumeIpcHandlers({ ok: true, db: ctx.db });
    expect([...handlers.keys()].toSorted()).toEqual([...QUIT_RESUME_CHANNELS].toSorted());
  });

  it("reads off by default, and stores what Settings chose in the host's database", async () => {
    registerQuitResumeIpcHandlers({ ok: true, db: ctx.db }, () => NOW);
    expect(await invoke("volli:quit-resume-get")).toEqual({ ok: true, autoResume: false });
    expect(await invoke("volli:quit-resume-set", true)).toEqual({ ok: true, autoResume: true });
    expect(readAutoResumeAfterQuit(ctx.db)).toBe(true);
    expect(await invoke("volli:quit-resume-get")).toEqual({ ok: true, autoResume: true });
  });

  it("refuses anything but a boolean", async () => {
    registerQuitResumeIpcHandlers({ ok: true, db: ctx.db });
    expect(await invoke("volli:quit-resume-set", "yes")).toEqual({
      ok: false,
      error: "Invalid setting",
    });
    expect(readAutoResumeAfterQuit(ctx.db)).toBe(false);
  });

  it("answers with the launch's fault when there is no database", async () => {
    registerQuitResumeIpcHandlers({ ok: false, error: "db is gone" });
    expect(await invoke("volli:quit-resume-get")).toEqual({ ok: false, error: "db is gone" });
  });
});
