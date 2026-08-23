/**
 * Whether this profile exports agent telemetry, and the sink the runtime holds
 * either way (VC-119, Phase 2).
 *
 * **Off is the default and the resting state.** A profile that has never touched
 * this setting exports nothing, and "nothing" is `NOOP_OBSERVABILITY_SINK` — the
 * same value Phase 1 shipped — rather than an exporter pointed at a collector
 * that is not there. There is no ambient way to switch it on: no `OTEL_*`
 * variable is read, so telemetry starts when a person asks for it in Settings
 * and at no other time.
 *
 * **The owner is the sink.** The runtime is handed this object once at boot and
 * keeps it for the life of the process, so turning export on or off is a field
 * swap here rather than a restart. Live Sessions pick up the change on their
 * next event, which is the behaviour every other Settings switch in the app has.
 *
 * **A problem is stated once.** Two things can go wrong and they are different
 * failures. An address that is not one is refused at the moment it is typed, so
 * it never becomes a stored setting. A well-formed address with nothing behind
 * it can only be discovered by trying, so the first delivery that does not land
 * is latched into {@link AgentObservabilityView.problem} and every later one is
 * ignored — a collector that has gone away fails on every batch, and reporting
 * each would be the repeated toast this design exists to prevent. Nothing here
 * ever raises anything at a turn.
 */

import type Database from "better-sqlite3";
import {
  NOOP_OBSERVABILITY_SINK,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "@volli/shared";

import { setAppState } from "../db/app-state-repo";
import { prepared } from "../db/prepared";
import { OtlpObservabilityExporter, type OtlpExporterOptions } from "./otlp";
import { QueuedObservabilitySink, type ObservabilityExporter } from "./sink";

/** One JSON object holding the switch and the address it points at. */
export const AGENT_OBSERVABILITY_APP_STATE_KEY = "volli:agent-observability";

/**
 * Jaeger all-in-one's OTLP/HTTP port, which is the smoke path this ships with.
 * A default address is not a default decision: nothing is sent until the switch
 * is on.
 */
export const DEFAULT_COLLECTOR_ENDPOINT = "http://localhost:4318";

/** How long shutdown will wait for the last batch before letting the app quit. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 2000;

/** What Settings draws. Carries no address credentials, because none can be stored. */
export interface AgentObservabilityView {
  enabled: boolean;
  endpoint: string;
  /** `failed` means enabled but not delivering — the state {@link problem} explains. */
  status: "off" | "exporting" | "failed";
  /** One sentence, latched. Null when there is nothing to say. */
  problem: string | null;
}

/** A refusal a person reads in Settings. */
export class AgentObservabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentObservabilityError";
  }
}

/** An address this profile could actually export to, or the reason it is not one. */
export type EndpointAdmission =
  | { outcome: "admit"; endpoint: string }
  | { outcome: "refuse"; reason: string };

/**
 * Whether a typed collector address may be stored, and in what form.
 *
 * Normalized to its origin, and stored that way. The exporter resolves
 * `/v1/traces` against the origin, so a path typed here would be silently
 * discarded at send time — and a setting that displays one string while using
 * another is a setting that cannot be debugged. Refusing the path outright, and
 * saving what was validated, keeps the two the same string.
 *
 * Credentials in the address are refused rather than stripped. `http://user:pw@…`
 * is a secret in a field that is stored in the clear, read back by Settings, and
 * shown on screen; there is no version of accepting it that is not a leak.
 */
export function admitCollectorEndpoint(typed: string): EndpointAdmission {
  const trimmed = typed.trim();
  if (trimmed === "") return { outcome: "refuse", reason: "Enter your collector's address." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { outcome: "refuse", reason: "This is not a valid address." };
  }
  // The host is not checked separately: `http:` and `https:` are WHATWG
  // "special" schemes, whose parser refuses an empty authority outright, so
  // anything that reached here and is HTTP already names a host.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { outcome: "refuse", reason: "The address must start with http:// or https://." };
  }
  if (url.username !== "" || url.password !== "") {
    return { outcome: "refuse", reason: "Remove the username and password from the address." };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return {
      outcome: "refuse",
      reason:
        "Enter the collector's address only, with no path — for example http://localhost:4318.",
    };
  }
  return { outcome: "admit", endpoint: url.origin };
}

/** The stored shape, as it is written and as it is read back. */
interface StoredSettings {
  enabled: boolean;
  endpoint: string;
}

export interface AgentObservabilityOptions {
  db: Database.Database;
  /** Stamped onto every span's resource so one collector can serve several builds. */
  serviceVersion: string;
  now?: () => number;
  /** Injected in tests so nothing has to open a socket, and to script a refusal. */
  createExporter?: (options: OtlpExporterOptions) => ObservabilityExporter;
}

/**
 * The one owner: the stored setting, the live sink, and the latched problem.
 *
 * Implements {@link ObservabilitySink} itself so the runtime can be given a
 * stable reference at boot. `record` delegates without a `try`, deliberately:
 * both possible delegates — the no-op and {@link QueuedObservabilitySink} —
 * are non-throwing by contract, and the runtime's own tee already swallows
 * anything that escapes. A second catch here would only hide a broken delegate.
 */
export class AgentObservability implements ObservabilitySink {
  readonly #db: Database.Database;
  readonly #serviceVersion: string;
  readonly #now: () => number;
  readonly #createExporter: (options: OtlpExporterOptions) => ObservabilityExporter;
  #sink: ObservabilitySink = NOOP_OBSERVABILITY_SINK;
  #live: QueuedObservabilitySink | null = null;
  #problem: string | null = null;

  constructor(options: AgentObservabilityOptions) {
    this.#db = options.db;
    this.#serviceVersion = options.serviceVersion;
    this.#now = options.now ?? Date.now;
    this.#createExporter =
      options.createExporter ??
      ((exporterOptions) => new OtlpObservabilityExporter(exporterOptions));
  }

  /** The agent path's entry point. Constant-time, non-throwing, side-channel only. */
  record(event: ObservabilityEvent): void {
    this.#sink.record(event);
  }

  /**
   * Bring the stored setting into effect. Called once, at boot.
   *
   * A stored setting that will not start is the one case where a problem exists
   * before anybody has touched Settings this launch — a collector address that
   * has become unparsable in the database, say. It latches and the app carries
   * on exporting nothing, because a telemetry setting is not a reason to fail a
   * launch.
   */
  start(): void {
    const stored = this.#read();
    if (!stored.enabled) return;
    this.#open(stored.endpoint);
  }

  /** The renderer's whole picture. */
  view(): AgentObservabilityView {
    const stored = this.#read();
    return {
      enabled: stored.enabled,
      endpoint: stored.endpoint,
      status: !stored.enabled
        ? "off"
        : this.#live === null || this.#problem !== null
          ? "failed"
          : "exporting",
      problem: this.#problem,
    };
  }

  /**
   * Record the decision a person made, and act on it now.
   *
   * The endpoint is judged before it is stored, so a refusal is a correction to
   * what was just typed rather than a mystery six hours later. Saving anything
   * clears the latched problem: the person has changed the configuration, so
   * whatever was true of the last one is no longer the thing to show them.
   */
  configure(input: { enabled: boolean; endpoint: string }): AgentObservabilityView {
    const admission = admitCollectorEndpoint(input.endpoint);
    if (admission.outcome === "refuse") throw new AgentObservabilityError(admission.reason);
    this.#write({ enabled: input.enabled, endpoint: admission.endpoint });
    this.#problem = null;
    this.#close();
    if (input.enabled) this.#open(admission.endpoint);
    return this.view();
  }

  /**
   * Push the last batch and release the transport, within a bounded wait.
   *
   * The only place a flush happens, and it is a controlled shutdown by
   * construction: nothing on the agent path can reach it, and the bound means a
   * collector that has stopped answering delays the quit by two seconds rather
   * than holding it.
   */
  async shutdown(timeoutMs: number = SHUTDOWN_FLUSH_TIMEOUT_MS): Promise<void> {
    const live = this.#live;
    this.#live = null;
    this.#sink = NOOP_OBSERVABILITY_SINK;
    if (live === null) return;
    try {
      await live.shutdown(timeoutMs);
    } catch {
      // Telemetry does not get to fail a quit.
    }
  }

  /**
   * Build the transport, or latch why it could not be built.
   *
   * The throw this catches is a configuration failure — an address the SDK
   * refuses, a transport it cannot construct — which is exactly the class of
   * thing Settings should say once. Everything after a successful construction
   * is a delivery question, answered by the same latch through
   * `onDeliveryFailure`.
   */
  #open(endpoint: string): void {
    try {
      const exporter = this.#createExporter({
        endpoint,
        serviceVersion: this.#serviceVersion,
        onDeliveryFailure: () => this.#reportProblem(DELIVERY_PROBLEM),
      });
      this.#live = new QueuedObservabilitySink({ exporter, now: this.#now });
      this.#sink = this.#live;
    } catch {
      // The reason is deliberately not the SDK's message: it is prose from a
      // dependency, shown on a settings page, and it says nothing a person can
      // act on that this sentence does not.
      this.#reportProblem(SETUP_PROBLEM);
    }
  }

  /** Tear down without waiting: a reconfigure must not block the settings write. */
  #close(): void {
    const live = this.#live;
    this.#live = null;
    this.#sink = NOOP_OBSERVABILITY_SINK;
    if (live !== null) void live.shutdown(SHUTDOWN_FLUSH_TIMEOUT_MS).catch(() => undefined);
  }

  /** First problem wins. The latch is the whole of "surfaces once". */
  #reportProblem(problem: string): void {
    this.#problem ??= problem;
  }

  /**
   * The stored setting, or the default a profile that configured nothing has.
   *
   * Every field is sanitized independently and an unreadable one falls back
   * rather than repairing: a corrupt row must not be able to turn export on,
   * which is why `enabled` is true only for a literal `true`.
   */
  #read(): StoredSettings {
    const row = prepared<[string], { value: string }>(
      this.#db,
      "SELECT value FROM app_state WHERE key = ?",
    ).get(AGENT_OBSERVABILITY_APP_STATE_KEY);
    if (row === undefined) return { enabled: false, endpoint: DEFAULT_COLLECTOR_ENDPOINT };
    let stored: unknown;
    try {
      stored = JSON.parse(row.value);
    } catch {
      return { enabled: false, endpoint: DEFAULT_COLLECTOR_ENDPOINT };
    }
    if (typeof stored !== "object" || stored === null) {
      return { enabled: false, endpoint: DEFAULT_COLLECTOR_ENDPOINT };
    }
    const candidate = stored as Record<string, unknown>;
    const endpoint = candidate["endpoint"];
    const admission = typeof endpoint === "string" ? admitCollectorEndpoint(endpoint) : null;
    return {
      enabled: candidate["enabled"] === true,
      endpoint: admission?.outcome === "admit" ? admission.endpoint : DEFAULT_COLLECTOR_ENDPOINT,
    };
  }

  #write(settings: StoredSettings): void {
    setAppState(this.#db, AGENT_OBSERVABILITY_APP_STATE_KEY, JSON.stringify(settings), this.#now());
  }
}

/**
 * The two sentences Settings can show.
 *
 * Neither names a dependency, a stack, or an address: a person's recovery is the
 * same in both cases — check the collector, or turn it off — and everything else
 * belongs in a log.
 */
const SETUP_PROBLEM = "Volli could not start exporting to this address.";
const DELIVERY_PROBLEM = "Nothing is answering at this address.";
