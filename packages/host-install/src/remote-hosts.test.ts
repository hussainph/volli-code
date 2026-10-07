import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { base64UrlToBytes, parseDeviceCredential } from "@volli/host-protocol";
import type { HostLinkState } from "@volli/host-protocol/client-link";
import {
  REMOTE_HOST_DEVICE_TEXT_MAX,
  REMOTE_HOST_DEVICES_MAX,
  REMOTE_HOST_NAME_MAX,
  REMOTE_HOST_SIGN_IN_UNAVAILABLE,
  REMOTE_HOST_UPDATE_UNAVAILABLE,
  type RemoteHostsSnapshot,
} from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PROBE_SCRIPT } from "./probe";
import { devicesListScript, RemoteHostsError, RemoteHostsUnavailableError } from "./remote-hosts";
import type { RegistryFile } from "./remote-hosts-registry";
import type { SshExecResult } from "./ssh";
import {
  CURRENT,
  DEVICE_ID,
  flush,
  harness,
  HOST_ID,
  HOST_KEY,
  hostEntry,
  INSTALLED,
  json,
  LISTEN,
  NOW,
  OFFER,
  OTHER_ID,
  PASSWORD,
  probeOutput,
  ready,
  registry,
  questionOf,
  startAdd,
  watch,
  WS1,
  WS2,
  type FakeLink,
  type Handler,
} from "./testing/remote-hosts-harness";

afterEach(() => {
  vi.useRealTimers();
});

describe("adding a host end to end", () => {
  it("runs every step in order, keeps the host and its key, and brings its tunnel up", async () => {
    const h = harness();
    h.engine.subscribe((snapshot) => h.snapshots.push(snapshot));
    const { flowId, w, view } = await startAdd(h);

    expect(view).toEqual({
      flowId,
      target: "deploy@box",
      name: "deploy@box",
      status: "done",
      steps: [
        { id: "connect", status: "done" },
        { id: "probe", status: "done" },
        { id: "deliver", status: "done" },
        { id: "install", status: "done" },
        { id: "start", status: "done" },
        { id: "enroll", status: "done" },
        { id: "link", status: "done" },
      ],
      question: null,
      failure: null,
      hostId: HOST_ID,
      // A Linux host starts at boot: nothing to say.
      startup: null,
    });
    // What each step found: the checklist's completed rows, read beside the view.
    expect(h.engine.addFacts(flowId)).toEqual({
      user: "deploy",
      os: "linux",
      system: "Ubuntu 24.04.1 LTS",
      arch: "x86-64",
      memoryBytes: 8_167_236 * 1024,
      version: "1.1.0",
      keepsRunning: true,
      alreadyPaired: false,
    });
    // Each step shows running, in order, each after the ones before it are done.
    const running = w
      .views()
      .flatMap((v) => v.steps.filter((step) => step.status === "running").map((step) => step.id));
    expect([...new Set(running)]).toEqual([
      "connect",
      "probe",
      "deliver",
      "install",
      "start",
      "enroll",
      "link",
    ]);
    for (const v of w.views()) {
      const at = v.steps.findIndex((step) => step.status === "running");
      if (at > 0) expect(v.steps.slice(0, at).every((step) => step.status === "done")).toBe(true);
    }
    // The log replayed, then streamed: every step's start, and the end.
    const messages = w.lines().map((line) => line.message);
    expect(messages.filter((message) => message === "step started")).toHaveLength(7);
    expect(messages).toContain("host added");
    expect(w.lines()[0]).toMatchObject({
      level: "info",
      fields: { component: "host-install", host: "deploy@box" },
    });
    expect(w.events.find((event) => event.kind === "log")).toMatchObject({ flowId });

    // The host, in the registry and the snapshot.
    expect(h.store.saves.at(-1)).toEqual(
      registry(
        hostEntry({
          name: "deploy@box",
          addedAt: new Date(NOW).toISOString(),
          version: "1.1.0",
        }),
      ),
    );
    const snapshot = h.engine.snapshot();
    expect(snapshot).toEqual({
      v: 1,
      hosts: [
        {
          id: HOST_ID,
          name: "deploy@box",
          target: "deploy@box",
          transport: "ssh-tunnel",
          os: "linux",
          mode: "system",
          agentsShareAccount: false,
          version: "1.1.0",
          availableUpdate: null,
          hostIsNewer: false,
          deviceId: DEVICE_ID,
          addedAt: new Date(NOW).toISOString(),
          liveSessions: null,
          reachability: { state: { status: "ready" }, everReady: true, droppedAt: null },
          lastWelcome: null,
          signInExpiry: null,
          lastSshFailure: null,
          system: "Ubuntu 24.04.1 LTS",
          arch: "x86-64",
          hostKeys: [],
        },
      ],
      projects: {},
      readOnly: null,
    });
    expect(h.snapshots.at(-1)).toBe(snapshot);

    // The device key: one per flow, now under the host and device, and enrolled by its public half.
    expect([...h.keys.keys.keys()]).toEqual([HOST_KEY]);
    expect(h.keys.calls).toEqual(["put flow:flow-1", `put ${HOST_KEY}`, "remove flow:flow-1"]);
    const pem = h.keys.keys.get(HOST_KEY)!;
    const enroll = h.box.ran().find((script) => script.includes(" enroll --"))!;
    const publicKey = /--public-key '([^']+)'/u.exec(enroll)![1]!;
    expect(
      createPublicKey(pem)
        .export({ type: "spki", format: "der" })
        .equals(Buffer.from(base64UrlToBytes(publicKey)!)),
    ).toBe(true);
    expect(enroll).toContain("--name 'Alice'\\''s Mac'");

    // Never the key anywhere a person or a log could see it.
    const body = pem.split("\n")[1]!;
    const seen = JSON.stringify([w.events, h.snapshots, h.store.saves, h.log.lines, h.box.scripts]);
    expect(seen).not.toContain("PRIVATE KEY");
    expect(seen).not.toContain(body);

    // The flow's SSH is closed; its tunnel is the host's now.
    expect(h.box.transports).toEqual([
      { target: { destination: "deploy@box", port: null, label: "box" }, closed: true },
    ]);
    expect(h.tunnels.made).toHaveLength(1);
    const [tunnel] = h.tunnels.made;
    expect(tunnel!.closed).toBe(false);
    expect(tunnel!.options.target.destination).toBe("deploy@box");
    await expect(tunnel!.options.resolveRemote()).resolves.toEqual(LISTEN);
  });

  it("uses the name given, and keeps logging the host's tunnel to the app log only", async () => {
    const h = harness();
    const { flowId, w } = await startAdd(h, { target: " deploy@box ", name: " Hetzner " });
    expect(w.views().at(-1)).toMatchObject({ name: "Hetzner", target: "deploy@box" });
    expect(h.engine.snapshot().hosts[0]).toMatchObject({ name: "Hetzner" });
    const before = w.events.length;
    h.tunnels.made[0]!.options.logger.warn("tunnel dropped", { code: 255 });
    expect(w.events).toHaveLength(before);
    expect(h.log.lines.at(-1)).toMatchObject({
      msg: "tunnel dropped",
      fields: { flowId, host: "Hetzner", component: "host-install", code: 255 },
    });
    // A late subscriber gets one replay: the view, and the log so far.
    const late = watch(h.engine, flowId);
    expect(late.events).toEqual([
      { kind: "replay", view: w.views().at(-1), log: w.lines(), omitted: 0 },
    ]);
    late.stop();
    w.stop();
  });

  it("adds a Mac as a user host, its agents sharing the person's account", async () => {
    const h = harness({
      supportedTargets: ["darwin-arm64"],
      overrides: [
        (script) =>
          script === PROBE_SCRIPT
            ? {
                stdout: probeOutput({
                  kernel: "Darwin",
                  arch: "arm64",
                  systemd: null,
                  user_manager: null,
                  glibc: null,
                  sudo: null,
                  groups: "staff",
                  launchd: "yes",
                }),
              }
            : undefined,
      ],
    });
    const { view } = await startAdd(h);
    expect(view.status).toBe("done");
    // The checklist says when it comes up: at login, not at boot.
    expect(view.startup).toBe("Starts when you log in to deploy@box");
    expect(h.engine.snapshot().hosts[0]).toMatchObject({
      os: "macos",
      mode: "user",
      agentsShareAccount: true,
    });
  });
});

describe("questions", () => {
  it("asks about an unknown host key, then carries on once it is accepted", async () => {
    const h = harness();
    h.box.trusted = false;
    const { flowId, view } = await startAdd(h);
    expect(view).toMatchObject({
      status: "question",
      question: { kind: "host-key", step: "connect", offer: OFFER },
      failure: null,
    });
    expect(view.steps[0]).toEqual({ id: "connect", status: "running" });
    await h.engine.answerAdd(flowId, questionOf(h.engine, flowId), { kind: "accept-host-key" });
    expect(h.accepted).toEqual([OFFER]);
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
    // The key the person compared and trusted is kept with the host.
    expect(h.engine.snapshot().hosts[0]?.hostKeys).toEqual(["SHA256:box"]);
  });

  // Review B1 (VC-710): a host's words may echo the password with no label a
  // pattern could find; only the exact value, scrubbed, keeps it in.
  it("never lets the operator step's stderr carry the sudo password out", async () => {
    const echoed = "Zq8-unlabelled-7Kw";
    const h = harness({
      overrides: [
        (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
        (_script, options) =>
          options.label === "install: operator"
            ? { code: 1, stderr: `remote sudo diagnostic: ${echoed}\n` }
            : undefined,
      ],
    });
    const { flowId, w } = await startAdd(h);
    await h.engine.sudoPassword(flowId, questionOf(h.engine, flowId), echoed);
    expect(w.views().at(-1)?.status).toBe("done");
    const replay: unknown[] = [];
    h.engine.subscribeAdd(flowId, (event) => void replay.push(event))();
    expect(
      w.lines().some((line) => line.message.includes("could not make the login an operator")),
    ).toBe(true);
    const seen = JSON.stringify([h.log.lines, w.events, replay, w.views(), h.snapshots]);
    expect(seen).toContain("remote sudo diagnostic: [redacted]");
    expect(seen).not.toContain(echoed);
    const carried = h.box.scripts.filter(
      (entry) => entry.script.includes(echoed) || entry.stdin?.includes(echoed),
    );
    expect(carried.every((entry) => !entry.script.includes(echoed))).toBe(true);
    expect(carried.map((entry) => entry.stdin)).toContain(`${echoed}\n`);
  });

  it("scrubs the held password from a step's failure detail too", async () => {
    const echoed = "Pq3-detail-9Rt";
    const h = harness({
      overrides: [
        (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
        (script) =>
          script.includes(" start --") ? { code: 1, stderr: `hostd said ${echoed}\n` } : undefined,
      ],
    });
    const { flowId, w } = await startAdd(h);
    await h.engine.sudoPassword(flowId, questionOf(h.engine, flowId), echoed);
    expect(w.views().at(-1)?.status).toBe("failed");
    expect(JSON.stringify([h.log.lines, w.events, w.views()])).not.toContain(echoed);
  });

  it("takes a sudo password into the flow's memory only, and sends it only to sudo", async () => {
    const h = harness({
      overrides: [
        (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
      ],
    });
    h.engine.subscribe((snapshot) => h.snapshots.push(snapshot));
    const { flowId, w, view } = await startAdd(h);
    expect(view.question).toMatchObject({ kind: "sudo-password", step: "install", retry: false });
    // An answer the question does not offer is refused, and the question stands.
    await expect(h.engine.answerAdd(flowId, view.question!.id, { kind: "update" })).rejects.toThrow(
      "does not take that answer to sudo-password",
    );
    expect(w.views().at(-1)?.question).toMatchObject({ kind: "sudo-password" });
    await h.engine.sudoPassword(flowId, questionOf(h.engine, flowId), PASSWORD);
    expect(w.views().at(-1)?.status).toBe("done");
    const sudoed = h.box.scripts.filter((entry) => entry.script.startsWith("sudo -S"));
    // Install, the operator token beside it (VC-710), start, enroll.
    expect(sudoed.map((entry) => entry.stdin)).toEqual([
      `${PASSWORD}\n`,
      `${PASSWORD}\n`,
      `${PASSWORD}\n`,
      `${PASSWORD}\n`,
    ]);
    const elsewhere = JSON.stringify([
      h.box.ran(),
      w.events,
      h.snapshots,
      h.store.saves,
      h.log.lines,
      [...h.keys.keys.entries()],
    ]);
    expect(elsewhere).not.toContain(PASSWORD);
  });

  it("refuses a password when the flow does not ask for one, and an answer when it asks nothing", async () => {
    const h = harness();
    h.box.trusted = false;
    const { flowId } = await startAdd(h);
    await expect(
      h.engine.sudoPassword(flowId, questionOf(h.engine, flowId), PASSWORD),
    ).rejects.toMatchObject({
      code: "flow-not-waiting",
    });
    await h.engine.answerAdd(flowId, questionOf(h.engine, flowId), { kind: "accept-host-key" });
    await expect(
      h.engine.answerAdd(flowId, questionOf(h.engine, flowId), { kind: "adopt" }),
    ).rejects.toBeInstanceOf(RemoteHostsError);
    await expect(
      h.engine.sudoPassword(flowId, questionOf(h.engine, flowId), PASSWORD),
    ).rejects.toMatchObject({
      code: "flow-not-waiting",
    });
    await expect(h.engine.retryAdd(flowId)).rejects.toMatchObject({ code: "flow-not-waiting" });
  });

  it("serializes calls on one flow, and refuses an answer to a question it no longer asks", async () => {
    const h = harness({
      overrides: [
        (script) =>
          script === PROBE_SCRIPT
            ? {
                stdout: probeOutput(
                  {},
                  ["hostd=system managed 1.0.0", `hostd_path=${CURRENT}`, "status="].join("\n"),
                ),
              }
            : undefined,
      ],
    });
    h.box.trusted = false;
    const { flowId, w, view } = await startAdd(h);
    expect(view.question).toMatchObject({ id: "q1", kind: "host-key" });
    const order: string[] = [];
    const first = h.engine
      .answerAdd(flowId, "q1", { kind: "accept-host-key" })
      .then(() => order.push("first"));
    // The same answer again, as a double click sends it: by its turn, q1 is answered.
    const again = h.engine.answerAdd(flowId, "q1", { kind: "accept-host-key" }).then(
      () => order.push("again"),
      (error: RemoteHostsError) => order.push(`again refused: ${error.code}`),
    );
    await Promise.all([first, again]);
    expect(order).toEqual(["first", "again refused: flow-not-waiting"]);
    expect(w.views().at(-1)?.question).toMatchObject({ id: "q2", kind: "existing-hostd" });
    // A stale id is refused, and so is an answer the question does not offer.
    await expect(h.engine.answerAdd(flowId, "q1", { kind: "update" })).rejects.toThrow(
      "asks q2 now, not q1",
    );
    await expect(h.engine.answerAdd(flowId, "q2", { kind: "open" })).rejects.toThrow(
      "does not take that answer to existing-hostd",
    );
    await h.engine.answerAdd(flowId, "q2", { kind: "update" });
    const questions = w.views().flatMap((v) => (v.question === null ? [] : [v.question.kind]));
    expect([...new Set(questions)]).toEqual(["host-key", "existing-hostd"]);
    expect(w.views().at(-1)?.status).toBe("done");
  });
});

describe("failures", () => {
  it("shows the line, the recovery and the detail, and retries from the failed step", async () => {
    let refuse = true;
    const h = harness({
      overrides: [
        (script) => {
          if (!script.includes(" install --") || !refuse) return undefined;
          refuse = false;
          return json({
            v: 1,
            ok: false,
            code: "command-failed",
            message: "systemctl failed to install the unit",
            detail: ["journal: unit failed"],
          });
        },
      ],
    });
    const { flowId, w, view } = await startAdd(h);
    expect(view).toMatchObject({
      status: "failed",
      question: null,
      failure: {
        code: "hostd-refused",
        step: "install",
        line: "systemctl failed to install the unit",
        recovery: { action: "retry", label: "Try again", from: "install" },
        detail: "journal: unit failed",
      },
    });
    expect(view.steps.map((step) => step.status)).toEqual([
      "done",
      "done",
      "done",
      "failed",
      "pending",
      "pending",
      "pending",
    ]);
    await h.engine.retryAdd(flowId);
    expect(w.views().at(-1)?.status).toBe("done");
    // The retry ran install again, not the steps before it.
    expect(h.box.ran().filter((script) => script === PROBE_SCRIPT)).toHaveLength(1);
  });

  it("retries from an earlier step when asked", async () => {
    let down = true;
    const h = harness({
      overrides: [
        (script) =>
          script.includes(" start --") && down
            ? { code: 255, stderr: "Connection reset by peer" }
            : undefined,
      ],
    });
    const { flowId, view } = await startAdd(h);
    expect(view.failure).toMatchObject({ code: "connection-lost", step: "start" });
    down = false;
    await h.engine.retryAdd(flowId, "probe");
    expect(h.box.ran().filter((script) => script === PROBE_SCRIPT)).toHaveLength(2);
    expect(h.engine.snapshot().hosts).toHaveLength(1);
  });

  it("fails the link step when the tunnel will not open, closing it", async () => {
    const h = harness({ tunnelMode: "fail" });
    const { flowId, view } = await startAdd(h);
    expect(view.failure).toMatchObject({
      code: "tunnel-failed",
      step: "link",
      detail: "ssh: Connection refused",
    });
    expect(h.tunnels.made[0]!.closed).toBe(true);
    h.tunnels.control.mode = "up";
    await h.engine.retryAdd(flowId);
    expect(h.engine.hostLink(h.engine.snapshot().hosts[0]!.id).state).toEqual({ status: "ready" });
  });

  it("fails at the end when the host's key cannot be stored, and retries the link", async () => {
    const h = harness();
    let refuse = true;
    h.keys.hooks.put = (name) => {
      if (name.startsWith("host:") && refuse) {
        refuse = false;
        // Not an Error: whatever a key store rejects with is worded.
        return Promise.reject({ toString: () => "keychain locked" });
      }
      return undefined;
    };
    const { flowId, w, view } = await startAdd(h);
    expect(view).toMatchObject({
      status: "failed",
      failure: {
        code: "save-failed",
        step: "link",
        line: "Couldn’t save deploy@box on this Mac",
        recovery: { action: "retry", from: "link" },
        detail: "keychain locked",
      },
    });
    expect(view.steps.at(-1)).toEqual({ id: "link", status: "failed" });
    expect(h.engine.snapshot().hosts).toEqual([]);
    // The flow's key is kept for the retry.
    expect(h.keys.keys.has(`flow:${flowId}`)).toBe(true);
    await h.engine.retryAdd(flowId);
    expect(w.views().at(-1)?.status).toBe("done");
    // The first link's tunnel was replaced by the retry's.
    expect(h.tunnels.made.map((tunnel) => tunnel.closed)).toEqual([true, false]);
    expect([...h.keys.keys.keys()]).toEqual([HOST_KEY]);
  });

  it("fails at the end when the flow's key went missing", async () => {
    const h = harness();
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    h.keys.keys.delete(`flow:${flowId}`);
    const view = await watch(h.engine, flowId).until();
    expect(view.failure).toMatchObject({
      code: "unexpected-state",
      detail: "This Mac's new device key went missing.",
    });
    expect(h.log.lines.some((line) => line.msg === "adding the host failed at the end")).toBe(true);
  });

  it("refuses a target that is not one, before anything runs", async () => {
    const h = harness();
    await expect(h.engine.startAdd({ target: "-oProxyCommand=evil" })).rejects.toMatchObject({
      code: "bad-target",
    });
    expect(h.keys.calls).toEqual([]);
  });
});

describe("cancelling an add", () => {
  it("ends the step in flight at once, discards it, and removes the unused key", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      overrides: [
        async (script) => {
          if (!script.includes(" install --")) return undefined;
          await held;
          return json(INSTALLED("system"));
        },
      ],
    });
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    const w = watch(h.engine, flowId);
    await w.until((view) => view.steps[3]?.status === "running");
    const cancelled = h.engine.cancelAdd(flowId);
    expect(w.views().at(-1)).toMatchObject({ status: "cancelled", question: null, failure: null });
    // Its SSH is closed at once, which ends the command the step waits on.
    expect(h.box.transports[0]!.closed).toBe(true);
    await cancelled;
    expect([...h.keys.keys.keys()]).toEqual([]);
    release();
    await flush();
    expect(h.box.ran().some((script) => script.includes(" start --"))).toBe(false);
    expect(h.keys.calls).toEqual(["put flow:flow-1", "remove flow:flow-1"]);
    expect(h.store.saves).toEqual([]);
    expect(w.views().at(-1)?.status).toBe("cancelled");
    // Cancelled is final.
    await h.engine.cancelAdd(flowId);
    await expect(h.engine.answerAdd(flowId, "q1", { kind: "open" })).rejects.toMatchObject({
      code: "flow-not-waiting",
    });
  });

  it("closes the link step's tunnel when cancelled while it opens", async () => {
    const h = harness({ tunnelMode: "hold" });
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    const w = watch(h.engine, flowId);
    await w.until((view) => view.steps[6]?.status === "running");
    await flush();
    const tunnel = h.tunnels.made[0]!;
    const cancelled = h.engine.cancelAdd(flowId);
    // At once: the link step waiting on it finishes now.
    expect(tunnel.closed).toBe(true);
    await cancelled;
    expect(h.engine.snapshot().hosts).toEqual([]);
    expect(h.keys.keys.size).toBe(0);
  });

  it("wins while the host's key is being written: nothing is kept", async () => {
    const h = harness();
    let release!: () => void;
    h.keys.hooks.put = (name) =>
      name.startsWith("host:")
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    const w = watch(h.engine, flowId);
    while (!h.keys.calls.includes(`put ${HOST_KEY}`)) await flush();
    await h.engine.cancelAdd(flowId);
    release();
    await flush();
    await flush();
    expect(w.views().at(-1)?.status).toBe("cancelled");
    expect(h.engine.snapshot().hosts).toEqual([]);
    expect(h.store.saves).toEqual([]);
    expect(h.keys.keys.size).toBe(0);
    expect(h.tunnels.made.every((tunnel) => tunnel.closed)).toBe(true);
  });

  it("wins while the flow's key is read: nothing is written", async () => {
    const h = harness();
    const held: { release?: () => void } = {};
    h.keys.hooks.get = (name) =>
      name.startsWith("flow:")
        ? new Promise<void>((resolve) => {
            held.release = resolve;
          })
        : undefined;
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    while (held.release === undefined) await flush();
    await h.engine.cancelAdd(flowId);
    held.release();
    await flush();
    expect(h.keys.calls).toEqual(["put flow:flow-1", "remove flow:flow-1"]);
    expect(h.engine.snapshot().hosts).toEqual([]);
  });

  it("is too late once the host is saved: the add is done", async () => {
    const h = harness();
    const { flowId, w } = await startAdd(h);
    await h.engine.cancelAdd(flowId);
    expect(w.views().at(-1)?.status).toBe("done");
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
  });

  it("caps a flow's log, and replays only its newest lines, in one bounded event", async () => {
    const h = harness({ tunnelMode: "hold" });
    const { flowId } = await h.engine.startAdd({ target: "deploy@box" });
    await watch(h.engine, flowId).until((view) => view.steps[6]?.status === "running");
    await flush();
    const tunnelLog = h.tunnels.made[0]!.options.logger;
    const pad = "x".repeat(300);
    for (let index = 0; index < 600; index += 1) tunnelLog.debug(`line ${index} ${pad}`);
    const replay = watch(h.engine, flowId).events;
    expect(replay).toHaveLength(1);
    const [event] = replay;
    if (event?.kind !== "replay") throw new Error("no replay");
    expect(event.log.at(-1)).toMatchObject({ level: "debug", message: `line 599 ${pad}` });
    expect(Buffer.byteLength(JSON.stringify(event.log))).toBeLessThanOrEqual(64 * 1024 + 2);
    // Every line it kept or dropped is accounted for: the steps' lines, then 600.
    const total = event.omitted + event.log.length;
    expect(total).toBeGreaterThan(600);
    expect(event.log.length).toBeLessThan(500);
    await h.engine.cancelAdd(flowId);
  });
});

describe("re-adding a host", () => {
  it("pins the host it knows, keeps its Workspaces and replaces its tunnel and key", async () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    const old = h.tunnels.made[0]!;
    h.keys.keys.set(HOST_KEY, "old key");
    // The re-add enrolls this Mac afresh: a new device, a new key beside the old one.
    const NEW_DEVICE = "5f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
    h.box.enrollDeviceId = NEW_DEVICE;
    const { view } = await startAdd(h, { target: "deploy@box" });
    expect(view.status).toBe("done");
    expect(old.closed).toBe(true);
    const saved = h.store.saves.at(-1)!.hosts;
    expect(saved).toEqual([
      hostEntry({
        name: "deploy@box",
        deviceId: NEW_DEVICE,
        workspaceIds: [WS1],
        addedAt: "2025-12-01T00:00:00.000Z",
      }),
    ]);
    // The old device's key goes only once the registry names the new one.
    expect([...h.keys.keys.keys()]).toEqual([`host:${HOST_ID}:${NEW_DEVICE}`]);
    expect(h.keys.keys.get(`host:${HOST_ID}:${NEW_DEVICE}`)).toMatch(/PRIVATE KEY/u);
    expect(h.keys.calls.slice(-3)).toEqual([
      `put host:${HOST_ID}:${NEW_DEVICE}`,
      "remove flow:flow-1",
      `remove ${HOST_KEY}`,
    ]);
    // Its Workspace's link rides the new tunnel.
    expect(h.links.made.at(-1)?.options.url).toBe(h.tunnels.made[1]!.url);
  });

  it("asks when the host's identity changed, and replaces the old host once repaired", async () => {
    const h = harness({ registry: registry(hostEntry({ id: OTHER_ID, workspaceIds: [WS1] })) });
    h.keys.keys.set(`host:${OTHER_ID}:${DEVICE_ID}`, "old key");
    const { flowId, view } = await startAdd(h);
    expect(view.question).toEqual({
      id: "q1",
      kind: "identity-changed",
      step: "enroll",
      pinned: OTHER_ID,
      hostId: HOST_ID,
    });
    await h.engine.answerAdd(flowId, questionOf(h.engine, flowId), { kind: "repair" });
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
    expect(h.engine.snapshot().projects).toEqual({});
    expect([...h.keys.keys.keys()]).toEqual([HOST_KEY]);
    expect(h.tunnels.made[0]!.closed).toBe(true);
  });

  it("repairs a host forgotten meanwhile without touching anything else", async () => {
    const h = harness({ registry: registry(hostEntry({ id: OTHER_ID })) });
    const { flowId } = await startAdd(h, { target: "deploy@box" });
    await h.engine.forget(OTHER_ID);
    const removes = h.keys.calls.filter((call) => call.startsWith("remove host:"));
    await h.engine.answerAdd(flowId, questionOf(h.engine, flowId), { kind: "repair" });
    expect(h.keys.calls.filter((call) => call.startsWith("remove host:"))).toEqual(removes);
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
  });
});

describe("a host's lifecycle", () => {
  it("brings every registered host up at startup", async () => {
    const h = harness({
      tunnelMode: "hold",
      registry: registry(
        hostEntry({ workspaceIds: [WS1] }),
        hostEntry({ id: OTHER_ID, name: "two" }),
      ),
    });
    expect(h.store.state.loads).toBe(1);
    expect(h.tunnels.made).toHaveLength(2);
    expect(h.tunnels.made.map((tunnel) => tunnel.starts)).toEqual([1, 1]);
    await expect(h.tunnels.made[0]!.options.resolveRemote()).resolves.toEqual(LISTEN);
    expect(h.tunnels.made[1]!.options.target).toEqual({
      destination: "deploy@box",
      port: null,
      label: "box",
    });
    const snapshot = h.engine.snapshot();
    expect(snapshot.hosts.map((host) => h.engine.hostLink(host.id))).toEqual([
      { state: { status: "connecting", attempt: 0 }, everReady: false, droppedAt: null },
      { state: { status: "connecting", attempt: 0 }, everReady: false, droppedAt: null },
    ]);
    // A Workspace with no link yet reads as its host's tunnel.
    expect(snapshot.projects).toEqual({
      [WS1]: { hostId: HOST_ID, link: { status: "connecting", attempt: 0 } },
    });
    expect(h.links.made).toHaveLength(0);
  });

  it("derives health from status over the tunnel while no Workspace is open", async () => {
    const h = harness({ tunnelMode: "hold", registry: registry(hostEntry()) });
    const tunnel = h.tunnels.made[0]!;
    const link = () => h.engine.hostLink(h.engine.snapshot().hosts[0]!.id);
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    expect(link().state.status).toBe("connecting");
    await flush();
    expect(link()).toEqual({ state: { status: "ready" }, everReady: true, droppedAt: null });
    h.clock.now = NOW + 10_000;
    tunnel.set({ status: "down", error: "ssh exited 255", retryInMs: 4_000 });
    expect(link()).toEqual({
      state: {
        status: "unreachable",
        attempt: 1,
        error: {
          code: "SERVICE_UNAVAILABLE",
          reason: "host-unreachable",
          message: "ssh exited 255",
        },
        closeCode: null,
        retryAt: NOW + 14_000,
      },
      everReady: true,
      droppedAt: NOW + 10_000,
    });
    tunnel.set({ status: "starting" });
    expect(link().state).toEqual({ status: "connecting", attempt: 1 });
    tunnel.set({ status: "closed" });
    expect(link().state).toEqual({ status: "closed" });
  });

  it("retries a tunnel's first open with backoff until it is closed", async () => {
    vi.useFakeTimers();
    const h = harness({ tunnelMode: "fail", registry: registry(hostEntry()) });
    const tunnel = h.tunnels.made[0]!;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.hostLink(h.engine.snapshot().hosts[0]!.id).state).toMatchObject({
      status: "unreachable",
      attempt: 1,
      retryAt: NOW + 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tunnel.starts).toBe(2);
    expect(h.engine.hostLink(h.engine.snapshot().hosts[0]!.id).state).toMatchObject({
      attempt: 2,
      retryAt: NOW + 2_000,
    });
    await h.engine.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tunnel.starts).toBe(2);
  });

  it("drops a first open's failure that lands after the host stopped", async () => {
    const h = harness({ tunnelMode: "fail", registry: registry(hostEntry()) });
    await h.engine.close();
    await flush();
    expect(h.tunnels.made[0]!.starts).toBe(1);
  });

  it("opens one link per Workspace over the tunnel, and speaks for the host from them", () => {
    const h = harness({
      tunnelMode: "hold",
      linkFeatures: ["queue"],
      registry: registry(hostEntry({ version: "1.0.0", workspaceIds: [WS1, WS2] })),
    });
    const tunnel = h.tunnels.made[0]!;
    const host = () => h.engine.snapshot().hosts[0]!;
    expect(host()).toMatchObject({ availableUpdate: "1.1.0", hostIsNewer: false });
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    expect(h.links.made.map((link) => [link.options.url, link.workspaceId])).toEqual([
      [tunnel.url, WS1],
      [tunnel.url, WS2],
    ]);
    expect(h.links.made[0]!.options).toMatchObject({
      client: { kind: "desktop", version: "1.1.0" },
      features: ["queue"],
    });
    expect(h.engine.hostLink(host().id).state).toEqual({ status: "connecting", attempt: 0 });
    const [one, two] = h.links.made as [FakeLink, FakeLink];

    one.set({
      status: "refused",
      error: { code: "UNAUTHORIZED", reason: "credential-invalid", message: "Unknown device." },
      closeCode: 4401,
    });
    expect(h.engine.hostLink(host().id).state).toMatchObject({
      status: "refused",
      closeCode: 4401,
    });
    two.set({
      status: "fenced",
      error: { code: "CONFLICT", reason: "workspace-split-brain", message: "Two hosts." },
    });
    expect(h.engine.hostLink(host().id).state.status).toBe("refused");
    one.set({ status: "connecting", attempt: 1 });
    expect(h.engine.hostLink(host().id).state.status).toBe("fenced");

    // Each Workspace keeps its own link: one refused, one fenced.
    expect(h.engine.snapshot().projects).toMatchObject({
      [WS1]: { link: { status: "connecting", attempt: 1 } },
      [WS2]: { link: { status: "fenced" } },
    });

    h.clock.now = NOW + 1_000;
    two.set(ready("1.2.0"));
    // A ready project names what its own link's welcome granted (VC-712).
    expect(h.engine.snapshot().projects).toEqual({
      [WS1]: { hostId: HOST_ID, link: { status: "connecting", attempt: 1 } },
      [WS2]: { hostId: HOST_ID, link: { status: "ready" }, granted: [] },
    });
    expect(host()).toMatchObject({ version: "1.2.0", availableUpdate: null, hostIsNewer: true });
    expect(h.engine.hostLink(HOST_ID)).toEqual({
      state: { status: "ready" },
      everReady: true,
      droppedAt: null,
    });
    expect(h.store.saves.at(-1)?.hosts[0]?.version).toBe("1.2.0");
    const saves = h.store.saves.length;
    one.set(ready("1.2.0"));
    expect(h.store.saves).toHaveLength(saves);

    h.clock.now = NOW + 5_000;
    const unreachable: HostLinkState = {
      status: "unreachable",
      attempt: 2,
      error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "Gone." },
      closeCode: 1006,
      retryAt: NOW + 9_000,
    };
    const granting = ready("1.2.0") as Extract<HostLinkState, { status: "ready" }>;
    one.set({
      ...granting,
      welcome: { ...granting.welcome, features: ["sign-ins", "host.logs"] },
    });
    expect(h.engine.snapshot().projects[WS1]).toEqual({
      hostId: HOST_ID,
      link: { status: "ready" },
      granted: ["sign-ins", "host.logs"],
    });
    one.set(unreachable);
    two.set(unreachable);
    // A link that is not ready grants nothing.
    expect(h.engine.snapshot().projects[WS1]!.granted).toBeUndefined();
    expect(h.engine.hostLink(host().id)).toEqual({
      state: {
        status: "unreachable",
        attempt: 2,
        error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "Gone." },
        closeCode: 1006,
        retryAt: NOW + 9_000,
      },
      everReady: true,
      droppedAt: NOW + 5_000,
    });

    // The tunnel back on the same port wakes the links; on a new one, they are opened afresh.
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    expect(one.wakes).toEqual(["network-online"]);
    tunnel.set({ status: "up", url: "ws://127.0.0.1:60000", localPort: 60_000 });
    expect(one.closed).toBe(true);
    expect(h.links.made.slice(2).map((link) => link.options.url)).toEqual([
      "ws://127.0.0.1:60000",
      "ws://127.0.0.1:60000",
    ]);
    // A closed link no longer moves the host.
    const before = h.engine.hostLink(host().id);
    one.set(ready());
    expect(h.engine.hostLink(host().id)).toBe(before);
  });

  it("mints a fresh credential per handshake, signed with the host's device key", async () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const publicSpki = pair.publicKey;
    h.keys.keys.set(HOST_KEY, privateKeyPem);
    h.clock.now = NOW + 1_500;
    const credential = h.links.made[0]!.options.credential as () => Promise<string>;
    const minted = await credential();
    const parsed = parseDeviceCredential(minted)!;
    expect(parsed.claims).toMatchObject({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      workspaceId: WS1,
      iat: Math.floor((NOW + 1_500) / 1000),
    });
    expect(parsed.claims.exp - parsed.claims.iat).toBeLessThanOrEqual(300);
    expect(parsed.claims.exp).toBeGreaterThan(parsed.claims.iat);
    expect(
      verify(
        "sha256",
        Buffer.from(parsed.signingInput, "ascii"),
        { key: publicSpki, dsaEncoding: "ieee-p1363" },
        parsed.signature,
      ),
    ).toBe(true);
    const again = parseDeviceCredential(await credential())!;
    expect(again.claims.jti).not.toBe(parsed.claims.jti);
    // Never a credential, nor the key, in the snapshot or the log.
    const seen = JSON.stringify([h.engine.snapshot(), h.log.lines, h.store.saves]);
    expect(seen).not.toContain(minted);
    expect(seen).not.toContain(privateKeyPem.split("\n")[1]!);

    h.keys.keys.delete(HOST_KEY);
    await expect(credential()).rejects.toThrow("This Mac has no device key for box.");
    await h.engine.forget(HOST_ID);
    await expect(credential()).rejects.toThrow("This host was forgotten.");
  });

  it("retries now: wakes the tunnel and reconnects every link", () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1, WS2] })) });
    h.engine.retry(HOST_ID);
    expect(h.tunnels.made[0]!.wakes).toBe(1);
    expect(h.links.made.map((link) => link.reconnects)).toEqual([1, 1]);
    expect(() => h.engine.retry(OTHER_ID)).toThrow(RemoteHostsError);
  });

  it("opens a Workspace: remembered, mapped to its host, and linked when the tunnel is up", () => {
    const h = harness({
      tunnelMode: "hold",
      registry: registry(hostEntry(), hostEntry({ id: OTHER_ID, name: "two" })),
    });
    const tunnel = h.tunnels.made[0]!;
    h.engine.openWorkspace(HOST_ID, WS1);
    expect(h.links.made).toHaveLength(0);
    expect(h.engine.snapshot().projects).toEqual({
      [WS1]: { hostId: HOST_ID, link: { status: "connecting", attempt: 0 } },
    });
    expect(h.store.saves.at(-1)?.hosts.map((host) => host.workspaceIds)).toEqual([[WS1], []]);
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    expect(h.links.made.map((link) => link.workspaceId)).toEqual([WS1]);
    h.engine.openWorkspace(HOST_ID, WS2);
    expect(h.links.made.map((link) => link.workspaceId)).toEqual([WS1, WS2]);
    const saves = h.store.saves.length;
    h.engine.openWorkspace(HOST_ID, WS2);
    expect(h.store.saves).toHaveLength(saves);
    expect(() => h.engine.openWorkspace(HOST_ID, "not-a-workspace")).toThrow(
      expect.objectContaining({ code: "bad-workspace" }),
    );
    expect(() => h.engine.openWorkspace("5f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f", WS1)).toThrow(
      expect.objectContaining({ code: "unknown-host" }),
    );
  });

  it("forgets a host: its tunnel and links closed, its entry and key gone, the box untouched", async () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    h.keys.keys.set(HOST_KEY, "key");
    const snapshots: RemoteHostsSnapshot[] = [];
    const stop = h.engine.subscribe((snapshot) => snapshots.push(snapshot));
    await h.engine.forget(HOST_ID);
    expect(h.tunnels.made[0]!.closed).toBe(true);
    expect(h.links.made[0]!.closed).toBe(true);
    expect(h.store.saves.at(-1)).toEqual(registry());
    expect(h.keys.keys.size).toBe(0);
    expect(snapshots.at(-1)).toEqual({ v: 1, hosts: [], projects: {}, readOnly: null });
    expect(h.box.scripts).toEqual([]);
    await expect(h.engine.forget(HOST_ID)).rejects.toMatchObject({ code: "unknown-host" });
    stop();
  });
});

describe("renaming a host", () => {
  it("keeps the trimmed label, saves it and publishes it; the box is untouched", () => {
    const h = harness({
      registry: registry(hostEntry(), hostEntry({ id: OTHER_ID, name: "two" })),
    });
    const snapshots: RemoteHostsSnapshot[] = [];
    h.engine.subscribe((snapshot) => snapshots.push(snapshot));
    h.engine.rename(HOST_ID, "  Hetzner box \t");
    expect(h.store.saves.at(-1)).toEqual(
      registry(hostEntry({ name: "Hetzner box" }), hostEntry({ id: OTHER_ID, name: "two" })),
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.hosts.map((host) => host.name)).toEqual(["Hetzner box", "two"]);
    expect(h.engine.snapshot()).toBe(snapshots[0]);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "remote host renamed",
        fields: { hostId: HOST_ID, component: "host-install" },
      }),
    );
    // A label on this Mac only: nothing ran on the box, the tunnel was left alone.
    expect(h.box.scripts).toEqual([]);
    expect(h.tunnels.made.every((tunnel) => !tunnel.closed)).toBe(true);
    // The longest label is allowed, and so is any printable text.
    const longest = "é".repeat(REMOTE_HOST_NAME_MAX);
    h.engine.rename(HOST_ID, longest);
    expect(h.engine.snapshot().hosts[0]!.name).toBe(longest);
  });

  it("changes nothing when the name is the same, once trimmed", () => {
    const h = harness({ registry: registry(hostEntry({ name: "box" })) });
    const snapshots: RemoteHostsSnapshot[] = [];
    h.engine.subscribe((snapshot) => snapshots.push(snapshot));
    h.engine.rename(HOST_ID, " box ");
    expect(snapshots).toEqual([]);
    expect(h.store.saves).toEqual([]);
  });

  it("refuses an empty, over-long or control-character name, changing nothing", () => {
    const h = harness({ registry: registry(hostEntry()) });
    for (const name of [
      "",
      "   ",
      "x".repeat(REMOTE_HOST_NAME_MAX + 1),
      "two\nlines",
      "bell\u0007",
      "del\u007f",
      "c1\u0085here",
    ]) {
      expect(() => h.engine.rename(HOST_ID, name), JSON.stringify(name)).toThrow(
        expect.objectContaining({ name: "RemoteHostsError", code: "bad-name" }),
      );
    }
    expect(h.store.saves).toEqual([]);
    expect(h.engine.snapshot().hosts[0]!.name).toBe("box");
  });

  it("names an unknown host", () => {
    const h = harness({ registry: registry(hostEntry()) });
    expect(() => h.engine.rename(OTHER_ID, "Elsewhere")).toThrow(
      expect.objectContaining({ code: "unknown-host" }),
    );
    expect(h.store.saves).toEqual([]);
  });
});

/** A box whose `devices list` answers `answer`. */
const listing =
  (answer: Partial<SshExecResult> | (() => Partial<SshExecResult>)): Handler =>
  (script) =>
    script.includes(" devices list --")
      ? typeof answer === "function"
        ? answer()
        : answer
      : undefined;
const listed = (devices: unknown) => listing(json({ v: 1, ok: true, devices }));

describe("a host's devices", () => {
  const OTHER_DEVICE = "5f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
  const MINE = {
    deviceId: DEVICE_ID,
    name: "Alice's Mac",
    fingerprint: "SHA256:mac",
    enrolledAt: "2025-12-01T00:00:00.000Z",
    via: "ssh",
    revokedAt: null,
  };
  const REVOKED = {
    deviceId: OTHER_DEVICE,
    name: "Old laptop",
    fingerprint: "SHA256:old",
    enrolledAt: "2025-11-01T00:00:00.000Z",
    via: "ssh",
    revokedAt: "2025-11-15T00:00:00.000Z",
  };
  const SYSTEM_SCRIPT = [
    "b='/opt/volli-hostd/current/bin/volli-hostd'",
    `[ -x "$b" ] || b='/opt/volli-hostd/bin/volli-hostd'`,
    'exec "$b" devices list --system </dev/null',
  ].join("\n");
  const USER_SCRIPT = [
    'b="${XDG_DATA_HOME:-$HOME/.local/share}/volli-hostd/current/bin/volli-hostd"',
    'exec "$b" devices list --user </dev/null',
  ].join("\n");

  it("lists a system host's devices over SSH, this Mac's marked, a revoked one as it is", async () => {
    const h = harness({ registry: registry(hostEntry()), overrides: [listed([MINE, REVOKED])] });
    expect(await h.engine.devices(HOST_ID)).toEqual({
      hostId: HOST_ID,
      devices: [
        { ...MINE, thisMac: true },
        { ...REVOKED, thisMac: false },
      ],
    });
    expect(devicesListScript("system")).toBe(SYSTEM_SCRIPT);
    // As the login, no sudo, nothing on stdin: one script on its own connection, closed.
    expect(h.box.scripts).toEqual([{ script: SYSTEM_SCRIPT, stdin: null }]);
    expect(h.box.transports).toEqual([
      { target: { destination: "deploy@box", port: null, label: "box" }, closed: true },
    ]);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "listed devices",
        fields: { devices: 2, host: "box", hostId: HOST_ID, component: "host-install" },
      }),
    );
  });

  it("lists a user host's devices from the user install, every time it is asked", async () => {
    let devices: unknown[] = [];
    const h = harness({
      registry: registry(hostEntry({ mode: "user", target: "me@mac:2222", os: "macos" })),
      overrides: [listing(() => json({ v: 1, ok: true, devices }))],
    });
    expect(await h.engine.devices(HOST_ID)).toEqual({ hostId: HOST_ID, devices: [] });
    devices = [REVOKED];
    // Never cached: the second ask reads the box again.
    expect((await h.engine.devices(HOST_ID)).devices).toEqual([{ ...REVOKED, thisMac: false }]);
    expect(devicesListScript("user")).toBe(USER_SCRIPT);
    expect(h.box.ran()).toEqual([USER_SCRIPT, USER_SCRIPT]);
    expect(h.box.transports).toEqual([
      { target: { destination: "me@mac", port: 2222, label: "mac" }, closed: true },
      { target: { destination: "me@mac", port: 2222, label: "mac" }, closed: true },
    ]);
  });

  it("says the host is unreachable when SSH is, and closes the connection", async () => {
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [
        listing({ code: 255, stderr: "ssh: connect to host box port 22: Connection refused\n" }),
      ],
    });
    await expect(h.engine.devices(HOST_ID)).rejects.toMatchObject({
      name: "RemoteHostsError",
      code: "host-unreachable",
      message: "Couldn't reach box.",
    });
    expect(h.box.transports.every((transport) => transport.closed)).toBe(true);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "listing devices: host unreachable",
        fields: expect.objectContaining({ failure: "unreachable", hostId: HOST_ID }),
      }),
    );
  });

  it("says the host is unreachable when the transport itself fails, and still closes it", async () => {
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [
        listing(() => {
          throw new Error("spawn ssh EMFILE");
        }),
      ],
    });
    h.box.closeFails = 1;
    await expect(h.engine.devices(HOST_ID)).rejects.toMatchObject({ code: "host-unreachable" });
    expect(h.box.transports.every((transport) => transport.closed)).toBe(true);
    expect(h.log.lines.map((line) => line.msg)).toEqual(
      expect.arrayContaining([
        "listing devices: ssh failed",
        "listing devices: ssh did not close cleanly",
      ]),
    );
  });

  it("keeps an answer whose connection would not close cleanly", async () => {
    const h = harness({ registry: registry(hostEntry()), overrides: [listed([MINE])] });
    h.box.closeFails = 1;
    expect((await h.engine.devices(HOST_ID)).devices).toEqual([{ ...MINE, thisMac: true }]);
  });

  it("says the host listed nothing usable for no answer, a refusal or a malformed list", async () => {
    const tooLong = "x".repeat(REMOTE_HOST_DEVICE_TEXT_MAX + 1);
    const answers: [string, Partial<SshExecResult>][] = [
      ["no answer", { code: 127, stderr: "sh: 3: exec: volli-hostd: not found\n" }],
      ["garbage", { stdout: "usage: volli-hostd <command>\n{not json\n" }],
      [
        "refused",
        json({
          v: 1,
          ok: false,
          code: "store-untrusted",
          message: "The device store is not root's alone.",
        }),
      ],
      ["not ok", json({ v: 1, ok: "yes", devices: [] })],
      ["no list", json({ v: 1, ok: true, devices: {} })],
      ["not a device", json({ v: 1, ok: true, devices: [MINE, null] })],
      ["a field missing", json({ v: 1, ok: true, devices: [{ ...MINE, via: undefined }] })],
      ["a field too long", json({ v: 1, ok: true, devices: [{ ...MINE, name: tooLong }] })],
      [
        "a bad revocation",
        json({ v: 1, ok: true, devices: [{ ...MINE, revokedAt: 1_700_000_000 }] }),
      ],
      [
        "too many",
        json({
          v: 1,
          ok: true,
          devices: Array.from({ length: REMOTE_HOST_DEVICES_MAX + 1 }, () => MINE),
        }),
      ],
    ];
    for (const [what, answer] of answers) {
      const h = harness({ registry: registry(hostEntry()), overrides: [listing(answer)] });
      await expect(h.engine.devices(HOST_ID), what).rejects.toMatchObject({
        name: "RemoteHostsError",
        code: "devices-unavailable",
        message: "box didn't list its devices.",
      });
      expect(h.box.transports, what).toEqual([expect.objectContaining({ closed: true })]);
    }
    const refused = harness({
      registry: registry(hostEntry()),
      overrides: [listing(answers[2]![1])],
    });
    await expect(refused.engine.devices(HOST_ID)).rejects.toBeInstanceOf(RemoteHostsError);
    expect(refused.log.lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "listing devices: no device list believed",
        fields: expect.objectContaining({ hostd: "store-untrusted", code: 0 }),
      }),
    );
  });

  it("accepts the most devices and the longest fields a host may answer", async () => {
    const longest = "x".repeat(REMOTE_HOST_DEVICE_TEXT_MAX);
    const many = Array.from({ length: REMOTE_HOST_DEVICES_MAX }, () => ({
      ...REVOKED,
      name: longest,
    }));
    const h = harness({ registry: registry(hostEntry()), overrides: [listed(many)] });
    expect((await h.engine.devices(HOST_ID)).devices).toHaveLength(REMOTE_HOST_DEVICES_MAX);
  });

  it("names an unknown host without reaching for any box", async () => {
    const h = harness({ registry: registry(hostEntry()) });
    await expect(h.engine.devices(OTHER_ID)).rejects.toMatchObject({ code: "unknown-host" });
    expect(h.box.transports).toEqual([]);
  });
});

describe("refusals", () => {
  it("refuses everything while remote hosts are off, and starts once they are on", async () => {
    let on = false;
    const h = harness({ registry: registry(hostEntry()), enabled: () => on });
    expect(h.store.state.loads).toBe(0);
    const calls: (() => unknown)[] = [
      () => h.engine.snapshot(),
      () => h.engine.subscribe(() => {}),
      () => h.engine.retry(HOST_ID),
      () => h.engine.updateHost(HOST_ID, "now"),
      () => h.engine.cancelScheduledUpdate(HOST_ID),
      () => h.engine.signIn(HOST_ID, "claude"),
      () => h.engine.openWorkspace(HOST_ID, WS1),
      () => h.engine.workspaceLink(WS1),
      () => h.engine.rename(HOST_ID, "Renamed"),
      () => h.engine.subscribeAdd("flow-1", () => {}),
      () => h.engine.activeAdds(),
    ];
    for (const call of calls) expect(call).toThrow(RemoteHostsUnavailableError);
    for (const call of [
      () => h.engine.forget(HOST_ID),
      () => h.engine.devices(HOST_ID),
      () => h.engine.startAdd({ target: "box" }),
      () => h.engine.answerAdd("flow-1", "q1", { kind: "open" }),
      () => h.engine.sudoPassword("flow-1", "q1", PASSWORD),
      () => h.engine.retryAdd("flow-1"),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(RemoteHostsUnavailableError);
    }
    // Cancel stays open with the flag off, for flows already under way: none here.
    await expect(h.engine.cancelAdd("flow-1")).rejects.toMatchObject({ code: "unknown-flow" });
    // Nothing ran on the box, nothing was saved.
    expect(h.box.scripts).toEqual([]);
    expect(h.box.transports).toEqual([]);
    expect(h.store.saves).toEqual([]);
    on = true;
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
    expect(h.store.state.loads).toBe(1);
    expect(h.tunnels.made).toHaveLength(1);
  });

  it("lends desktop main a ready link that was granted sign-ins, and none otherwise (VC-702)", () => {
    const h = harness({
      tunnelMode: "hold",
      linkFeatures: ["sign-ins", "auth.callback"],
      registry: registry(hostEntry({ workspaceIds: [WS1, WS2] })),
    });
    const tunnel = h.tunnels.made[0]!;
    expect(h.engine.signInLink(HOST_ID)).toBeNull();
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    const [one, two] = h.links.made as [FakeLink, FakeLink];
    expect(one.options.features).toEqual(["sign-ins", "auth.callback"]);
    // Ready, but an older host that never granted sign-ins.
    one.set(ready());
    expect(h.engine.signInLink(HOST_ID)).toBeNull();
    const granted = ready();
    if (granted.status !== "ready") throw new Error("ready");
    two.set({ ...granted, welcome: { ...granted.welcome, features: ["sign-ins"] } });
    expect(h.engine.signInLink(HOST_ID)).toBe(two);
    expect(() => h.engine.signInLink(OTHER_ID)).toThrow();
  });

  it("lends desktop main a Workspace's own link while it is ready, and none otherwise (VC-711)", () => {
    const h = harness({
      tunnelMode: "hold",
      registry: registry(hostEntry({ workspaceIds: [WS1, WS2] })),
    });
    const tunnel = h.tunnels.made[0]!;
    // No link yet: the tunnel is not up.
    expect(h.engine.workspaceLink(WS1)).toBeNull();
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    const [one, two] = h.links.made as [FakeLink, FakeLink];
    expect(h.engine.workspaceLink(WS1)).toBeNull();
    two.set(ready());
    expect(h.engine.workspaceLink(WS1)).toBeNull();
    expect(h.engine.workspaceLink(WS2)).toBe(two);
    one.set(ready());
    expect(h.engine.workspaceLink(WS1)).toBe(one);
    // A Workspace no host here serves has none.
    expect(h.engine.workspaceLink("0f8fad5b-d9cb-469f-a165-70867728950e")).toBeNull();
    // Dropped: none until it is ready again.
    one.set({ status: "connecting", attempt: 1 });
    expect(h.engine.workspaceLink(WS1)).toBeNull();
  });

  it("refuses updates and sign-in in v1 with the shared words", () => {
    const h = harness({ registry: registry(hostEntry()) });
    expect(() => h.engine.updateHost(HOST_ID, "when-idle")).toThrow(REMOTE_HOST_UPDATE_UNAVAILABLE);
    expect(() => h.engine.cancelScheduledUpdate(HOST_ID)).toThrow(REMOTE_HOST_UPDATE_UNAVAILABLE);
    expect(() => h.engine.signIn(HOST_ID, "claude")).toThrow(REMOTE_HOST_SIGN_IN_UNAVAILABLE);
    try {
      h.engine.signIn(HOST_ID, "claude");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteHostsUnavailableError);
      expect((error as Error).name).toBe("RemoteHostsUnavailableError");
    }
  });

  it("names an unknown flow", async () => {
    const h = harness();
    expect(() => h.engine.subscribeAdd("nope", () => {})).toThrow(
      expect.objectContaining({ code: "unknown-flow", name: "RemoteHostsError" }),
    );
    await expect(h.engine.answerAdd("nope", "q1", { kind: "open" })).rejects.toMatchObject({
      code: "unknown-flow",
    });
    await expect(h.engine.cancelAdd("nope")).rejects.toMatchObject({ code: "unknown-flow" });
    expect(() => h.engine.addFacts("nope")).toThrow(
      expect.objectContaining({ code: "unknown-flow" }),
    );
  });
});

describe("the registry file", () => {
  it.each([
    [
      "from a newer Volli",
      { v: 2, hosts: [hostEntry({ id: OTHER_ID })], futureData: "keep" },
      "This Mac’s hosts file is from a newer Volli.",
    ],
    ["not a registry", { v: 1, hosts: "lots" }, "This Mac’s hosts file can’t be read."],
    ["unreadable", new Error("Unexpected token } in JSON"), "This Mac’s hosts file can’t be read."],
  ])("leaves a file %s exactly as it is, and refuses every change", async (_, file, line) => {
    const h = harness({ registry: file });
    expect(h.engine.snapshot()).toEqual({ v: 1, hosts: [], projects: {}, readOnly: line });
    expect(h.log.lines).toContainEqual(expect.objectContaining({ level: "error" }));
    await expect(h.engine.startAdd({ target: "deploy@box" })).rejects.toMatchObject({
      code: "registry-read-only",
      message: line,
    });
    await expect(h.engine.forget(HOST_ID)).rejects.toMatchObject({ code: "registry-read-only" });
    expect(() => h.engine.openWorkspace(HOST_ID, WS1)).toThrow(line);
    expect(h.store.saves).toEqual([]);
    expect(h.store.state.file).toBe(file);
    expect(h.keys.calls).toEqual([]);
  });

  it("keeps the hosts it can use, and drops the rest at the next save", () => {
    const h = harness({ registry: { v: 1, hosts: [hostEntry(), { ...hostEntry(), id: "bad" }] } });
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
    expect(h.engine.snapshot().readOnly).toBeNull();
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({ level: "warn", fields: { problems: "host 1 is malformed" } }),
    );
    h.engine.openWorkspace(HOST_ID, WS1);
    expect(h.store.saves.at(-1)?.hosts.map((host) => host.id)).toEqual([HOST_ID]);
  });

  it("refuses to open a Workspace it could not save, keeping what it had", () => {
    const h = harness({ registry: registry(hostEntry()) });
    h.store.state.saveFails = true;
    expect(() => h.engine.openWorkspace(HOST_ID, WS1)).toThrow(
      expect.objectContaining({
        code: "registry-unwritable",
        message: "Couldn’t save this Mac’s hosts file.",
      }),
    );
    expect(h.engine.snapshot().projects).toEqual({});
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({ level: "error", msg: "remote host registry not saved" }),
    );
  });

  it("forgets nothing it could not save: the host, its tunnel and its key stay", async () => {
    const h = harness({ registry: registry(hostEntry()) });
    h.keys.keys.set(HOST_KEY, "key");
    h.store.state.saveFails = true;
    await expect(h.engine.forget(HOST_ID)).rejects.toMatchObject({ code: "registry-unwritable" });
    expect(h.engine.snapshot().hosts.map((host) => host.id)).toEqual([HOST_ID]);
    expect(h.tunnels.made[0]!.closed).toBe(false);
    expect([...h.keys.keys.keys()]).toEqual([HOST_KEY]);
    expect((h.store.state.file as RegistryFile).hosts).toHaveLength(1);
    // Once the disk takes it, Forget goes through.
    h.store.state.saveFails = false;
    await h.engine.forget(HOST_ID);
    expect(h.keys.keys.size).toBe(0);
  });

  it("forgets a host even when its key will not go, and says so", async () => {
    const h = harness({ registry: registry(hostEntry()) });
    h.keys.hooks.remove = () => Promise.reject(new Error("keychain locked"));
    await h.engine.forget(HOST_ID);
    expect(h.engine.snapshot().hosts).toEqual([]);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({
        msg: "a device key was not removed",
        fields: { key: HOST_KEY, error: "keychain locked" },
      }),
    );
  });

  it("fails an add it could not save, retryably: no host, the key kept for the retry", async () => {
    const h = harness();
    h.store.state.saveFails = true;
    const { flowId, w, view } = await startAdd(h);
    expect(view).toMatchObject({
      status: "failed",
      failure: { code: "save-failed", detail: "Couldn’t save this Mac’s hosts file." },
    });
    expect(h.engine.snapshot().hosts).toEqual([]);
    expect(h.store.state.file).toBeNull();
    expect(h.keys.keys.has(`flow:${flowId}`)).toBe(true);
    h.store.state.saveFails = false;
    await h.engine.retryAdd(flowId);
    expect(w.views().at(-1)?.status).toBe("done");
    expect((h.store.state.file as RegistryFile).hosts.map((host) => host.id)).toEqual([HOST_ID]);
    expect([...h.keys.keys.keys()]).toEqual([HOST_KEY]);
  });

  it("keeps a version its link reported in memory when the disk will not take it", () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    h.store.state.saveFails = true;
    (h.links.made[0] as FakeLink).set(ready("1.2.0"));
    expect(h.engine.snapshot().hosts[0]?.version).toBe("1.2.0");
  });
});

describe("listeners and closing", () => {
  it("survives a listener that throws", async () => {
    const h = harness({ registry: registry(hostEntry()) });
    h.engine.subscribe(() => {
      throw new Error("renderer gone");
    });
    h.engine.openWorkspace(HOST_ID, WS1);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({ msg: "remote hosts listener threw" }),
    );
    let replayed = false;
    const { flowId } = await h.engine.startAdd({ target: "other@box2" });
    h.engine.subscribeAdd(flowId, (event) => {
      if (event.kind !== "view") return;
      if (replayed) throw new Error("sheet gone");
      replayed = true;
    });
    await watch(h.engine, flowId).until();
    expect(h.log.lines).toContainEqual(expect.objectContaining({ msg: "add-host listener threw" }));
  });

  it("closes everything at quit: hosts, links and open flows", async () => {
    const h = harness({ registry: registry(hostEntry({ workspaceIds: [WS1] })) });
    h.box.trusted = false;
    const { flowId, w } = await startAdd(h, { target: "other@box2" });
    const other = await startAdd(h, { target: "third@box3" });
    expect(other.view.status).toBe("question");
    h.box.closeFails = 1;
    await h.engine.close();
    expect(h.tunnels.made[0]!.closed).toBe(true);
    expect(h.links.made[0]!.closed).toBe(true);
    expect(w.views().at(-1)?.status).toBe("cancelled");
    expect(other.w.views().at(-1)?.status).toBe("cancelled");
    // Each flow's key goes, even when its SSH would not close cleanly.
    expect(h.keys.keys.has(`flow:${flowId}`)).toBe(false);
    expect(h.keys.keys.has(`flow:${other.flowId}`)).toBe(false);
    expect(h.box.transports.every((transport) => transport.closed)).toBe(true);
    expect(h.log.lines).toContainEqual(
      expect.objectContaining({ msg: "an add flow's ssh connection did not close cleanly" }),
    );
    await h.engine.close();
    expect(() => h.engine.snapshot()).toThrow(RemoteHostsUnavailableError);
  });

  it("leaves a finished flow alone at quit, and removes a cancelled flow's key", async () => {
    const h = harness();
    const done = await startAdd(h);
    h.box.trusted = false;
    const asked = await startAdd(h, { target: "other@box2" });
    await h.engine.cancelAdd(asked.flowId);
    h.box.trusted = true;
    await h.engine.close();
    expect(done.w.views().at(-1)?.status).toBe("done");
    expect([...h.keys.keys.keys()]).toEqual([HOST_KEY]);
  });
});
