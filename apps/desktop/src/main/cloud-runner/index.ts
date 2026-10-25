/**
 * This Mac as a Volli Cloud runner (VC-895), composed for desktop main: the
 * Mac runner (`./mac-runner.ts`) over the sealed link store, the non-secret
 * record, the person's backend calls and the runner connection, plus the
 * handler map's `RunnerAccountPort` over it.
 *
 * Composed only in a Volli Cloud launch (`../cloud-launch.ts`): a launch that
 * shows this Mac's own projects runs nothing here, and with the `cloud` flag
 * off every `runners.*` entry answers unavailable. A cloud launch reads the
 * sealed store at boot, because a runner has to connect without a window:
 * that is one unattended keychain read, only for a person who signed in with
 * the flag on.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";

import {
  convexBackendConnection,
  probeRunnerCapabilities,
  readRunnerLoad,
  runnerHostFacts,
  type ConvexClientModule,
} from "@volli/host-core/cloud-runner";
import type { RunnerAccountPort } from "@volli/host-core/handlers";
import type { PowerPort } from "@volli/host-core/ports";
import type { HostLiveWork } from "@volli/host-core/sessions";
import { OperationUnavailableError, THIS_MAC_RUNNER_OFF, type CloudLaunch } from "@volli/shared";
import type { RunnerBrowserCapability } from "@volli/shared/cloud";

import { convexMacRunnerBackend } from "./backend";
import { runnerConnector } from "./connection";
import { inventoryRunnerLinkStore, type RunnerLinkInventory } from "./identity-store";
import { createMacRunner, type MacRunner, type MacRunnerAccount } from "./mac-runner";
import { runnerRecordStore, type RunnerRecordRow } from "./record";

export { CLOUD_RUNNER_APP_STATE_KEY } from "./record";
export { holdWhileTurnsRun, NO_POWER_BLOCKER } from "./power";
export type { MacRunner } from "./mac-runner";

/** `scutil --get ComputerName` ("Dana's MacBook Pro"), or `null` when it does not answer. */
function computerName(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((done) => {
    execFile("scutil", ["--get", "ComputerName"], { timeout: 5_000 }, (error, stdout) => {
      const name = error ? "" : stdout.trim();
      done(name === "" ? null : name);
    });
  });
}

/**
 * This machine, stably: a hash of the Mac's hardware UUID (`IOPlatformUUID`),
 * which a restored profile or a renamed host does not change; the hostname
 * where it cannot be read. Hashed, so the record never holds the hardware id.
 */
export function thisMachineId(): Promise<string> {
  const hashed = (value: string) =>
    createHash("sha256").update(`volli-runner-machine:${value}`).digest("hex").slice(0, 32);
  if (process.platform !== "darwin") return Promise.resolve(hashed(os.hostname()));
  return new Promise((done) => {
    execFile(
      "ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      { timeout: 5_000 },
      (error, stdout) => {
        const uuid = error ? null : /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(stdout)?.[1];
        done(hashed(uuid ?? os.hostname()));
      },
    );
  });
}

/** The name this Mac asks for: its computer name, else its hostname; `-dev` for an unpackaged build. */
export async function thisMacName(packaged: boolean): Promise<string> {
  const base = (await computerName()) ?? os.hostname().replace(/\.local$/u, "");
  return packaged ? base : `${base}-dev`;
}

/**
 * The deployment's HTTP actions origin, where a runner exchanges its
 * credential (`/runner/token`): a cloud deployment's `.convex.site` twin of
 * its `.convex.cloud` URL. An unpackaged build may name it instead
 * (`VOLLI_CONVEX_SITE_URL`, which the local backend fixture hands what it
 * runs, since a local backend serves it on its own port). `null`: none.
 */
export function resolveRunnerSiteUrl(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly packaged: boolean;
  readonly backendUrl: string | null;
}): string | null {
  const named = input.packaged ? undefined : input.env["VOLLI_CONVEX_SITE_URL"]?.trim();
  if (named !== undefined && named !== "") {
    try {
      const url = new URL(named);
      if (url.protocol === "https:" || url.protocol === "http:") return named;
    } catch {
      // Not a URL: fall through to the derived one.
    }
  }
  if (input.backendUrl === null) return null;
  try {
    const url = new URL(input.backendUrl);
    if (!url.hostname.endsWith(".convex.cloud")) return null;
    url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Whether this launch makes this Mac a runner, and for whom: only a Volli
 * Cloud launch (the flag on, a signed-in marker, a backend) with an HTTP
 * actions origin. Every other launch, flag-off ones first, composes nothing.
 */
export function thisMacRunnerLaunch(
  launch: CloudLaunch,
  siteUrl: string | null,
): { userId: string; backendUrl: string; siteUrl: string } | null {
  if (launch.store !== "cloud" || siteUrl === null) return null;
  return { userId: launch.userId, backendUrl: launch.backendUrl, siteUrl };
}

export interface DesktopMacRunnerInput {
  readonly userId: string;
  /** The deployment (`https://<deployment>.convex.cloud`). */
  readonly backendUrl: string;
  /** Its HTTP actions origin (`https://<deployment>.convex.site`). */
  readonly siteUrl: string;
  /** `convex/browser`'s client and `convex/server`'s references, from the composition root. */
  readonly convex: ConvexClientModule;
  readonly account: MacRunnerAccount;
  readonly inventory: RunnerLinkInventory;
  readonly unlockInventory: () => Promise<void>;
  readonly recordRow: () => RunnerRecordRow | null;
  readonly power: PowerPort;
  readonly liveWork: () => HostLiveWork;
  readonly dataDir: string;
  readonly appVersion: string;
  readonly packaged: boolean;
  /** The agent browser, as Sessions here can use it now (closed while in the menu bar). */
  readonly browser: () => RunnerBrowserCapability;
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createDesktopMacRunner(input: DesktopMacRunnerInput): MacRunner {
  return createMacRunner({
    userId: input.userId,
    account: input.account,
    store: inventoryRunnerLinkStore(input.inventory, input.unlockInventory, input.userId),
    record: runnerRecordStore(input.recordRow, input.userId, input.log),
    backend: convexMacRunnerBackend({ url: input.backendUrl }),
    connect: runnerConnector({
      siteUrl: input.siteUrl,
      connect: convexBackendConnection(input.backendUrl, input.convex),
      bootId: randomUUID(),
      readLoad: () => {
        const work = input.liveWork();
        return readRunnerLoad(
          { activeSessions: work.turns, activeTurns: work.turns, queueDepth: 0 },
          input.dataDir,
        );
      },
      readCapabilities: () =>
        probeRunnerCapabilities({
          version: input.appVersion,
          installMode: "app",
          terminals: true,
          browser: input.browser(),
          docker: false,
          maxConcurrentSessions: Math.max(1, os.availableParallelism()),
          tools: [],
          localCredentials: [],
        }),
      log: input.log,
    }),
    host: async () => ({
      facts: runnerHostFacts("app"),
      name: await thisMacName(input.packaged),
    }),
    machine: thisMachineId,
    power: input.power,
    log: input.log,
  });
}

/**
 * The handler map's `runners.*` port. `runner` is `null` in a launch that is
 * not a Volli Cloud one: its snapshot is `off` and it changes nothing.
 */
export function runnerAccountPort(
  runner: MacRunner | null,
  enabled: () => boolean,
): RunnerAccountPort {
  const live = (): MacRunner | null => {
    if (!enabled()) {
      throw new OperationUnavailableError(
        "Volli Cloud is off. Turn it on in Settings → Experimental.",
      );
    }
    return runner;
  };
  const required = (): MacRunner => {
    const value = live();
    if (value === null) {
      throw new OperationUnavailableError("Sign in to Volli Cloud to make this Mac a runner.");
    }
    return value;
  };
  return {
    thisMac: () => live()?.snapshot() ?? THIS_MAC_RUNNER_OFF,
    subscribeThisMac(listener) {
      const value = live();
      if (value === null) {
        listener(THIS_MAC_RUNNER_OFF);
        return () => {};
      }
      return value.subscribe(listener);
    },
    addThisMac: () => required().addThisMac(),
    removeThisMac: () => required().removeThisMac(),
  };
}
