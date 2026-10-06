import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { installLayout, type InstallLayout } from "./layout";
import { ManagementError, writeManaged, type CommandResult } from "./management";
import { runStart, type StartCommand, type StartPorts } from "./start";
import type { HostdStatus, StatusProbes } from "./status";

let root: string;
let layout: InstallLayout;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-start-"));
  layout = installLayout("system", { prefix: root, home: join(root, "home"), env: {} });
  mkdirSync(layout.root, { recursive: true });
  writeManaged(layout, { v: 1, mode: "system", version: "1.1.0", port: 7420, installedAt: "t" });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function status(overrides: Partial<HostdStatus> = {}): HostdStatus {
  return {
    v: 1,
    state: "serving",
    pid: 42,
    version: "1.1.0",
    startedAt: "t",
    updatedAt: "t",
    dataDir: layout.dataDir,
    socketPath: "/run/volli-hostd.sock",
    database: { ok: true, path: "db" },
    capabilities: {
      board: "available",
      sessions: "available",
      terminals: "unavailable",
      browser: "unavailable",
      automations: "available",
    },
    hostProtocol: { url: "ws://127.0.0.1:7420", host: "127.0.0.1", port: 7420 },
    hostId: "host-1",
    ...overrides,
  };
}

/** Each read answers the next status in `sequence`, then the last one forever. */
function probes(...sequence: (HostdStatus | null)[]): StatusProbes {
  let index = 0;
  return {
    read: () => sequence[Math.min(index++, sequence.length - 1)]!,
    alive: () => true,
    accepts: async () => true,
  };
}

function box(answers: Record<string, (args: readonly string[]) => Partial<CommandResult>> = {}) {
  const calls: string[] = [];
  const run = (tool: string, args: readonly string[]): CommandResult => {
    calls.push([tool, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "", ...answers[tool]?.(args) };
  };
  return { calls, run };
}

const SYSTEM: StartCommand = { kind: "start", mode: "system", timeoutMs: 5_000 };

function ports(overrides: Partial<StartPorts> = {}): StartPorts & { slept: number[] } {
  const slept: number[] = [];
  let clock = 0;
  return {
    uid: () => 0,
    login: () => "alice",
    layout,
    run: box().run,
    probes: probes(status()),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...overrides,
    slept,
  };
}

async function refusal(work: Promise<unknown>): Promise<ManagementError> {
  const error = await work.then(
    () => new Error("expected a refusal"),
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ManagementError);
  return error as ManagementError;
}

describe("start", () => {
  it("does nothing when the recorded version already serves on the recorded port", async () => {
    const fake = box();
    expect(await runStart(SYSTEM, ports({ run: fake.run }))).toEqual({
      v: 1,
      ok: true,
      mode: "system",
      version: "1.1.0",
      restarted: false,
      hostId: "host-1",
      listen: { host: "127.0.0.1", port: 7420 },
      linger: null,
    });
    expect(fake.calls).toEqual([]);
    const { hostId: _, ...older } = status();
    expect((await runStart(SYSTEM, ports({ probes: probes(older) }))).hostId).toBeNull();
  });

  it("restarts an older host, both units in the runbook's order, and waits for it to serve", async () => {
    const fake = box({ systemctl: () => ({ stdout: "ActiveState=activating\n" }) });
    const p = ports({
      run: fake.run,
      probes: probes(status({ version: "1.0.0" }), null, status({ state: "starting" }), status()),
    });
    expect(await runStart(SYSTEM, p)).toMatchObject({ restarted: true, version: "1.1.0" });
    expect(fake.calls.slice(0, 2)).toEqual([
      "systemctl stop volli-hostd.service volli-hostd.socket",
      "systemctl start volli-hostd.socket volli-hostd.service",
    ]);
    expect(p.slept).toEqual([500, 500]);
  });

  it("restarts a host listening on another port, and reports no listener when there is none", async () => {
    const p = ports({
      probes: probes(
        status({ hostProtocol: { url: "ws://127.0.0.1:1", host: "127.0.0.1", port: 1 } }),
        status({ hostProtocol: null }),
      ),
    });
    writeManaged(layout, { v: 1, mode: "system", version: "1.1.0", port: 7420, installedAt: "t" });
    // A listener-less host never matches, so this waits out its timeout.
    expect(await refusal(runStart({ ...SYSTEM, timeoutMs: 1_000 }, p))).toMatchObject({
      code: "start-timeout",
      message: "volli-hostd did not serve within 1 s.",
    });
  });

  it("says why a host that came up will not serve", async () => {
    const refusing = (database: HostdStatus["database"]) =>
      ports({ probes: probes(null, status({ state: "refusing", database })) });
    expect(
      await refusal(
        runStart(
          SYSTEM,
          refusing({
            ok: false,
            path: "db",
            error: "This database is from a newer Volli.",
            failure: null,
          }),
        ),
      ),
    ).toMatchObject({ code: "refusing", message: "This database is from a newer Volli." });
    expect((await refusal(runStart(SYSTEM, refusing(null)))).message).toBe(
      "volli-hostd is up but refusing to serve.",
    );
  });

  it("hands back the journal's last lines when the unit fails", async () => {
    const failed = box({
      systemctl: (args) =>
        args.includes("show") ? { stdout: "ActiveState=failed\nUnitFileState=enabled\n" } : {},
      journalctl: () => ({ stdout: "boot refused: data directory\n\n" }),
    });
    expect(
      await refusal(runStart(SYSTEM, ports({ run: failed.run, probes: probes(null) }))),
    ).toMatchObject({
      code: "start-failed",
      detail: ["boot refused: data directory"],
    });
    expect(failed.calls).toContain("journalctl -u volli-hostd.service -n 20 -o cat --no-pager");
  });

  it("gives up after its timeout, with what status last said", async () => {
    const quiet = box({ journalctl: () => ({ code: 1 }) });
    expect(
      await refusal(runStart(SYSTEM, ports({ run: quiet.run, probes: probes(null) }))),
    ).toMatchObject({ code: "start-timeout", detail: ["no status file"] });
  });

  it("refuses to run as the wrong account, or before anything is installed", async () => {
    expect(await refusal(runStart(SYSTEM, ports({ uid: () => 1000 })))).toMatchObject({
      code: "not-root",
      exitCode: 77,
    });
    expect((await refusal(runStart({ ...SYSTEM, mode: "user" }, ports()))).code).toBe("is-root");
    rmSync(layout.managedFile);
    expect((await refusal(runStart(SYSTEM, ports()))).code).toBe("not-installed");
  });
});

describe("start --user", () => {
  let user: InstallLayout;
  const USER: StartCommand = { ...SYSTEM, mode: "user" };

  beforeEach(() => {
    user = installLayout("user", { home: join(root, "home"), env: {} });
    mkdirSync(user.root, { recursive: true });
    writeManaged(user, { v: 1, mode: "user", version: "1.1.0", port: 7420, installedAt: "t" });
  });

  it("turns lingering on itself when logind lets it, and starts the user unit", async () => {
    let linger = "no";
    const fake = box({
      loginctl: (args) => {
        if (args[0] === "enable-linger") linger = "yes";
        return { stdout: `${linger}\n` };
      },
    });
    const p = ports({
      uid: () => 1000,
      layout: user,
      run: fake.run,
      probes: probes(null, status()),
    });
    expect(await runStart(USER, p)).toMatchObject({ mode: "user", linger: true, restarted: true });
    expect(fake.calls).toEqual([
      "loginctl show-user alice -p Linger --value",
      "loginctl enable-linger alice",
      "loginctl show-user alice -p Linger --value",
      "systemctl --user stop volli-hostd.service",
      "systemctl --user start volli-hostd.service",
    ]);
  });

  it("names the one sudo command when lingering is refused, and starts nothing", async () => {
    for (const answer of [{ stdout: "no\n" }, { code: 1 }, { stdout: "maybe\n" }]) {
      const fake = box({ loginctl: () => answer });
      const error = await refusal(
        runStart(USER, ports({ uid: () => 1000, layout: user, run: fake.run })),
      );
      expect(error).toMatchObject({
        code: "linger-required",
        message: "alice's host would stop when you log out. Run: sudo loginctl enable-linger alice",
      });
      expect(fake.calls.some((call) => call.startsWith("systemctl"))).toBe(false);
    }
  });

  it("reads a user unit's journal with --user", async () => {
    const fake = box({
      loginctl: () => ({ stdout: "yes\n" }),
      systemctl: (args) => (args.includes("show") ? { stdout: "ActiveState=failed\n" } : {}),
    });
    await refusal(
      runStart(USER, ports({ uid: () => 1000, layout: user, run: fake.run, probes: probes(null) })),
    );
    expect(fake.calls).toContain(
      "journalctl --user -u volli-hostd.service -n 20 -o cat --no-pager",
    );
  });
});
