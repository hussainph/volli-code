import { describe, expect, it } from "vite-plus/test";

import type { RunnerHostCapabilities } from "@volli/host-core/cloud-runner";
import { NO_POWER_EVENTS } from "@volli/host-core/ports";
import {
  LOCAL_LAUNCH,
  OperationUnavailableError,
  THIS_MAC_RUNNER_OFF,
  type AccountSnapshot,
} from "@volli/shared";
import type { RunnerCapabilityReport } from "@volli/shared/cloud";

import { tempInventory } from "../account/test-support";
import { chooseProductStore } from "../cloud-launch";
import type { RunnerConnectionDeps } from "./connection";
import { runnerLinkPurpose } from "./identity-store";
import {
  createDesktopMacRunner,
  runnerAccountPort,
  runnerLocalCredentials,
  thisMacCapabilities,
  thisMacReport,
  thisMacRunnerLaunch,
  type DesktopMacRunnerInput,
} from "./index";
import type { MacRunner } from "./mac-runner";

const browser = () => ({ state: "available", backend: "electron" }) as const;

/** The platform probe's answer, faked: a report test never runs `git --version`. */
const probeReport = async (host: RunnerHostCapabilities): Promise<RunnerCapabilityReport> => ({
  version: host.version,
  platform: { os: "darwin", distro: null, kernel: null, arch: "arm64", glibc: null },
  installMode: host.installMode,
  capabilities: {
    v: 1,
    nodeVersion: "v24.0.0",
    cpuCount: 8,
    memTotalMb: 16_384,
    git: { version: "2.43.0" },
    docker: host.docker,
    terminals: host.terminals ? "available" : "unavailable",
    browser: host.browser,
    maxConcurrentSessions: host.maxConcurrentSessions,
    tools: host.tools,
  },
  localCredentials: host.localCredentials,
});

describe("what this Mac reports it can do", () => {
  it("names the job kinds its cloud store executes, so the backend routes them here", () => {
    expect(
      thisMacCapabilities({ appVersion: "0.3.0", browser, jobCapabilities: ["automation.run"] }),
    ).toMatchObject({ version: "0.3.0", installMode: "app", tools: ["automation.run"] });
  });
  it("an executor-less composition names none: no Automation Run is routed to it", () => {
    expect(thisMacCapabilities({ appVersion: "0.3.0", browser }).tools).toEqual([]);
  });

  it("adds C1's power line: the switch as alwaysOn, the reading as source", async () => {
    const report = await thisMacReport(
      { appVersion: "0.3.0", browser, powerFacts: () => ({ enabled: true, source: "battery" }) },
      probeReport,
    );
    expect(report.capabilities).toMatchObject({
      power: { source: "battery", alwaysOn: true },
      tools: [],
    });
    // Unwired, it claims nothing — never a guessed AC.
    const unwired = await thisMacReport({ appVersion: "0.3.0", browser }, probeReport);
    expect(unwired.capabilities).toMatchObject({ power: { source: "unknown", alwaysOn: false } });
  });

  it("reports this Mac's signed-in models as availability, never a value", async () => {
    const report = await thisMacReport(
      {
        appVersion: "0.3.0",
        browser,
        credentials: async () => [
          { providerId: "openai", type: "api_key" },
          { providerId: "anthropic", type: "oauth" },
        ],
      },
      probeReport,
    );
    expect(report.localCredentials).toEqual([
      { providerId: "anthropic", kind: "subscription", expiresAt: null },
      { providerId: "openai", kind: "api_key", expiresAt: null },
    ]);
  });

  it("a credential read that fails reports none rather than failing the report", async () => {
    const report = await thisMacReport(
      {
        appVersion: "0.3.0",
        browser,
        credentials: async () => {
          throw new Error("the credential store is locked");
        },
      },
      probeReport,
    );
    expect(report.localCredentials).toEqual([]);
    expect(report.capabilities).toMatchObject({ power: { source: "unknown" } });
  });
});

describe("the local-credential availability list", () => {
  it("maps oauth to a subscription, drops unusable ids, dedupes, sorts and bounds", () => {
    const entries = [
      { providerId: "z", type: "api_key" as const },
      { providerId: "a", type: "oauth" as const },
      { providerId: "a", type: "api_key" as const },
      { providerId: "", type: "api_key" as const },
      { providerId: "x".repeat(256), type: "api_key" as const },
    ];
    expect(runnerLocalCredentials(entries)).toEqual([
      { providerId: "a", kind: "subscription", expiresAt: null },
      { providerId: "z", kind: "api_key", expiresAt: null },
    ]);
    const many = Array.from({ length: 70 }, (_, index) => ({
      providerId: `p${String(index).padStart(2, "0")}`,
      type: "api_key" as const,
    }));
    const bounded = runnerLocalCredentials(many);
    expect(bounded).toHaveLength(64);
    expect(bounded[0]?.providerId).toBe("p00");
    expect(bounded.at(-1)?.providerId).toBe("p63");
  });
});

describe("which launch makes this Mac a runner", () => {
  it("refuses to pair an embedded deployment with a hosted token exchange", () => {
    expect(() => createDesktopMacRunner({ deployment: "local" } as DesktopMacRunnerInput)).toThrow(
      "local runner token source",
    );
  });
  it("only a Volli Cloud launch with an HTTP actions origin; a local (and every flag-off) launch composes nothing", () => {
    expect(thisMacRunnerLaunch(LOCAL_LAUNCH)).toBeNull();
    // Main's own boot decision with the flag off: no marker is read, nothing is composed.
    const flagOff = chooseProductStore({
      cloudFlag: false,
      readMarker: () => {
        throw new Error("a flag-off boot reads no marker");
      },
      backendUrl: "https://a.convex.cloud",
      signInConfigured: true,
    });
    expect(thisMacRunnerLaunch(flagOff)).toBeNull();
    const cloud = { store: "cloud", userId: "u", backendUrl: "https://a.convex.cloud" } as const;
    expect(thisMacRunnerLaunch(cloud)).toBeNull();
    expect(thisMacRunnerLaunch({ ...cloud, siteUrl: "https://a.convex.site" })).toEqual({
      deployment: "cloud",
      userId: "u",
      backendUrl: "https://a.convex.cloud",
      siteUrl: "https://a.convex.site",
    });
  });
});

describe("the runners port", () => {
  it("refuses with the flag off, answers off without a runner, and passes through to one", async () => {
    let enabled = false;
    const off = runnerAccountPort(null, () => enabled);
    expect(() => off.thisMac()).toThrow(OperationUnavailableError);
    enabled = true;
    expect(off.thisMac()).toBe(THIS_MAC_RUNNER_OFF);
    const seen: unknown[] = [];
    (off.subscribeThisMac((snapshot) => seen.push(snapshot)) as () => void)();
    expect(seen).toEqual([THIS_MAC_RUNNER_OFF]);
    expect(() => off.addThisMac()).toThrow("Sign in");
    expect(() => off.removeThisMac()).toThrow("Sign in");

    const calls: string[] = [];
    const runner = {
      snapshot: () => ({ ...THIS_MAC_RUNNER_OFF, state: "online" }),
      subscribe: () => () => {},
      addThisMac: async () => void calls.push("add"),
      removeThisMac: async () => void calls.push("remove"),
    } as unknown as MacRunner;
    const on = runnerAccountPort(runner, () => enabled);
    expect((on.thisMac() as { state: string }).state).toBe("online");
    await on.addThisMac();
    await on.removeThisMac();
    expect(typeof on.subscribeThisMac(() => {})).toBe("function");
    expect(calls).toEqual(["add", "remove"]);
  });
});

const MOVE_USER = "11111111-1111-4111-8111-111111111111";
const MOVE_RUNNER = "22222222-2222-4222-8222-222222222222";
const MOVE_LINK = { runnerId: MOVE_RUNNER, name: "danas-mac", credential: "vrc_1", generation: 1 };

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((done) => setImmediate(done));
};

function signedIn(): AccountSnapshot {
  return {
    state: "signed-in",
    provider: "dev",
    failure: null,
    account: {
      displayName: "Dana",
      email: null,
      userId: MOVE_USER,
      deletionPurgeAfter: null,
      backend: "synced",
    },
  } as unknown as AccountSnapshot;
}

/**
 * The factory over its real ports: a sealed temp inventory already holding
 * this Mac's link (so nothing registers, which would run `scutil`/`ioreg`),
 * and a Convex client module that fails the test if a connection is opened.
 */
function moveInput(
  options: {
    registrationOnly?: boolean;
    sync?: RunnerConnectionDeps["sync"];
    onCloudClient?: () => void;
  } = {},
): {
  input: DesktopMacRunnerInput;
  dispose: () => void;
} {
  const temp = tempInventory();
  temp.inventory.put(
    "host-private",
    { purpose: runnerLinkPurpose(MOVE_USER) },
    JSON.stringify({ v: 1, ownerUserId: MOVE_USER, ...MOVE_LINK }),
  );
  const onCloudClient = options.onCloudClient ?? (() => {});
  return {
    dispose: temp.dispose,
    input: {
      deployment: "cloud",
      userId: MOVE_USER,
      backendUrl: "https://a.convex.cloud",
      siteUrl: "https://a.convex.site",
      convex: {
        ConvexClient: class {
          constructor() {
            onCloudClient();
          }
          setAuth() {}
          async mutation() {
            return null;
          }
          onUpdate() {
            return () => {};
          }
          connectionState() {
            return { isWebSocketConnected: false };
          }
          subscribeToConnectionState() {
            return () => {};
          }
          async close() {}
        },
        makeFunctionReference: (name: string) => name,
      },
      account: {
        subscribe(listener) {
          listener(signedIn());
          return () => {};
        },
        accessToken: async () => "person-token",
      },
      inventory: temp.inventory,
      unlockInventory: async () => {},
      recordRow: () => null,
      power: NO_POWER_EVENTS,
      liveWork: () => ({ turns: 0, shells: 0 }),
      dataDir: "/tmp/volli-move-runner",
      appVersion: "0.3.0",
      packaged: false,
      browser,
      log: { info: () => {}, warn: () => {} },
      ...(options.registrationOnly === true ? { registrationOnly: true } : {}),
      ...(options.sync === undefined ? {} : { sync: options.sync }),
    },
  };
}

describe("a registration-only runner (a local launch's move)", () => {
  it("forwards the mode through the factory: linked and offline, with no connection built", async () => {
    // `sync` is built once per connection the factory composes, so it says whether one was.
    const syncs: string[] = [];
    const sync: RunnerConnectionDeps["sync"] = (parts) => {
      syncs.push(parts.runnerId);
      return { start: () => {}, stop: async () => {}, close: async () => {}, waiting: () => 0 };
    };
    let cloudClients = 0;

    const only = moveInput({
      registrationOnly: true,
      sync,
      onCloudClient: () => (cloudClients += 1),
    });
    try {
      const runner = createDesktopMacRunner(only.input);
      runner.start();
      await flush();
      // Honest: linked, with the id a move records, and not connected.
      expect(runner.snapshot()).toMatchObject({
        state: "offline",
        runnerId: MOVE_RUNNER,
        runnerName: "danas-mac",
      });
      expect(syncs).toEqual([]);
      runner.refreshCapabilities();
      await runner.stop();
      expect(syncs).toEqual([]);
      expect(cloudClients).toBe(0);
    } finally {
      only.dispose();
    }

    // The same ports without the flag are a cloud launch's runner: it connects.
    const full = moveInput({ sync, onCloudClient: () => (cloudClients += 1) });
    try {
      const runner = createDesktopMacRunner(full.input);
      runner.start();
      await flush();
      expect(runner.snapshot().runnerId).toBe(MOVE_RUNNER);
      expect(cloudClients).toBe(1);
      expect(syncs).toEqual([MOVE_RUNNER]);
      await runner.stop();
    } finally {
      full.dispose();
    }
  });
});
