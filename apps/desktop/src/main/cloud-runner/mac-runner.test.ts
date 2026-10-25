import { EventEmitter } from "node:events";

import type { LinkStatus, RunnerLink, RunnerLinkLoss } from "@volli/host-core/cloud-runner";
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

const flush = () => new Promise((done) => setImmediate(done));

function harness(
  options: {
    sealed?: RunnerLink | null;
    record?: MacRunnerRecord | null;
    account?: AccountSnapshot;
    token?: string | null;
  } = {},
) {
  const calls: string[] = [];
  let sealed: RunnerLink | null = options.sealed ?? null;
  let record: MacRunnerRecord | null = options.record ?? null;
  let accountListener: ((snapshot: AccountSnapshot) => void) | null = null;
  let account = options.account ?? signedIn();
  let token: string | null = options.token === undefined ? "person-token" : options.token;
  let loadFails = false;
  const registerAnswers: (RunnerLinkGrant | Error)[] = [];
  const connections: {
    input: ConnectRunnerInput;
    status: LinkStatus;
    beating: boolean;
    calls: string[];
  }[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const power = new EventEmitter() as EventEmitter & PowerPort;

  const backend: MacRunnerBackend = {
    async registerThisMac(accessToken, input) {
      calls.push(`register ${accessToken} replaces=${input.replacesRunnerId} name=${input.name}`);
      const answer = registerAnswers.shift() ?? {
        runnerId: NEW,
        name: "danas-mac",
        credential: "vrc_new",
        generation: 1,
      };
      if (answer instanceof Error) throw answer;
      return answer as RunnerLinkGrant;
    },
    async removeRunner(accessToken, runnerId) {
      calls.push(`remove ${accessToken} ${runnerId}`);
    },
  };

  const runner = createMacRunner({
    userId: ME,
    account: {
      subscribe(listener) {
        accountListener = listener;
        listener(account);
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
          resume: async () => void connection.calls.push("resume"),
        },
        refreshCapabilities: () => void connection.calls.push("capabilities"),
        stop: async () => void connection.calls.push("stop"),
        close: async () => void connection.calls.push("close"),
      };
      return handle;
    },
    host: async () => ({ facts: HOST, name: "Dana's Mac-dev" }),
    hostname: () => HOST.hostname,
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
    get sealed() {
      return sealed;
    },
    get record() {
      return record;
    },
    setAccount(next: AccountSnapshot) {
      account = next;
      accountListener?.(next);
    },
    setToken: (next: string | null) => void (token = next),
    failLoad: () => void (loadFails = true),
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

describe("the Mac runner", () => {
  it("registers with the person's sign-in, seals the grant, remembers the runner and connects", async () => {
    const h = harness();
    h.runner.start();
    await flush();
    expect(h.calls).toEqual([
      "register person-token replaces=null name=Dana's Mac-dev",
      `seal ${NEW} gen=1`,
    ]);
    expect(h.record).toEqual({ runnerId: NEW, hostname: "danas-mac", tombstone: null });
    expect(h.runner.snapshot()).toMatchObject({
      state: "connecting",
      runnerId: NEW,
      runnerName: "danas-mac",
    });
    expect(h.connections[0]!.calls).toEqual(["start"]);
    h.connected();
    expect(h.runner.snapshot()).toMatchObject({ state: "online", since: 1_000, problem: null });
  });

  it("connects a sealed link without registering, and waits out a restoring sign-in", async () => {
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

  it("replaces the runner it remembers when its sealed credential was lost, on the same host only", async () => {
    const same = harness({ record: { runnerId: OLD, hostname: "danas-mac", tombstone: null } });
    same.runner.start();
    await flush();
    expect(same.calls[0]).toBe(`register person-token replaces=${OLD} name=Dana's Mac-dev`);

    const restoredElsewhere = harness({
      record: { runnerId: OLD, hostname: "someone-elses-mac", tombstone: null },
    });
    restoredElsewhere.runner.start();
    await flush();
    expect(restoredElsewhere.calls[0]).toBe(
      "register person-token replaces=null name=Dana's Mac-dev",
    );
  });

  it("shows offline and asleep from the connection and the power events", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    h.connected();
    const connection = h.connections[0]!;
    h.power.emit("suspend");
    expect(h.runner.snapshot()).toMatchObject({ state: "asleep", since: 1_000 });
    expect(connection.calls).toEqual(["start", "suspend"]);
    h.power.emit("resume");
    expect(connection.calls).toEqual(["start", "suspend", "resume"]);
    expect(h.runner.snapshot().state).toBe("online");
    connection.status = { state: "offline", since: 500 };
    connection.input.onChange();
    expect(h.runner.snapshot()).toMatchObject({ state: "offline", since: 500 });
  });

  it("stops on sign-out keeping the credential, and resumes the same runner on sign-in", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    h.setAccount(SIGNED_OUT);
    await flush();
    expect(h.connections[0]!.calls).toEqual(["start", "stop"]);
    expect(h.sealed).toEqual(LINK);
    expect(h.runner.snapshot().state).toBe("off");
    h.setAccount(signedIn());
    await flush();
    expect(h.connections).toHaveLength(2);
    expect(h.calls).toEqual([]);
    // Another person signing in is a sign-out for this launch's.
    h.setAccount(signedIn("44444444-4444-4444-8444-444444444444"));
    await flush();
    expect(h.connections[1]!.calls).toEqual(["start", "stop"]);
  });

  it("removed elsewhere: clears the link, leaves a tombstone and never re-registers by itself", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    h.connections[0]!.input.onLost("revoked" satisfies RunnerLinkLoss);
    await flush();
    expect(h.connections[0]!.calls).toEqual(["start", "close"]);
    expect(h.sealed).toBeNull();
    expect(h.record).toEqual({ runnerId: OLD, hostname: "danas-mac", tombstone: "removed" });
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
    expect(relaunched.calls[0]).toBe(`register person-token replaces=${OLD} name=Dana's Mac-dev`);
    expect(relaunched.record?.tombstone).toBeNull();
  });

  it("names credential reuse, and drops a rotation that lands after the link ended", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    const { input } = h.connections[0]!;
    input.onLost("invalid_credential");
    await flush();
    expect(h.runner.snapshot().problem).toBe("credential_reuse");
    await expect(input.store.save({ ...LINK, generation: 4 })).rejects.toThrow("ended");
    expect(h.sealed).toBeNull();
  });

  it("removes this Mac: the backend first, then the link, then the tombstone", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    await h.runner.removeThisMac();
    expect(h.calls).toEqual([`remove person-token ${OLD}`, "clear"]);
    expect(h.connections[0]!.calls).toEqual(["start", "close"]);
    expect(h.runner.snapshot().state).toBe("removed");
    expect(h.record?.tombstone).toBe("removed");
  });

  it("keeps everything when the backend refuses the removal", async () => {
    const h = harness({ sealed: LINK });
    h.runner.start();
    await flush();
    h.setToken(null);
    await expect(h.runner.removeThisMac()).rejects.toThrow("Sign in");
    expect(h.sealed).toEqual(LINK);
    expect(h.connections[0]!.calls).toEqual(["start"]);
  });

  it("retries an unreachable registration with backoff, and at once on wake", async () => {
    const h = harness();
    h.registerAnswers.push(
      new BackendUnreachableError("offline"),
      new BackendUnreachableError("offline"),
    );
    h.runner.start();
    await flush();
    expect(h.runner.snapshot()).toMatchObject({ state: "failed", problem: "unreachable" });
    expect(h.timers.map((timer) => timer.ms)).toEqual([MAC_RUNNER_RETRY.firstMs]);
    h.timers.shift()!.run();
    await flush();
    expect(h.timers.map((timer) => timer.ms)).toEqual([MAC_RUNNER_RETRY.firstMs * 2]);
    h.power.emit("suspend");
    h.power.emit("resume");
    await flush();
    expect(h.runner.snapshot().state).toBe("connecting");
    expect(h.calls.filter((call) => call.startsWith("register"))).toHaveLength(3);
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
