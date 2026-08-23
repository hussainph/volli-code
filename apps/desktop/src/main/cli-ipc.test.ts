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
        npm: "/opt/homebrew/bin/npm",
        pnpm: "/opt/homebrew/bin/pnpm",
        yarn: null,
        bun: null,
      },
      requiredTools: [],
      dependencies: null,
      installCommand: null,
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
    doctor: async (_cwd) => {
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

  // The probe judges requirements from the directory it runs in (VC-157), so
  // the project scope has to reach it the same way the status read's does.
  it("passes a project root to the doctor probe", async () => {
    const doctor = vi.fn<CliIpcDeps["doctor"]>(async () => REPORT);
    register({ doctor });

    await expect(invoke("volli:cli-doctor", { fix: false, cwd: "/work/acme" })).resolves.toEqual(
      REPORT,
    );
    expect(doctor).toHaveBeenCalledWith("/work/acme");
  });

  it("tells the probe there is no project rather than letting it inherit one", async () => {
    const doctor = vi.fn<CliIpcDeps["doctor"]>(async () => REPORT);
    register({ doctor });

    await invoke("volli:cli-doctor", { fix: false });
    expect(doctor).toHaveBeenCalledWith(null);
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

  // The launch banner's Fix now (VC-159): the repair alone, so a host whose
  // login shell is the thing that did not answer never waits out the doctor
  // probe's timeout to be told what it already knows.
  it("runs the repair with no probe behind it", async () => {
    const counters = register();

    await expect(invoke("volli:cli-repair")).resolves.toEqual({ ok: true });
    expect(counters).toEqual({ repairs: 1, probes: 0 });
  });

  it("reports a repair that failed instead of claiming one that did not happen", async () => {
    register({
      repair: async () => {
        throw new Error("regeneration failed");
      },
    });

    await expect(invoke("volli:cli-repair")).resolves.toEqual({
      ok: false,
      error: "regeneration failed",
    });
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
