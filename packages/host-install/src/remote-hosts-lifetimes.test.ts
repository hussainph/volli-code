/**
 * The remote hosts engine's lifetimes (VC-700 PR 2, the #815 review's
 * blockers): quit owns everything in flight, one finalization per host, a
 * finalization that fails can still finish, owned SSH children, bounded
 * flow retention, answers that must fit the current question, the link cap,
 * waking on resume, and the sudo password forgotten at every stop.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostLinkLogEvent } from "@volli/host-protocol/client-link";
import { REMOTE_HOST_LINK_CAP } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PROBE_SCRIPT } from "./probe";
import {
  answerFits,
  createRemoteHosts,
  DEFAULT_QUIT_GRACE_MS,
  RemoteHostsUnavailableError,
  type RemoteHostsPorts,
} from "./remote-hosts";
import { systemSsh } from "./ssh";
import type { RegistryFile } from "./remote-hosts-registry";
import {
  CURRENT,
  flush,
  harness,
  HOST_ID,
  HOST_KEY,
  hostEntry,
  PASSWORD,
  probeOutput,
  questionOf,
  registry,
  startAdd,
  watch,
  WS1,
  ready,
  type FakeLink,
  type Harness,
} from "./testing/remote-hosts-harness";
import { createSshTunnel } from "./tunnel";

afterEach(() => {
  vi.useRealTimers();
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const existing = (adoptable: boolean) =>
  harness({
    overrides: [
      (script) =>
        script === PROBE_SCRIPT
          ? {
              stdout: probeOutput(
                {},
                [
                  "hostd=system managed 1.0.0",
                  `hostd_path=${CURRENT}`,
                  `status=${adoptable ? JSON.stringify({ v: 1, management: 1, verdict: "serving", running: null, devices: [] }) : ""}`,
                ].join("\n"),
              ),
            }
          : undefined,
    ],
  });

const q = (kind: string, fields: Record<string, string | boolean> = {}) => ({
  id: "q1",
  kind,
  step: "probe" as const,
  ...fields,
});

const workspaces = (count: number) =>
  Array.from({ length: count }, (_, i) => `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

/** Turns the event loop until `check` holds. */
async function until(check: () => boolean): Promise<void> {
  while (!check()) await flush();
}

/** Holds the first flow's write of its host's key, inside its lease, until released. */
function holdFirstHostKey(h: Harness): { release: () => void; held: () => boolean } {
  let release: (() => void) | undefined;
  let count = 0;
  h.keys.hooks.put = (name) => {
    if (!name.startsWith("host:") || (count += 1) !== 1) return undefined;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  return { release: () => release!(), held: () => release !== undefined };
}

describe("a cancel at any step leaves nothing behind (the review's cancel probes)", () => {
  it.each(["connect", "probe", "deliver", "install", "start", "enroll", "link"])(
    "at %s: no host, no key, no tunnel, no open SSH, and the flow says cancelled",
    async (step) => {
      const gate: { release?: () => void; entered: boolean } = { entered: false };
      const held = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      const h = harness({
        tunnelMode: step === "link" ? "hold" : "up",
        overrides: [
          async (script, options) => {
            const matches =
              step === "connect"
                ? script === "echo volli-ok"
                : step === "probe"
                  ? script === PROBE_SCRIPT
                  : step === "deliver"
                    ? options.label === "upload: check"
                    : script.includes(` ${step} --`);
            if (!matches || step === "link") return undefined;
            gate.entered = true;
            await held;
            return undefined;
          },
        ],
      });
      const { flowId } = await h.engine.startAdd({ target: "deploy@fake" });
      const w = watch(h.engine, flowId);
      if (step === "link") {
        await w.until((view) => view.steps[6]?.status === "running");
        await flush();
      } else {
        await until(() => gate.entered);
      }
      await h.engine.cancelAdd(flowId);
      gate.release!();
      for (let turn = 0; turn < 5; turn += 1) await flush();
      expect(h.engine.snapshot().hosts).toEqual([]);
      expect(h.keys.keys.size).toBe(0);
      expect(h.store.saves).toEqual([]);
      expect(h.tunnels.made.every((tunnel) => tunnel.closed)).toBe(true);
      expect(h.box.transports.every((transport) => transport.closed)).toBe(true);
      expect(w.views().at(-1)?.status).toBe("cancelled");
      await expect(h.engine.sudoPassword(flowId, "q1", "x")).rejects.toMatchObject({
        code: "flow-not-waiting",
      });
      await h.engine.close();
    },
  );
});

describe("quit owns everything in flight (B2)", () => {
  it("a flow writing its host's key when quit comes keeps nothing: no host, no key, no tunnel", async () => {
    const h = harness();
    let release: (() => void) | undefined;
    h.keys.hooks.put = (name) =>
      name.startsWith("host:")
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    const { flowId } = await h.engine.startAdd({ target: "deploy@fake" });
    const w = watch(h.engine, flowId);
    await until(() => release !== undefined);
    const closed = h.engine.close();
    // Cancelled at once; quit waits for the write in flight to land and be undone.
    expect(w.views().at(-1)?.status).toBe("cancelled");
    release!();
    await closed;
    expect(w.views().at(-1)?.status).toBe("cancelled");
    expect(h.tunnels.made.every((tunnel) => tunnel.closed)).toBe(true);
    expect(h.keys.keys.size).toBe(0);
    expect(h.store.saves).toEqual([]);
    expect(h.box.transports.every((transport) => transport.closed)).toBe(true);
  });

  it("a start awaiting its key when quit comes ends in unavailable, its key removed", async () => {
    const h = harness();
    let release: (() => void) | undefined;
    h.keys.hooks.put = (name) =>
      name.startsWith("flow:")
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    const started = h.engine.startAdd({ target: "deploy@fake" });
    await until(() => release !== undefined);
    const closed = h.engine.close();
    release!();
    await expect(started).rejects.toBeInstanceOf(RemoteHostsUnavailableError);
    await closed;
    expect(h.keys.keys.size).toBe(0);
    expect(h.tunnels.made).toEqual([]);
    expect(h.box.transports).toEqual([]);
  });

  it("returns within its grace when a step will not finish, and nothing lands after it", async () => {
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      quitGraceMs: 10,
      overrides: [
        async (script) => {
          if (script !== PROBE_SCRIPT) return undefined;
          // Ignores the transport's close, as a hung download would.
          await stuck;
          return undefined;
        },
      ],
    });
    const { flowId } = await h.engine.startAdd({ target: "deploy@fake" });
    const w = watch(h.engine, flowId);
    await w.until((view) => view.steps[1]?.status === "running");
    await h.engine.close();
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({ msg: "remote hosts quit at its deadline; ending what is left" }),
    );
    release();
    for (let turn = 0; turn < 10; turn += 1) await flush();
    expect(h.box.ran().some((script) => script.includes("cat > "))).toBe(false);
    expect(h.keys.keys.size).toBe(0);
    expect(w.views().at(-1)?.status).toBe("cancelled");
  });

  it("a link step's tunnel that opens after quit is closed, never handed on", async () => {
    const h = harness({ tunnelMode: "hold" });
    const { flowId } = await h.engine.startAdd({ target: "deploy@fake" });
    await watch(h.engine, flowId).until((view) => view.steps[6]?.status === "running");
    await flush();
    const tunnel = h.tunnels.made[0]!;
    const pending = tunnel.pending!;
    tunnel.pending = null;
    // As if the tunnel's open won the race with its close.
    tunnel.close = () => {
      tunnel.closed = true;
    };
    const closed = h.engine.close();
    pending.resolve(tunnel.url);
    await closed;
    expect(tunnel.closed).toBe(true);
    expect(h.store.saves).toEqual([]);
  });

  it("says when a flow's keys would not go at quit", async () => {
    const h = harness();
    h.box.trusted = false;
    await startAdd(h);
    h.keys.hooks.remove = () => Promise.reject(new Error("keychain locked"));
    await h.engine.close();
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({
        msg: "an add flow did not close cleanly",
        fields: { flowId: "flow-1", error: "keychain locked" },
      }),
    );
  });

  it("abandons a key removal that never ends at its deadline, says which, and returns", async () => {
    const h = harness({ quitGraceMs: 20 });
    h.box.trusted = false;
    const { flowId } = await startAdd(h);
    const held: { release?: () => void } = {};
    h.keys.hooks.remove = () =>
      new Promise<void>((resolve) => {
        held.release = resolve;
      });
    const started = Date.now();
    await h.engine.close();
    expect(Date.now() - started).toBeLessThan(500);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({
        msg: "remote hosts quit at its deadline; ending what is left",
        fields: { graceMs: 20, abandoned: flowId },
      }),
    );
    // Landing late changes nothing: the engine is closed, the flow let go.
    held.release!();
    for (let turn = 0; turn < 5; turn += 1) await flush();
    expect(h.store.saves).toEqual([]);
    expect(() => h.engine.subscribeAdd(flowId, () => {})).toThrow(RemoteHostsUnavailableError);
  });

  it("shares one close between every caller", async () => {
    const h = harness();
    const first = h.engine.close();
    expect(h.engine.close()).toBe(first);
    await first;
  });
});

describe("one finalization per host (B3)", () => {
  it("a target with a flow under way answers that flow: a retried start is the same add", async () => {
    const h = harness();
    h.box.trusted = false;
    const first = await startAdd(h, { target: "deploy@box" });
    expect(first.view.status).toBe("question");
    const again = await h.engine.startAdd({ target: " deploy@box ", name: "Other name" });
    expect(again.flowId).toBe(first.flowId);
    // Two starts at once, before either has its key: still one flow.
    const h2 = harness();
    h2.box.trusted = false;
    const [one, two] = await Promise.all([
      h2.engine.startAdd({ target: "deploy@box" }),
      h2.engine.startAdd({ target: "deploy@box" }),
    ]);
    expect(two.flowId).toBe(one.flowId);
    expect(h2.keys.calls).toEqual(["put flow:flow-1", "put flow:flow-2", "remove flow:flow-2"]);
    expect(h2.box.transports).toHaveLength(1);
    // Once that add is done, a re-add is a new flow.
    h.box.trusted = true;
    await h.engine.answerAdd(first.flowId, "q1", { kind: "accept-host-key" });
    expect(first.w.views().at(-1)?.status).toBe("done");
    const readd = await startAdd(h, { target: "deploy@box" });
    expect(readd.flowId).not.toBe(first.flowId);
    expect(readd.view.status).toBe("done");
  });

  it("two flows finishing for one host (two names for one box) leave one tunnel, and none after quit", async () => {
    const h = harness();
    const hold = holdFirstHostKey(h);
    const one = await h.engine.startAdd({ target: "deploy@fake" });
    const w1 = watch(h.engine, one.flowId);
    // Flow 1 holds the host's lease, writing its key, when flow 2 reaches the same host.
    while (!hold.held()) await flush();
    const two = await h.engine.startAdd({ target: "deploy@fake-alias" });
    const w2 = watch(h.engine, two.flowId);
    for (let turn = 0; turn < 10; turn += 1) await flush();
    // Flow 2 waits its turn: both tunnels open, neither handed on yet.
    expect(w2.views().at(-1)?.status).toBe("running");
    expect(h.store.saves).toEqual([]);
    hold.release();
    await w1.until((view) => view.status === "done");
    await w2.until((view) => view.status === "done");
    for (let turn = 0; turn < 5; turn += 1) await flush();
    // The second handoff stopped the first's runtime: one tunnel, tracked.
    expect(h.tunnels.made).toHaveLength(2);
    expect(h.tunnels.made.filter((tunnel) => !tunnel.closed)).toHaveLength(1);
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
    await h.engine.close();
    expect(h.tunnels.made.filter((tunnel) => !tunnel.closed)).toHaveLength(0);
  });

  it("serializes a forget with a finalization of the same host", async () => {
    const h = harness();
    const added = await startAdd(h);
    expect(added.view.status).toBe("done");
    const hold = holdFirstHostKey(h);
    const readd = await h.engine.startAdd({ target: "deploy@box" });
    while (!hold.held()) await flush();
    // Waits for the re-add's lease, then forgets what it registered.
    const forgot = h.engine.forget(HOST_ID);
    hold.release();
    await forgot;
    await watch(h.engine, readd.flowId).until((view) => view.status === "done");
    expect(h.engine.snapshot().hosts).toEqual([]);
    expect(h.keys.keys.size).toBe(0);
    expect(h.tunnels.made.every((tunnel) => tunnel.closed)).toBe(true);
  });
});

describe("a failure late in finalization can still finish (B6)", () => {
  it("an SSH close that fails after the host is saved is only logged: the add is done", async () => {
    const h = harness();
    h.box.closeFails = 1;
    const { flowId, view } = await startAdd(h);
    expect(view.status).toBe("done");
    expect(h.keys.keys.has(`flow:${flowId}`)).toBe(false);
    expect([...h.keys.keys.keys()]).toEqual([HOST_KEY]);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({ msg: "an add flow's ssh connection did not close cleanly" }),
    );
  });

  it("a key store that will not take the host's key fails retryably, and a cancel then cleans up", async () => {
    const h = harness();
    h.keys.hooks.put = (name) =>
      name.startsWith("host:") ? Promise.reject(new Error("keychain locked")) : undefined;
    const { flowId, view } = await startAdd(h);
    expect(view.failure).toMatchObject({ code: "save-failed", recovery: { from: "link" } });
    // The flow keeps its key and its link tunnel for the retry.
    expect(h.keys.keys.has(`flow:${flowId}`)).toBe(true);
    await h.engine.cancelAdd(flowId);
    expect(h.keys.keys.size).toBe(0);
    expect(h.tunnels.made.every((tunnel) => tunnel.closed)).toBe(true);
    expect(h.keys.calls.filter((call) => call.startsWith("remove"))).toEqual([
      "remove flow:flow-1",
      `remove ${HOST_KEY}`,
    ]);
  });

  it("a cancel whose key removal fails says so, and still ends the flow", async () => {
    const h = harness();
    h.box.trusted = false;
    const { flowId, w } = await startAdd(h);
    h.keys.hooks.remove = () => Promise.reject(new Error("keychain locked"));
    await expect(h.engine.cancelAdd(flowId)).rejects.toThrow("keychain locked");
    expect(w.views().at(-1)?.status).toBe("cancelled");
  });
});

describe("owned SSH children: no live process after quit (B3, B7)", () => {
  let dir: string;
  let fakeSsh: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-install-live-"));
    fakeSsh = join(dir, "ssh");
    // Ignores SIGTERM, never exits on its own; never a real ssh.
    writeFileSync(
      fakeSsh,
      `#!/usr/bin/env node
if (process.argv.includes("-O")) process.exit(0);
process.on("SIGTERM", () => {});
process.stderr.write("ready\\n");
setInterval(() => {}, 1000);
`,
    );
    chmodSync(fakeSsh, 0o755);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Real tunnels over the stubborn fake: every child it spawns, kept for the check. */
  function liveTunnels(): { tunnel: RemoteHostsPorts["tunnel"]; children: ChildProcess[] } {
    const children: ChildProcess[] = [];
    let port = 41_000;
    const tunnel: RemoteHostsPorts["tunnel"] = (options) => {
      let carried: Promise<void> = Promise.resolve();
      return createSshTunnel({
        ...options,
        sshPath: fakeSsh,
        freePort: async () => (port += 1),
        accepts: async () => {
          await carried;
          return true;
        },
        timing: { killAfterMs: 30 },
        spawn(command, args) {
          const child = nodeSpawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
          children.push(child);
          carried = new Promise<void>((resolve) => {
            child.stderr!.once("data", () => resolve());
            child.once("close", () => resolve());
          });
          return child;
        },
      });
    };
    return { tunnel, children };
  }

  it("two finishes for one host, then quit: every fake ssh is gone", async () => {
    const { tunnel, children } = liveTunnels();
    const h = harness({ tunnel });
    try {
      const hold = holdFirstHostKey(h);
      const one = await h.engine.startAdd({ target: "deploy@fake" });
      const w1 = watch(h.engine, one.flowId);
      await until(() => hold.held());
      const two = await h.engine.startAdd({ target: "deploy@fake-alias" });
      const w2 = watch(h.engine, two.flowId);
      hold.release();
      await w1.until((view) => view.status === "done");
      await w2.until((view) => view.status === "done");
      await h.engine.close();
      // Gone by the time close answers: quit SIGKILLs what is left and waits for it.
      expect(children).toHaveLength(2);
      expect(children.map((child) => alive(child.pid!))).toEqual([false, false]);
    } finally {
      for (const child of children) if (alive(child.pid!)) child.kill("SIGKILL");
    }
  });

  it("returns within the default grace when the command and ssh -O exit both ignore SIGTERM", async () => {
    // Even the control-exit command stalls: the re-check's stubborn-control-ssh.
    const stubborn = join(dir, "stubborn-control-ssh");
    writeFileSync(
      stubborn,
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stderr.write("ready\\n");
setInterval(() => {}, 1000);
`,
    );
    chmodSync(stubborn, 0o755);
    const children: ChildProcess[] = [];
    let commandRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      commandRunning = resolve;
    });
    const controlDir = join(dir, "control");
    mkdirSync(controlDir, { mode: 0o700 });
    const h = harness();
    const engine = createRemoteHosts({
      ...h.ports,
      ssh: (target) =>
        systemSsh({
          target,
          logger: h.log.logger,
          sshPath: stubborn,
          controlDir,
          spawn(command, args) {
            const child = nodeSpawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
            children.push(child);
            child.stderr!.once("data", () => commandRunning());
            return child;
          },
        }),
    });
    try {
      await engine.startAdd({ target: "deploy@fake" });
      await running;
      const started = Date.now();
      await engine.close();
      const elapsed = Date.now() - started;
      // The default grace, plus the short wait for what it SIGKILLed.
      expect(elapsed).toBeLessThan(DEFAULT_QUIT_GRACE_MS + 700);
      expect(children.length).toBeGreaterThanOrEqual(2);
      expect(children.map((child) => alive(child.pid!))).toEqual(children.map(() => false));
      expect(h.log.lines).toContainEqual(
        expect.objectContaining({
          msg: "ssh processes still running past the deadline; killing them",
        }),
      );
    } finally {
      await h.engine.close();
      for (const child of children) if (alive(child.pid!)) child.kill("SIGKILL");
    }
  }, 15_000);

  it.each(["quit", "forget", "cancel"] as const)(
    "after %s, no fake ssh is left alive",
    async (action) => {
      const { tunnel, children } = liveTunnels();
      const h = harness({ tunnel });
      try {
        const { flowId } = await h.engine.startAdd({ target: "deploy@fake" });
        const w = watch(h.engine, flowId);
        if (action === "cancel") {
          await w.until((view) => view.steps[6]?.status === "running");
          await until(() => children.length > 0);
          await h.engine.cancelAdd(flowId);
        } else {
          await w.until((view) => view.status === "done");
          if (action === "forget") await h.engine.forget(HOST_ID);
          else await h.engine.close();
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(children.length).toBeGreaterThan(0);
        expect(children.every((child) => !alive(child.pid!))).toBe(true);
        await h.engine.close();
      } finally {
        for (const child of children) if (alive(child.pid!)) child.kill("SIGKILL");
      }
    },
  );
});

describe("finished flows are let go (note 3)", () => {
  it("after their time, or past the count, answering unknown-flow", async () => {
    const h = harness({ flowRetention: { ttlMs: 60, max: 2 } });
    const flows: string[] = [];
    for (const target of ["a@one", "b@two", "c@three"]) {
      const { flowId, view } = await startAdd(h, { target });
      expect(view.status).toBe("done");
      flows.push(flowId);
    }
    // Three done, two kept: the oldest is gone.
    expect(() => h.engine.subscribeAdd(flows[0]!, () => {})).toThrow(
      expect.objectContaining({ code: "unknown-flow" }),
    );
    expect(() => h.engine.subscribeAdd(flows[2]!, () => {})).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const flowId of flows) {
      expect(() => h.engine.subscribeAdd(flowId, () => {})).toThrow(
        expect.objectContaining({ code: "unknown-flow" }),
      );
      await expect(h.engine.cancelAdd(flowId)).rejects.toMatchObject({ code: "unknown-flow" });
    }
    await h.engine.close();
  });

  it("a cancelled flow too, and quit lets every flow go", async () => {
    vi.useFakeTimers();
    const h = harness({ flowRetention: { ttlMs: 1_000, max: 20 } });
    h.box.trusted = false;
    const { flowId } = await h.engine.startAdd({ target: "a@one" });
    await vi.advanceTimersByTimeAsync(0);
    await h.engine.cancelAdd(flowId);
    await vi.advanceTimersByTimeAsync(999);
    expect(() => h.engine.subscribeAdd(flowId, () => {})).not.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    expect(() => h.engine.subscribeAdd(flowId, () => {})).toThrow(
      expect.objectContaining({ code: "unknown-flow" }),
    );
    await h.engine.close();
  });
});

describe("answers must fit the question asked now (note 4)", () => {
  it("refuses adopt when the hostd there cannot be adopted", async () => {
    const h = existing(false);
    const { flowId, view } = await startAdd(h);
    expect(view.question).toMatchObject({ kind: "existing-hostd", adoptable: false });
    await expect(h.engine.answerAdd(flowId, "q1", { kind: "adopt" })).rejects.toMatchObject({
      code: "flow-not-waiting",
    });
    await h.engine.answerAdd(flowId, "q1", { kind: "update" });
    await watch(h.engine, flowId).until((v) => v.status === "done");
  });

  it("takes adopt when it can, and refuses a password for a question that is not sudo's", async () => {
    const h = existing(true);
    const { flowId } = await startAdd(h);
    await expect(h.engine.sudoPassword(flowId, "q1", PASSWORD)).rejects.toThrow(
      "does not take that answer to existing-hostd",
    );
    await h.engine.answerAdd(flowId, "q1", { kind: "adopt" });
  });

  it("refuses user-install for a sudo question that is not the install's, and anything for a kind it does not know", async () => {
    const h = harness({
      overrides: [
        (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
      ],
    });
    const { flowId, view } = await startAdd(h);
    expect(view.question).toMatchObject({ kind: "sudo-password", reason: "install" });
    await h.engine.answerAdd(flowId, "q1", { kind: "user-install" });
    expect(questionOf(h.engine, flowId)).toBe("none");
    // A question's own fields are open JSON: a kind this build does not know takes no answer.
    const odd = harness({
      overrides: [
        (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
      ],
    });
    const asked = await startAdd(odd);
    const flow = asked.view.question!;
    expect(flow.reason).toBe("install");
    await expect(
      odd.engine.answerAdd(asked.flowId, "q1", { kind: "repair" }),
    ).rejects.toMatchObject({ code: "flow-not-waiting" });
  });
});

describe("which answers each question takes", () => {
  it("is exactly the ones it offers", () => {
    expect(answerFits(q("host-key"), { kind: "accept-host-key" })).toBe(true);
    expect(answerFits(q("host-key"), { kind: "open" })).toBe(false);
    expect(answerFits(q("existing-hostd", { adoptable: true }), { kind: "adopt" })).toBe(true);
    expect(answerFits(q("existing-hostd", { adoptable: false }), { kind: "adopt" })).toBe(false);
    expect(answerFits(q("existing-hostd"), { kind: "update" })).toBe(true);
    expect(answerFits(q("already-paired"), { kind: "open" })).toBe(true);
    expect(answerFits(q("already-paired"), { kind: "repair" })).toBe(false);
    expect(answerFits(q("sudo-password", { reason: "install" }), { kind: "user-install" })).toBe(
      true,
    );
    expect(answerFits(q("sudo-password", { reason: "linger" }), { kind: "user-install" })).toBe(
      false,
    );
    expect(answerFits(q("identity-changed"), { kind: "repair" })).toBe(true);
    expect(answerFits(q("a-later-kind"), { kind: "open" })).toBe(false);
  });
});

describe("the sudo password is forgotten at every stop (security N2)", () => {
  it("a failure after it was given asks for it again rather than reuse it", async () => {
    let refuse = true;
    const h = harness({
      overrides: [
        (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
        (script) => {
          if (!script.includes(" start --") || !refuse) return undefined;
          refuse = false;
          return { code: 255, stderr: "Connection reset by peer" };
        },
      ],
    });
    const { flowId, w } = await startAdd(h);
    await h.engine.sudoPassword(flowId, "q1", PASSWORD);
    expect(w.views().at(-1)?.failure).toMatchObject({ code: "connection-lost", step: "start" });
    await h.engine.retryAdd(flowId);
    // Install ran with it; start, after the failure, asks again.
    expect(w.views().at(-1)?.question).toMatchObject({
      id: "q2",
      kind: "sudo-password",
      step: "start",
    });
    const sudoed = h.box.scripts.filter((entry) => entry.stdin === `${PASSWORD}\n`);
    expect(sudoed).toHaveLength(2);
    await h.engine.sudoPassword(flowId, "q2", PASSWORD);
    expect(w.views().at(-1)?.status).toBe("done");
  });

  it("a question after it was given asks for it again too", async () => {
    const h = harness({
      registry: registry(hostEntry({ id: "3f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f" })),
      overrides: [
        (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
      ],
    });
    const { flowId, w } = await startAdd(h);
    await h.engine.sudoPassword(flowId, "q1", PASSWORD);
    expect(w.views().at(-1)?.question).toMatchObject({ id: "q2", kind: "identity-changed" });
    await h.engine.answerAdd(flowId, "q2", { kind: "repair" });
    expect(w.views().at(-1)?.question).toMatchObject({
      id: "q3",
      kind: "sudo-password",
      reason: "enroll",
    });
    await h.engine.sudoPassword(flowId, "q3", PASSWORD);
    expect(w.views().at(-1)?.status).toBe("done");
  });
});

describe("the link cap and the link log (notes 1, 5)", () => {
  it("opens at most 24 links for 40 projects; the rest read too many, plainly", () => {
    const ids = workspaces(40);
    const h = harness({ registry: registry(hostEntry({ workspaceIds: ids })) });
    expect(REMOTE_HOST_LINK_CAP).toBe(24);
    expect(h.links.made).toHaveLength(24);
    expect(h.links.made.map((link) => link.workspaceId)).toEqual(ids.slice(0, 24));
    const projects = h.engine.snapshot().projects;
    expect(projects[ids[23]!]?.link).toEqual({ status: "connecting", attempt: 0 });
    for (const id of ids.slice(24)) {
      expect(projects[id]?.link).toEqual({
        status: "refused",
        error: {
          code: "TOO_MANY_REQUESTS",
          reason: "too-many-projects",
          message: "Too many projects open on box",
        },
        closeCode: null,
      });
    }
    // The host speaks from its linked projects only.
    for (const link of h.links.made) link.set(ready());
    expect(h.engine.hostLink(HOST_ID).state).toEqual({ status: "ready" });
    // One more project: remembered, and over the cap, no link.
    const extra = "30000000-0000-4000-8000-000000000000";
    h.engine.openWorkspace(HOST_ID, extra);
    expect(h.links.made).toHaveLength(24);
    expect(h.engine.snapshot().projects[extra]?.link.status).toBe("refused");
    // The tunnel back: still 24.
    const tunnel = h.tunnels.made[0]!;
    tunnel.set({ status: "up", url: "ws://127.0.0.1:60001", localPort: 60_001 });
    expect(h.links.made.filter((link) => !link.closed)).toHaveLength(24);
  });

  it("logs every link's handshakes, refusals and reconnects through the app's log", () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    const log = h.links.made[0]!.options.log!;
    const base = { traceId: "t1" } as const;
    const events: HostLinkLogEvent[] = [
      { kind: "state", from: "connecting", to: "refused", reason: "credential-invalid", ...base },
      { kind: "state", from: "connecting", to: "ready", hostId: HOST_ID, epoch: 1, ...base },
      { kind: "wake", cause: "power-resume", status: "ready", ...base },
    ];
    for (const event of events) log(event);
    expect(
      h.log.lines.slice(-3).map((line) => [line.level, line.msg, line.fields["workspaceId"]]),
    ).toEqual([
      ["warn", "host link state", WS1],
      ["info", "host link state", WS1],
      ["debug", "host link wake", WS1],
    ]);
    expect(h.log.lines.at(-3)?.fields).toMatchObject({
      hostId: HOST_ID,
      reason: "credential-invalid",
    });
  });
});

describe("waking on resume and on the network (note 2)", () => {
  it("wakes every tunnel and link at once, and opens a never-up tunnel now", async () => {
    vi.useFakeTimers();
    const h = harness({
      wake: true,
      tunnelMode: "fail",
      registry: registry(
        hostEntry({ workspaceIds: [WS1] }),
        hostEntry({ id: "3f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f", name: "two" }),
      ),
    });
    await vi.advanceTimersByTimeAsync(0);
    const [one, two] = h.tunnels.made;
    expect(one!.starts).toBe(1);
    // One comes up, then the Mac sleeps; the other has never been up.
    h.tunnels.control.mode = "up";
    one!.set({ status: "up", url: one!.url, localPort: 1 });
    const link = h.links.made[0] as FakeLink;
    h.wake.fire("power-resume");
    expect(one!.wakes).toBe(1);
    expect(link.wakes.at(-1)).toBe("power-resume");
    expect(two!.starts).toBe(2);
    expect(two!.wakes).toBe(0);
    h.wake.fire("network-online");
    expect(one!.wakes).toBe(2);
    expect(link.wakes.at(-1)).toBe("network-online");
    await h.engine.close();
    expect(h.wake.listeners.size).toBe(0);
  });

  it("ignores a wake that lands after quit", async () => {
    const h = harness({ wake: true, registry: registry(hostEntry()) });
    const fire = [...h.wake.listeners][0]!;
    await h.engine.close();
    fire("power-resume");
    expect(h.tunnels.made[0]!.wakes).toBe(0);
  });
});

describe("the B5 probe, ported: a registry write that fails is never success", () => {
  it("Add reports a retryable failure; Forget refuses and keeps the key", async () => {
    const h = harness();
    h.store.state.saveFails = true;
    const { view } = await startAdd(h);
    expect(view.status).toBe("failed");
    expect(h.store.state.file).toBeNull();
    await h.engine.close();
    const f = harness({ registry: registry(hostEntry()) });
    f.keys.keys.set(HOST_KEY, "key");
    f.store.state.saveFails = true;
    await expect(f.engine.forget(HOST_ID)).rejects.toMatchObject({ code: "registry-unwritable" });
    expect(f.engine.snapshot().hosts).toHaveLength(1);
    expect((f.store.state.file as RegistryFile).hosts).toHaveLength(1);
    expect(f.keys.keys.has(HOST_KEY)).toBe(true);
    await f.engine.close();
  });

  it("an unknown registry version survives an add attempt untouched", async () => {
    const file = { v: 2, hosts: [hostEntry()], futureData: "preserve" };
    const h = harness({ registry: file });
    await expect(h.engine.startAdd({ target: "deploy@box" })).rejects.toMatchObject({
      code: "registry-read-only",
    });
    expect(h.store.state.file).toBe(file);
    expect(h.store.saves).toEqual([]);
  });
});
