import { describe, expect, it, vi } from "vite-plus/test";

import type { CliDoctorResult, CliToolStatus, VolliIpcChannel } from "../ipc/contract";

// Hoisted above module evaluation so the electron mock factory can capture into
// it — the shape harness-ipc.test.ts and data-ipc.test.ts use.
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

import { registerCliIpcHandlers } from "./cli-ipc";
import type { CliIpcDeps } from "./cli-ipc";

const STATUS: CliToolStatus = {
  link: { path: "/home/me/.local/bin/volli", state: "ours", target: "/shim/volli" },
  path: { binDir: "/home/me/.local/bin", state: "reachable" },
  environment: {
    loginPath: "/usr/bin:/home/me/.local/bin",
    session: {
      path: "/volli/bin:/usr/bin:/home/me/.local/bin",
      provenance: "adopted",
      interactiveProvenance: "already-complete",
      tools: {
        git: "/usr/bin/git",
        gh: "/opt/homebrew/bin/gh",
        node: "/opt/homebrew/bin/node",
        pnpm: "/opt/homebrew/bin/pnpm",
      },
      dependencies: null,
    },
    systemPathIssues: [],
  },
  socket: { path: "/profiles/volli.sock", live: true },
  wrappers: { commands: ["claude"] },
  shell: { name: "zsh", supported: true, chainActive: true },
  legacy: { path: "/usr/local/bin/volli", state: "absent" },
  installSuppressed: false,
};

const REPORT: CliDoctorResult = { ok: true, checks: [], summary: "All 0 checks passed." };

function invoke(channel: VolliIpcChannel, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  // `ipcMain.handle` hands the event first; the registry appends the sender.
  return Promise.resolve(handler(...([{ sender: {} }, ...args] as never[])));
}

function register(overrides: Partial<CliIpcDeps> = {}): { repairs: number; probes: number } {
  handlers.clear();
  const counters = { repairs: 0, probes: 0 };
  registerCliIpcHandlers({
    status: async () => STATUS,
    doctor: async () => {
      counters.probes += 1;
      return REPORT;
    },
    repair: async () => {
      counters.repairs += 1;
    },
    ...overrides,
  });
  return counters;
}

describe("registerCliIpcHandlers", () => {
  it("answers the status read with the measured install", async () => {
    register();

    await expect(invoke("volli:cli-status")).resolves.toEqual({ ok: true, status: STATUS });
  });

  it("passes a project root to the status measurement", async () => {
    const status = vi.fn<CliIpcDeps["status"]>(async () => STATUS);
    register({ status });

    await expect(invoke("volli:cli-status", { cwd: "/work/acme" })).resolves.toEqual({
      ok: true,
      status: STATUS,
    });
    expect(status).toHaveBeenCalledWith({ cwd: "/work/acme" });
  });

  it("probes without repairing on a plain doctor run", async () => {
    const counters = register();

    await expect(invoke("volli:cli-doctor", { fix: false })).resolves.toEqual(REPORT);
    expect(counters).toEqual({ repairs: 0, probes: 1 });
  });

  it("repairs BEFORE probing on fix, so the report describes the repaired world", async () => {
    const order: string[] = [];
    const counters = register({
      doctor: async () => {
        order.push("probe");
        return REPORT;
      },
      repair: async () => {
        order.push("repair");
      },
    });

    await expect(invoke("volli:cli-doctor", { fix: true })).resolves.toEqual(REPORT);
    expect(order).toEqual(["repair", "probe"]);
    expect(counters).toEqual({ repairs: 0, probes: 0 }); // overridden counters unused
  });

  it("surfaces a failed repair as data, not a rejection", async () => {
    register({
      repair: async () => {
        throw new Error("regeneration failed");
      },
    });

    await expect(invoke("volli:cli-doctor", { fix: true })).resolves.toEqual({
      ok: false,
      error: "regeneration failed",
    });
  });
});
