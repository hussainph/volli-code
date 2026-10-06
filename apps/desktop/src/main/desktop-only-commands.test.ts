// @vitest-environment node
/**
 * The desktop-only tier's template commands (VC-608), end to end on the real
 * path: main's IPC registration, the router-generic bridge, the desktop
 * router, and the host's sealed handler map under the router policy, over a
 * real database. Requests and replies cross as structured clones, as Electron
 * carries them.
 *
 * Parity with the channels they replaced (`volli:project-reorder`,
 * `volli:worktree-trim-settings-get`): the same rows written, the same
 * settings read, an input the old guard accepted still accepted, and one it
 * refused still refused.
 */
import { randomUUID } from "node:crypto";

import type { IpcResponse } from "@volli/host-protocol/ipc";
import { listProjects, insertProject } from "@volli/host-core/db";
import { admittedHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { openTestDb, testHostHandlers, testProject, type TestDb } from "@volli/host-core/testing";
import { getTrimSettings, setTrimSettings } from "@volli/host-core/worktree";
import { SESSION_RPC_IPC_CHANNEL } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipc.handlers.set(channel, handler),
    on: () => {},
  },
}));

import { registerSessionRpcIpcHandlers } from "./session-rpc-ipc";

let ctx: TestDb;
let rpc: ReturnType<typeof registerSessionRpcIpcHandlers>;
const sender = {
  id: 1,
  isDestroyed: () => false,
  send: () => {},
  once: () => {},
  on: () => {},
  removeListener: () => {},
};

async function request(path: string, type: string, input: unknown): Promise<IpcResponse> {
  const reply = await ipc.handlers.get(SESSION_RPC_IPC_CHANNEL)!(
    { sender },
    structuredClone({ path, type, input }),
  );
  return structuredClone(reply as IpcResponse);
}

beforeEach(() => {
  ctx = openTestDb();
  rpc = registerSessionRpcIpcHandlers({
    handlers: admittedHandlers(testHostHandlers({ db: ctx.db, now: () => 77 }), ROUTER_POLICY),
  });
});

afterEach(async () => {
  await rpc.close();
  ctx.cleanup();
  ipc.handlers.clear();
});

describe("project.reorder (was volli:project-reorder)", () => {
  it("rewrites the rail's order across every Workspace, as the channel did", async () => {
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of [first, second, third].entries()) {
      insertProject(ctx.db, testProject({ id, ticketPrefix: `P${index}`, path: `/p/${index}` }));
    }

    await expect(
      request("project.reorder", "mutation", { orderedIds: [third, first, second] }),
    ).resolves.toEqual({ ok: true, data: null });

    expect(listProjects(ctx.db).map(({ id }) => id)).toEqual([third, first, second]);
    const rows = ctx.db
      .prepare("SELECT id, sort_order, updated_at FROM projects ORDER BY sort_order")
      .all();
    expect(rows).toEqual([
      { id: third, sort_order: 0, updated_at: 77 },
      { id: first, sort_order: 1, updated_at: 77 },
      { id: second, sort_order: 2, updated_at: 77 },
    ]);
  });

  // The old guard took any string array, an empty one and unknown ids
  // included; it refused anything else. So does the procedure's input.
  it("accepts what the channel's guard accepted, and refuses what it refused", async () => {
    await expect(request("project.reorder", "mutation", { orderedIds: [] })).resolves.toEqual({
      ok: true,
      data: null,
    });
    await expect(
      request("project.reorder", "mutation", { orderedIds: ["", "unknown"] }),
    ).resolves.toEqual({ ok: true, data: null });
    for (const orderedIds of ["not-an-array", ["p1", 2]]) {
      await expect(request("project.reorder", "mutation", { orderedIds })).resolves.toMatchObject({
        ok: false,
        error: { code: "BAD_REQUEST" },
      });
    }
  });
});

describe("worktree.trimSettings (was volli:worktree-trim-settings-get)", () => {
  it("reads the host's trim settings, defaults and a saved value alike", async () => {
    await expect(request("worktree.trimSettings", "query", undefined)).resolves.toEqual({
      ok: true,
      data: getTrimSettings(ctx.db),
    });
    const saved = setTrimSettings(ctx.db, { trimOnFinish: false, keepPatterns: [".env.local"] }, 1);
    await expect(request("worktree.trimSettings", "query", undefined)).resolves.toEqual({
      ok: true,
      data: saved,
    });
  });
});
