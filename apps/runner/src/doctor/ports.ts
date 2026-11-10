/**
 * What `volli-runner doctor` may touch on the box, behind ports.
 *
 * Every probe is a function a check calls and a test replaces, so the checks
 * run against a scripted box and never against the machine that happens to be
 * running the suite. Three rules hold for the live adapters, and they are the
 * reason this file exists rather than the checks reaching for `node:fs`:
 *
 * - **No credential leaves this file.** {@link readStoredCredentials} asks
 *   the runner's shared sealed-store metadata API and returns provider ids
 *   and kinds only. An unreadable store stays unknown; no key or token is
 *   returned and no exception containing a stored value is printed.
 * - **No message crosses the edge.** A failed probe becomes a status, an error
 *   code, or a boolean. A transport error's message can carry the box's
 *   `HTTPS_PROXY`, credentials and all, and a command's stderr can carry a
 *   token; neither is ever put in a report.
 * - **Nothing authenticates.** Every reachability request is a plain GET with
 *   no header of ours, so the answer is about the network, never a sign-in.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { setGlobalProxyFromEnv } from "node:http";

import { fileRunnerLinkStore } from "../link/file-store";
import type { RunnerDeployment } from "../link/deployment";
import { RunnerCredentialStore } from "../login/credential-store";
import { runnerModelKeyPath, type RunnerModelAccessOptions } from "../login/model-access";

/** One run of a program on the box: its exit status and stdout. Never its stderr. */
export interface RunAnswer {
  readonly status: number;
  readonly stdout: string;
}

/** What one unauthenticated GET to an origin said. */
export type ReachAnswer =
  | {
      readonly reachable: true;
      readonly status: number;
      /** The response's `Date` header, ms since epoch; `null` when it sent none. */
      readonly date: number | null;
    }
  | { readonly reachable: false; readonly reason: string };

/** One provider Pi's store holds a credential for. Without the credential. */
export interface StoredProvider {
  readonly providerId: string;
  readonly kind: "api-key" | "subscription";
}

/** Whether — never what — this box has signed in to a model provider. */
export type CredentialListing =
  | { readonly state: "listed"; readonly providers: readonly StoredProvider[] }
  | { readonly state: "unreadable" };

/** The runner link on disk, as `status` reports it. */
export type LinkFacts =
  | {
      readonly state: "linked";
      readonly name: string;
      readonly runnerId: string;
      readonly deployment: RunnerDeployment;
    }
  | { readonly state: "unlinked" }
  | { readonly state: "unreadable"; readonly error: string };

/** Everything `doctor` asks of the box. A test replaces all of it. */
export interface DoctorPorts {
  /** Node 24 proxy support for this command, restored after all parallel probes settle. */
  configureProxy(env: Readonly<Record<string, string | undefined>>): () => void;
  /** Runs a program: name and argv, never a shell, never a credential in argv. */
  run(command: string, args: readonly string[]): RunAnswer;
  /** One HTTPS GET, to answer "can this box reach that host at all?". */
  reach(url: string): Promise<ReachAnswer>;
  /** Free bytes on the filesystem holding `path`; `null` when it cannot be measured. */
  freeBytes(path: string): number | null;
  /** Whether `path` exists (systemd's runtime directory). */
  exists(path: string): boolean;
  /** The providers Pi's sealed store holds, by id and kind — never a value. */
  storedCredentials(options: RunnerModelAccessOptions): Promise<CredentialListing>;
  /** This box's link, or that it has none, or that it could not be read. */
  readLink(configDir: string): Promise<LinkFacts>;
}

/** A command that hangs is a doctor that hangs; `git --version` answers at once. */
const RUN_TIMEOUT_MS = 5_000;

/** Long enough for a slow VPS, short enough that one dead host does not strand the run. */
const REACH_TIMEOUT_MS = 5_000;

export function liveRun(command: string, args: readonly string[]): RunAnswer {
  const answer = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: RUN_TIMEOUT_MS,
  });
  return { status: answer.status ?? 1, stdout: answer.stdout ?? "" };
}

export function liveReach(url: string): Promise<ReachAnswer> {
  return reachWith(globalThis.fetch, url, REACH_TIMEOUT_MS);
}

/**
 * One GET, reduced to the two facts a check needs: did anything answer, and
 * what did its clock say.
 *
 * Any HTTP status is an answer — a 404 from a deployment's root still proves
 * the box reached it. Only a transport failure is `reachable: false`, and its
 * reason is a code (`ENOTFOUND`, `ECONNREFUSED`, `timed out`) rather than the
 * error's message, which can quote the proxy URL it failed through.
 */
export async function reachWith(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
): Promise<ReachAnswer> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = response.body;
    if (body !== null) await body.cancel().catch(() => undefined);
    const date = Date.parse(response.headers.get("date") ?? "");
    return { reachable: true, status: response.status, date: Number.isFinite(date) ? date : null };
  } catch (error) {
    return { reachable: false, reason: failureCode(error) };
  }
}

function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const cause = (error as { cause?: unknown }).cause;
    if (typeof cause === "object" && cause !== null) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    if ((error as { name?: unknown }).name === "TimeoutError") return "timed out";
  }
  return "no answer";
}

export function liveFreeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export async function liveReadLink(configDir: string): Promise<LinkFacts> {
  try {
    const stored = await fileRunnerLinkStore({ configDir }).read();
    if (stored === null) return { state: "unlinked" };
    return {
      state: "linked",
      name: stored.link.name,
      runnerId: stored.link.runnerId,
      deployment: stored.deployment,
    };
  } catch (error) {
    return { state: "unreadable", error: (error as Error).message };
  }
}

/** Use exactly the sealed store and key resolver that login and the daemon share. */
export async function readStoredCredentials(
  options: RunnerModelAccessOptions,
  uid = process.getuid!(),
): Promise<CredentialListing> {
  // Root must not create root-owned credential-operation locks in the service's
  // data directory. `login --status` knows how to hand off to the service uid.
  if (uid === 0) return { state: "unreadable" };
  if (!existsSync(options.dataDir)) return { state: "listed", providers: [] };
  try {
    const store = new RunnerCredentialStore(options.dataDir, runnerModelKeyPath(options));
    const rows = await store.list();
    return {
      state: "listed",
      providers: rows
        .map<StoredProvider>((row) => ({
          providerId: row.providerId,
          kind: row.type === "api_key" ? "api-key" : "subscription",
        }))
        .toSorted((left, right) => left.providerId.localeCompare(right.providerId)),
    };
  } catch {
    return { state: "unreadable" };
  }
}

/** The live box: the programs on it, its network, its disk and Pi's store. */
export const LIVE_DOCTOR_PORTS: DoctorPorts = {
  configureProxy: setGlobalProxyFromEnv,
  run: liveRun,
  reach: liveReach,
  freeBytes: liveFreeBytes,
  exists: existsSync,
  storedCredentials: readStoredCredentials,
  readLink: liveReadLink,
};
