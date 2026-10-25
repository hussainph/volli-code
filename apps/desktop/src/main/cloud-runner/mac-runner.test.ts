import { EventEmitter } from "node:events";

import type { LinkStatus, RunnerLink } from "@volli/host-core/cloud-runner";
import type { PowerPort } from "@volli/host-core/ports";
import type { AccountSnapshot } from "@volli/shared";
import type { RunnerHostFacts, RunnerLinkGrant } from "@volli/shared/cloud";
import { describe, expect, it } from "vite-plus/test";

import { BackendRefusedError } from "../account/backend";
import { BackendUnreachableError, type MacRunnerBackend } from "./backend";
import type { ConnectRunnerInput, RunnerConnection } from "./connection";
import { createMacRunner, MAC_RUNNER_RETRY, type MacRunnerRecord } from "./mac-runner";

const ME = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";
const HOST: RunnerHostFacts = {
  hostname: "danas-mac",
  platform: { os: "darwin", distro: null, kernel: "25.0.0", arch: "arm64", glibc: null },
  installMode: "app",
};

function signedIn(userId: string | null = ME): AccountSnapshot {
  return {
    state: "signed-in",
    provider: "dev",
    failure: null,
    account: {
      displayName: "Dana",
      email: null,
      userId,
      deletionPurgeAfter: null,
      backend: "synced",
    },
  } as unknown as AccountSnapshot;
}
const SIGNED_OUT = {
  state: "signed-out",
  provider: "dev",
  failure: null,
  account: null,
} as unknown as AccountSnapshot;
const RESTORING = {
  state: "restoring",
  provider: "dev",
  failure: null,
  account: null,
} as unknown as AccountSnapshot;

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((done) => setImmediate(done));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const GRANT: RunnerLinkGrant = {
  runnerId: NEW as RunnerLinkGrant["runnerId"],
  name: "danas-mac",
  credential: "vrc_new",
  generation: 1,
};

function harness(
  options: {
    sealed?: RunnerLink | null;
    record?: MacRunnerRecord | null;
    account?: AccountSnapshot;
  } = {},
) {
  const calls: string[] = [];
  let sealed: RunnerLink | null = options.sealed ?? null;
  let record: MacRunnerRecord | null = options.record ?? null;
  let accountListener: ((snapshot: AccountSnapshot) => void) | null = null;
  let token: string | null = "person-token";
  let loadFails = false;
  let clearFails = false;
  let registrations = 0;
  const registerAnswers: (RunnerLinkGrant | Error | Promise<RunnerLinkGrant>)[] = [];
  const statuses = new Map<string, { status: string; statusReason: string | null }>();
  const stops: Promise<void>[] = [];
  const connections: {
    input: ConnectRunnerInput;
    status: LinkStatus;
    beating: boolean;
    calls: string[];
    resume: Promise<void>;
  }[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const power = new EventEmitter() as EventEmitter & PowerPort;

  const backend: MacRunnerBackend = {
    async registerThisMac(accessToken, input) {
      calls.push(
        `register ${accessToken} replaces=${input.replacesRunnerId} reg=${input.registrationId} name=${input.name}`,
      );
      registrations += 1;
      const answer = registerAnswers.shift() ?? GRANT;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async removeRunner(accessToken, runnerId) {
      calls.push(`remove ${accessToken} ${runnerId}`);
    },
    async runnerStatus(_accessToken, runnerId) {
      return statuses.get(runnerId) ?? null;
    },
  };

  const runner = createMacRunner({
    userId: ME,
    account: {
      subscribe(listener) {
        accountListener = listener;
        listener(options.account ?? signedIn());
        return () => (accountListener = null);
      },
      accessToken: async () => token,
    },
    store: {
      load: async () => {
        if (loadFails) throw new Error("keychain locked");
        return sealed;
      },
      save: async (link) => {
        calls.push(`seal ${link.runnerId} gen=${link.generation}`);
        sealed = link;
      },
      clear: async () => {
        if (clearFails) throw new Error("keychain locked");
        calls.push("clear");
        sealed = null;
      },
    },
    record: { read: () => record, write: (next) => void (record = next) },
    backend,
    connect(input) {
      const connection = {
        input,
        status: { state: "connecting" } as LinkStatus,
        beating: false,
        calls: [] as string[],
        resume: Promise.resolve(),
      };
      connections.push(connection);
      const handle: RunnerConnection = {
        get status() {
          return connection.status;
        },
        get beating() {
          return connection.beating;
        },
        start: () => void connection.calls.push("start"),
        power: {
          suspend: async () => void connection.calls.push("suspend"),
          resume: () => {
            connection.calls.push("resume");
            return connection.resume;
          },
        },
        refreshCapabilities: () => void connection.calls.push("capabilities"),
        stop: () => {
          connection.calls.push("stop");
          return stops.shift() ?? Promise.resolve();
        },
        close: async () => void connection.calls.push("close"),
      };
      return handle;
    },
    host: async () => ({ facts: HOST, name: "Dana's Mac-dev" }),
    machine: async () => "m1",
    newId: () => `reg-${registrations + 1}`,
    power,
    now: () => 1_000,
    timers: {
      setTimeout: (run, ms) => {
        const timer = { run, ms };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        const index = timers.indexOf(handle as (typeof timers)[number]);
        if (index >= 0) timers.splice(index, 1);
      },
    },
    log: { info: () => {}, warn: () => {} },
  });
  return {
    runner,
    calls,
    connections,
    timers,
    power,
    registerAnswers,
    statuses,
    stops,
    get sealed() {
      return sealed;
    },
    get record() {
      return record;
    },
    setAccount(next: AccountSnapshot) {
      accountListener?.(next);
    },
    setToken: (next: string | null) => void (token = next),
    failLoad: () => void (loadFails = true),
    failClear: () => void (clearFails = true),
    connected(index = connections.length - 1) {
      const connection = connections[index]!;
      connection.status = { state: "connected" };
      connection.beating = true;
      connection.input.onChange();
    },
  };
}

const LINK: RunnerLink = {
  runnerId: OLD as RunnerLink["runnerId"],
  name: "danas-mac",
  credential: "vrc_old",
  generation: 3,
};
const RECORD: MacRunnerRecord = {
  runnerId: OLD,
  machine: "m1",
  registrationId: null,
  tombstone: null,
};

describe("the Mac runner", () => {
  it("registers with the person's sign-in, seals the grant, remembers the runner and connects", async () => {
    const h = harness();
    h.runner.start();
    await flush();
    expect(h.calls).toEqual([
      "register person-token replaces=null reg=reg-1 name=Dana's Mac-dev",
      `seal ${NEW} gen=1`,
    ]);
    expect(h.record).toEqual({
      runnerId: NEW,
      machine: "m1",
      registrationId: null,
      tombstone: null,
    });
    expect(h.runner.snapshot()).toMatchObject({
      state: "connecting",
      runnerId: NEW,
      runnerName: "danas-mac",
    });
    expect(h.connections[0]!.calls).toEqual(["start"]);
    h.connected();
    expect(h.runner.snapshot()).toMatchObject({ state: "online", since: 1_000, problem: null });
  });

  it("connects a sealed link while the sign-in restores, without registering", async () => {
    const h = harness({ sealed: LINK, account: RESTORING });
    const seen: string[] = [];
    h.runner.subscribe((snapshot) => seen.push(snapshot.state));
    h.runner.start();
    await flush();
    expect(h.calls).toEqual([]);
    expect(h.connections).toHaveLength(1);
    h.setAccount(signedIn());
    await flush();
    expect(h.connections).toHaveLength(1);
    expect(seen).toEqual(["off", "connecting"]);
  });

  it("waits for the sign-in to finish before registering", async () => {
    const h = harness({ account: RESTORING });
    h.runner.start();
    await flush();
    expect(h.runner.snapshot().state).toBe("unregistered");
    expect(h.calls).toEqual([]);
    h.setAccount(signedIn());
    await flush();
    expect(h.calls[0]).toMatch(/^register /u);
    expect(h.runner.snapshot().state).toBe("connecting");
  });

  it("replaces the runner it remembers when its credential was lost, on the same machine only", async () => {
    const same = harness({ record: RECORD });
    same.runner.start();
    await flush();
    expect(same.calls[0]).toBe(
      `register person-token replaces=${OLD} reg=reg-1 name=Dana's Mac-dev`,
    );

    const restoredElsewhere = harness({ record: { ...RECORD, machine: "another-mac" } });
    restoredElsewhere.runner.start();
    await flush();
    expect(restoredElsewhere.calls[0]).toBe(
      "register person-token replaces=null reg=reg-1 name=Dana's Mac-dev",
    );
  });

  it("shows offline and asleep, and connecting after a wake until the wake sequence is done", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    h.connected();
    const connection = h.connections[0]!;
    h.power.emit("suspend");
    expect(h.runner.snapshot()).toMatchObject({ state: "asleep", since: 1_000 });
    expect(connection.calls).toEqual(["start", "suspend"]);
    const waking = deferred<void>();
    connection.resume = waking.promise;
    h.power.emit("resume");
    expect(connection.calls).toEqual(["start", "suspend", "resume"]);
    expect(h.runner.snapshot().state).toBe("connecting");
    waking.resolve();
    await flush();
    expect(h.runner.snapshot().state).toBe("online");
    connection.status = { state: "offline", since: 500 };
    connection.input.onChange();
    expect(h.runner.snapshot()).toMatchObject({ state: "offline", since: 500 });
  });

  it("stops on sign-out keeping the credential, and reconnects only once the old connection is done", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    const stopped = deferred<void>();
    h.stops.push(stopped.promise);
    h.setAccount(SIGNED_OUT);
    await flush();
    expect(h.connections[0]!.calls).toEqual(["start", "stop"]);
    expect(h.sealed).toEqual(LINK);
    expect(h.runner.snapshot().state).toBe("off");
    h.setAccount(signedIn());
    await flush();
    // Two connections never present one credential.
    expect(h.connections).toHaveLength(1);
    stopped.resolve();
    await flush();
    expect(h.connections).toHaveLength(2);
    expect(h.calls).toEqual([]);
    // Another person signing in is a sign-out for this launch's.
    h.setAccount(signedIn("44444444-4444-4444-8444-444444444444"));
    await flush();
    expect(h.connections[1]!.calls).toEqual(["start", "stop"]);
  });

  it("removed elsewhere: asks why, clears the link, tombstones, and never re-registers by itself", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    h.connections[0]!.input.onLost("revoked");
    await flush();
    expect(h.connections[0]!.calls).toEqual(["start", "close"]);
    expect(h.sealed).toBeNull();
    expect(h.record).toEqual({ ...RECORD, tombstone: "removed" });
    expect(h.runner.snapshot()).toMatchObject({
      state: "removed",
      problem: "removed",
      message: "danas-mac was removed from your account.",
    });
    // A relaunch finds the tombstone and waits for the person.
    const relaunched = harness({ record: h.record });
    relaunched.runner.start();
    await flush();
    expect(relaunched.calls).toEqual([]);
    expect(relaunched.runner.snapshot()).toMatchObject({ state: "removed", runnerId: OLD });
    // "Add this Mac again".
    await relaunched.runner.addThisMac();
    expect(relaunched.calls[0]).toBe(
      `register person-token replaces=${OLD} reg=reg-1 name=Dana's Mac-dev`,
    );
    expect(relaunched.record?.tombstone).toBeNull();
  });

  it("names credential reuse from the person's list, and drops a rotation landing after the end", async () => {
    const h = harness({ sealed: LINK });
    h.statuses.set(OLD, { status: "revoked", statusReason: "credential_reuse" });
    h.runner.start();
    await flush();
    const { input } = h.connections[0]!;
    input.onLost("revoked");
    await flush();
    expect(h.runner.snapshot()).toMatchObject({
      problem: "credential_reuse",
      message: "danas-mac was used from two places, so Volli Cloud disconnected it.",
    });
    await expect(input.store.save({ ...LINK, generation: 4 })).rejects.toThrow("ended");
    await expect(input.store.load()).resolves.toBeNull();
    expect(h.sealed).toBeNull();
  });

  it("a credential lost here (not revoked) registers again as its own replacement", async () => {
    for (const reason of ["unlinked", "invalid_credential"] as const) {
      const h = harness({ sealed: LINK, record: RECORD });
      h.runner.start();
      await flush();
      h.connections[0]!.input.onLost(reason);
      await flush();
      expect(h.calls).toEqual([
        "clear",
        `register person-token replaces=${OLD} reg=reg-1 name=Dana's Mac-dev`,
        `seal ${NEW} gen=1`,
      ]);
      expect(h.record?.tombstone).toBeNull();
      expect(h.connections).toHaveLength(2);
    }
  });

  it("removes this Mac: the backend first, then the tombstone, then the link", async () => {
    const h = harness({ sealed: LINK, record: RECORD });
    h.runner.start();
    await flush();
    await h.runner.removeThisMac();
    expect(h.calls).toEqual([`remove person-token ${OLD}`, "clear"]);
    expect(h.connections[0]!.calls).toEqual(["start", "close"]);
    expect(h.runner.snapshot().state).toBe("removed");
    expect(h.record?.tombstone).toBe("removed");
  });

  it("stays removed when the sealed store cannot be cleared", async () => {
    const h = harness({ sealed: LINK, record: RECORD });
    h.runner.start();
    await flush();
    h.failClear();
    await h.runner.removeThisMac();
    expect(h.runner.snapshot().state).toBe("removed");
    expect(h.record?.tombstone).toBe("removed");
  });

  it("removing while a registration is in flight undoes the registration and keeps the tombstone", async () => {
    const h = harness({ record: RECORD });
    const answer = deferred<RunnerLinkGrant>();
    h.registerAnswers.push(answer.promise);
    h.runner.start();
    await flush();
    expect(h.runner.snapshot().state).toBe("registering");
    await h.runner.removeThisMac();
    answer.resolve(GRANT);
    await flush();
    expect(h.calls).toEqual([
      `register person-token replaces=${OLD} reg=reg-1 name=Dana's Mac-dev`,
      `remove person-token ${OLD}`,
      "clear",
      `remove person-token ${NEW}`,
    ]);
    expect(h.sealed).toBeNull();
    expect(h.connections).toHaveLength(0);
    expect(h.record).toMatchObject({ runnerId: NEW, tombstone: "removed" });
    expect(h.runner.snapshot().state).toBe("removed");
  });

  it("keeps everything when the removal cannot be asked for", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    h.setToken(null);
    await expect(h.runner.removeThisMac()).rejects.toThrow("Sign in");
    expect(h.sealed).toEqual(LINK);
    expect(h.connections[0]!.calls).toEqual(["start"]);
  });

  it("retries an unreachable registration with backoff and the same registration id, and at once on wake", async () => {
    const h = harness();
    h.registerAnswers.push(
      new BackendUnreachableError("offline"),
      new BackendUnreachableError("offline"),
    );
    h.runner.start();
    await flush();
    expect(h.runner.snapshot()).toMatchObject({ state: "failed", problem: "unreachable" });
    expect(h.record).toMatchObject({ runnerId: null, registrationId: "reg-1" });
    expect(h.timers.map((timer) => timer.ms)).toEqual([MAC_RUNNER_RETRY.firstMs]);
    h.timers.shift()!.run();
    await flush();
    expect(h.timers.map((timer) => timer.ms)).toEqual([MAC_RUNNER_RETRY.firstMs * 2]);
    h.power.emit("suspend");
    h.power.emit("resume");
    await flush();
    expect(h.runner.snapshot().state).toBe("connecting");
    const registrations = h.calls.filter((call) => call.startsWith("register"));
    expect(registrations).toHaveLength(3);
    // A retry is the same registration: the backend answers it once.
    expect(new Set(registrations.map((call) => /reg=(\S+)/u.exec(call)![1]))).toEqual(
      new Set(["reg-1"]),
    );
    expect(h.record).toMatchObject({ runnerId: NEW, registrationId: null });
  });

  it("shows a refusal and a locked keychain with one recovery", async () => {
    const refused = harness();
    refused.registerAnswers.push(
      new BackendRefusedError("This account is being deleted.", "account_deleted"),
    );
    refused.runner.start();
    await flush();
    expect(refused.runner.snapshot()).toMatchObject({
      state: "failed",
      problem: "refused",
      message: "This account is being deleted.",
    });
    expect(refused.timers).toEqual([]);

    const locked = harness();
    locked.failLoad();
    locked.runner.start();
    await flush();
    expect(locked.runner.snapshot()).toMatchObject({
      state: "failed",
      problem: "credentials_locked",
    });
  });

  it("does nothing while signed out, and stops cleanly at quit", async () => {
    const out = harness({ account: SIGNED_OUT });
    out.runner.start();
    await flush();
    expect(out.calls).toEqual([]);
    expect(out.runner.snapshot().state).toBe("off");
    await expect(out.runner.addThisMac()).rejects.toThrow("Sign in");

    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    h.runner.refreshCapabilities();
    await h.runner.stop();
    expect(h.connections[0]!.calls).toEqual(["start", "capabilities", "stop"]);
  });
});
