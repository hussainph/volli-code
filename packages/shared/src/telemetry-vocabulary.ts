/**
 * The telemetry vocabulary Volli's own destination may receive (VC-505).
 *
 * {@link ObservabilityEvent} (VC-119) is the Agent Runtime's side channel to a
 * collector the user chose. This is the narrower vocabulary for the one Volli
 * operates: app-level signals (launch, renderer crashes, feature use) plus two
 * on-device summaries of the runtime's events — an hourly per-Session rollup
 * and a sampled turn. Raw per-call events never leave the device for Volli's
 * destination; the rollup is what turns them into counts.
 *
 * **The schema is the vocabulary.** {@link TELEMETRY_EVENTS} is a value, and
 * every event type below is derived from it, so the generated docs page
 * (`docs/telemetry.md`, `scripts/generate-telemetry-fields.mjs --check`), the
 * TypeScript types and {@link isTelemetryEvent} cannot describe different
 * events. A field can only be declared as one of the {@link TelemetryFieldSpec}
 * shapes, and none of them is a free string:
 *
 * - a closed word, from an `as const` list;
 * - a count, an integer, a duration or a sample rate;
 * - a flag;
 * - a catalog id ({@link TelemetryCatalogId}): a configuration identifier that
 *   only a narrowing function can mint, and that falls back to a fixed word
 *   when the value is not in the catalog — never to a truncated or hashed
 *   version of it;
 * - a tally (closed word → count) or rows of the above.
 *
 * So the privacy property is enforced by construction, as in VC-119, rather
 * than by a redaction pass. A type test in this package fails if any leaf of
 * {@link TelemetryEvent} widens to `string`.
 *
 * Property names reuse the `gen_ai.*` attribute names the OTLP mapping in
 * host-core already speaks where the two overlap, so field telemetry, the
 * user's own collector and offline evals can share metric names.
 */

import {
  ATTEMPT_STOP_REASONS,
  OBSERVED_TOOL_IDS,
  PROVIDER_ERROR_CLASSES,
} from "./agent-observability";
import {
  COMPACTION_REASONS,
  RUNTIME_ATTENTION_REASONS,
  RUNTIME_FAILURE_REASONS,
} from "./agent-runtime";
import { ACTIVITY_KINDS } from "./session-activity";

// ── Closed word lists ────────────────────────────────────────────────────────

/** How this launch relates to the previous one on this install. */
export const LAUNCH_KINDS = ["first-run", "update", "normal"] as const;

export type LaunchKind = (typeof LAUNCH_KINDS)[number];

/** The release channel the running build was published on. */
export const RELEASE_CHANNELS = ["release", "canary"] as const;

export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** `process.platform`, for the platforms Volli builds for. */
export const TELEMETRY_PLATFORMS = ["darwin", "linux", "win32"] as const;

export type TelemetryPlatform = (typeof TELEMETRY_PLATFORMS)[number];

/** `process.arch`, with anything Volli does not build for collapsed to `other`. */
export const TELEMETRY_ARCHES = ["arm64", "x64", "other"] as const;

export type TelemetryArch = (typeof TELEMETRY_ARCHES)[number];

/**
 * Electron's `render-process-gone` reasons, quoted from its typings, plus
 * `unknown` for a reason a newer Electron adds before this list learns it.
 */
export const RENDERER_GONE_REASONS = [
  "clean-exit",
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "launch-failed",
  "integrity-failure",
  "memory-eviction",
  "unknown",
] as const;

export type RendererGoneReason = (typeof RENDERER_GONE_REASONS)[number];

/** How a turn ended — the two outcomes {@link TurnEvent} already reports. */
export const TURN_OUTCOMES = ["completed", "interrupted"] as const;

export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** How a compaction ended — the two outcomes {@link CompactionEvent} already reports. */
export const COMPACTION_OUTCOMES = ["compacted", "failed"] as const;

/** Where a Runner runs. */
export const RUNNER_KINDS = ["mac", "linux", "cloud"] as const;

export type RunnerKind = (typeof RUNNER_KINDS)[number];

/**
 * Why the telemetry pipeline itself lost an event, counted in the next rollup.
 *
 * `queue-full` and `sink-error` are {@link DroppedEvent}'s. The exporter adds
 * two of its own: a crash report the scrubber threw on (dropped, never sent
 * unscrubbed), and a batch that was still undeliverable when its retry window
 * closed.
 */
export const TELEMETRY_DROP_REASONS = [
  "queue-full",
  "sink-error",
  "scrubber-error",
  "expired",
] as const;

/**
 * The product features whose use is counted, as a closed list.
 *
 * Each id names a person's deliberate action, never its subject: the event says
 * a ticket was created, not which or where. Add an id when a feature ships;
 * never rename or reuse one, because dashboards key on these strings.
 */
export const FEATURE_IDS = [
  "board-create-ticket",
  "board-move-ticket",
  "ticket-open",
  "session-start",
  "session-resume",
  "composer-send",
  "composer-attach",
  "model-switch",
  "terminal-open",
  "browser-open",
  "file-open",
  "change-set-open",
  "worktree-archive",
  "automation-arm",
  "automation-run",
  "runner-link",
  "workspace-switch",
  "workspace-invite",
  "project-create",
  "project-add-existing",
  "provider-sign-in",
  "mcp-server-add",
  "attention-open",
  "command-palette-open",
  "settings-open",
  "canvas-edit",
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

/**
 * ISO 3166-1 alpha-2, the 249 officially assigned codes.
 *
 * What Electron's `app.getLocaleCountryCode()` reports, narrowed to the codes
 * ISO actually assigns: a user-assigned code (`XK`), a UN M.49 area (`419`) or
 * an empty string is not a country this list can speak, and reads as unknown.
 */
export const ISO_REGION_CODES = [
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
] as const;

export type IsoRegionCode = (typeof ISO_REGION_CODES)[number];

/**
 * Error codes a crash report may name in place of the error's message.
 *
 * A crash report keeps its stack but drops every exception message, because a
 * message is prose that can carry a path, a command or a credential. The one
 * exception is a Volli typed error whose `code` is on this list: the report
 * then carries the code alone. Each entry is the literal `code` of an error
 * class Volli ships; add one only by quoting such a class.
 */
export const REPORTABLE_ERROR_CODES = [
  "client-capability-unavailable",
  "credential-key-pending",
  "credential-lock-busy",
  "credential-lock-unusable",
  "credential-revision-conflict",
  "invalid_id",
  "invalid_key_part",
  "invalid_position",
  "malformed_actor",
  "sealed-file-changed",
  "sealed-file-indeterminate",
  "sealed-file-unverified",
  "secret-key-unavailable",
  "trash-unavailable",
] as const;

export type ReportableErrorCode = (typeof REPORTABLE_ERROR_CODES)[number];

// ── Catalog ids ──────────────────────────────────────────────────────────────

/** The configuration catalogs a telemetry field may name an entry of. */
export type TelemetryCatalogKind = "provider" | "model" | "version";

declare const catalogBrand: unique symbol;

/**
 * An identifier from a closed catalog, branded so only a narrowing function in
 * this module can produce one: {@link catalogModelRef} for providers and
 * models, {@link telemetryVersion} for versions. A plain `string` is not
 * assignable to it, so an unnarrowed value cannot reach a telemetry event
 * without a cast a reviewer would see.
 */
export type TelemetryCatalogId<K extends TelemetryCatalogKind> = string & {
  readonly [catalogBrand]: K;
};

export type CatalogProviderId = TelemetryCatalogId<"provider">;
export type CatalogModelId = TelemetryCatalogId<"model">;
export type TelemetryVersion = TelemetryCatalogId<"version">;

/** What a provider or model outside the catalog is reported as. */
export const CUSTOM_CATALOG_ID = "custom";

/** What a version that is not a release version string is reported as. */
export const UNKNOWN_VERSION = "unknown";

/**
 * The model catalog Volli ships: provider id → that provider's model ids.
 *
 * It must be built from Pi's built-in catalog (and the publisher feed that
 * refreshes it), never from the merged registry. A user's `models.json` can
 * add a provider, and can add a model under a built-in provider, with any name
 * at all — `acme-internal-llm` belongs in their own collector, not ours.
 */
export type TelemetryModelCatalog = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Bounds on a catalog id even when the catalog vouches for it: the charset
 * catalog ids actually use, and a length no real one approaches. A catalog
 * entry outside them is reported as custom, the same as one not listed.
 */
const CATALOG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** A release version string: `x.y.z`, optionally with one numbered prerelease tag. */
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:canary|beta|rc)\.\d{1,4})?$/;

/**
 * A provider/model pair as the catalog's own ids, or `custom`.
 *
 * The narrowing is the privacy boundary, as {@link observedToolId} is for
 * tools: a model the catalog does not list under that provider is not
 * truncated or hashed, it is reported as `custom`. A custom provider makes the
 * model custom too, whatever it is called.
 */
export function catalogModelRef(
  catalog: TelemetryModelCatalog,
  providerId: unknown,
  modelId: unknown,
): {
  provider: CatalogProviderId | typeof CUSTOM_CATALOG_ID;
  model: CatalogModelId | typeof CUSTOM_CATALOG_ID;
} {
  const models = isCatalogId(providerId) ? catalog.get(providerId) : undefined;
  if (models === undefined) return { provider: CUSTOM_CATALOG_ID, model: CUSTOM_CATALOG_ID };
  return {
    provider: providerId as CatalogProviderId,
    model:
      isCatalogId(modelId) && models.has(modelId) ? (modelId as CatalogModelId) : CUSTOM_CATALOG_ID,
  };
}

/** A build's version as a release version string, or `unknown`. */
export function telemetryVersion(value: unknown): TelemetryVersion | typeof UNKNOWN_VERSION {
  return typeof value === "string" && VERSION_PATTERN.test(value)
    ? (value as TelemetryVersion)
    : UNKNOWN_VERSION;
}

function isCatalogId(value: unknown): value is string {
  return typeof value === "string" && CATALOG_ID_PATTERN.test(value);
}

// ── Narrowing ────────────────────────────────────────────────────────────────

/**
 * A value as one word of a closed list, or nothing.
 *
 * The general form of every narrowing here: a value off the list is absent,
 * never passed through, so the caller picks the fallback word (`other`,
 * `unknown`) or leaves the field out.
 */
export function closedWord<const V extends readonly string[]>(
  values: V,
  value: unknown,
): V[number] | undefined {
  return typeof value === "string" && values.includes(value) ? (value as V[number]) : undefined;
}

/** An OS-reported country as an ISO 3166-1 alpha-2 code, or nothing. */
export function isoRegionCode(value: unknown): IsoRegionCode | undefined {
  return typeof value === "string"
    ? closedWord(ISO_REGION_CODES, value.trim().toUpperCase())
    : undefined;
}

/**
 * A thrown value's code, when it is one a crash report may name.
 *
 * Reads `code` off an object only; a message is never consulted, and a code
 * off the list is as absent as no code at all.
 */
export function reportableErrorCode(error: unknown): ReportableErrorCode | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? closedWord(REPORTABLE_ERROR_CODES, error.code)
    : undefined;
}

// ── Schema ───────────────────────────────────────────────────────────────────

/** Every field shape a telemetry event may declare. There is no free-string shape. */
export type TelemetryFieldSpec =
  | {
      readonly type: "word";
      readonly values: readonly string[];
      /** Printed in the docs instead of the values, for a list too long to read. */
      readonly summary?: string;
      readonly optional?: boolean;
      readonly doc: string;
    }
  | {
      /** count: integer ≥ 0. integer: any safe integer. duration: ms ≥ 0. rate: 0 < x ≤ 1. */
      readonly type: "count" | "integer" | "duration" | "rate" | "flag";
      readonly optional?: boolean;
      readonly doc: string;
    }
  | {
      readonly type: "catalog";
      readonly catalog: TelemetryCatalogKind;
      readonly optional?: boolean;
      readonly doc: string;
    }
  | {
      /** A count per word, with words that counted nothing left out. */
      readonly type: "tally";
      readonly keys: readonly string[];
      readonly optional?: boolean;
      readonly doc: string;
    }
  | {
      readonly type: "rows";
      readonly fields: Readonly<Record<string, TelemetryFieldSpec>>;
      readonly optional?: boolean;
      readonly doc: string;
    };

export interface TelemetryEventSpec {
  readonly doc: string;
  readonly fields: Readonly<Record<string, TelemetryFieldSpec>>;
}

/** Upper bound on a `rows` field's length; a rollup that would exceed it is split. */
export const MAX_TELEMETRY_ROWS = 256;

const TOKEN_FIELDS = {
  "gen_ai.usage.input_tokens": { type: "count", doc: "Uncached input tokens, summed." },
  "gen_ai.usage.output_tokens": { type: "count", doc: "Output tokens, summed." },
  "gen_ai.usage.cache_read.input_tokens": {
    type: "count",
    doc: "Input tokens served from the provider's cache, summed.",
  },
  "gen_ai.usage.cache_creation.input_tokens": {
    type: "count",
    doc: "Input tokens written to the provider's cache, summed.",
  },
  "gen_ai.usage.reasoning.output_tokens": {
    type: "count",
    doc: "Reasoning tokens, summed.",
  },
} as const satisfies Record<string, TelemetryFieldSpec>;

/**
 * Every event Volli's own telemetry destination may receive, and every field of
 * each. A field that is not here is never sent.
 */
export const TELEMETRY_EVENTS = {
  app_started: {
    doc: "Once per launch, when the first window has shown.",
    fields: {
      cold_start_ms: {
        type: "duration",
        doc: "Process start to first window shown.",
      },
      launch: {
        type: "word",
        values: LAUNCH_KINDS,
        doc: "First launch of this install, first launch of a new version, or neither.",
      },
      app_version: { type: "catalog", catalog: "version", doc: "The running build's version." },
      channel: { type: "word", values: RELEASE_CHANNELS, doc: "The build's release channel." },
      os: { type: "word", values: TELEMETRY_PLATFORMS, doc: "Operating system." },
      os_version_major: { type: "count", doc: "Operating system major version." },
      arch: { type: "word", values: TELEMETRY_ARCHES, doc: "CPU architecture." },
      os_region: {
        type: "word",
        values: ISO_REGION_CODES,
        summary: "An ISO 3166-1 alpha-2 country code",
        optional: true,
        doc: "The country the operating system's region setting names. Absent when it names none.",
      },
      signed_in: { type: "flag", doc: "Whether a Volli account is signed in." },
    },
  },
  renderer_gone: {
    doc: "A window's renderer process ended unexpectedly.",
    fields: {
      reason: { type: "word", values: RENDERER_GONE_REASONS, doc: "Electron's reason." },
      exit_code: { type: "integer", doc: "The process exit code." },
    },
  },
  feature_used: {
    doc: "A person used a product feature. Says which feature, never what it was used on.",
    fields: {
      feature: { type: "word", values: FEATURE_IDS, doc: "The feature." },
    },
  },
  agent_rollup: {
    doc: "One per Session per hour of agent activity: the Agent Runtime's events, summed on the device.",
    fields: {
      window_ms: { type: "duration", doc: "How long the summed period was." },
      models: {
        type: "rows",
        doc: "One row per provider and model used.",
        fields: {
          "gen_ai.provider.name": {
            type: "catalog",
            catalog: "provider",
            doc: "The provider.",
          },
          "gen_ai.request.model": {
            type: "catalog",
            catalog: "model",
            doc: "The model requested.",
          },
          attempts: { type: "count", doc: "Provider requests made." },
          stop_reasons: {
            type: "tally",
            keys: ATTEMPT_STOP_REASONS,
            doc: "Requests by how they ended.",
          },
          provider_error_classes: {
            type: "tally",
            keys: PROVIDER_ERROR_CLASSES,
            doc: "Failed requests by error class.",
          },
          ...TOKEN_FIELDS,
        },
      },
      tools: {
        type: "rows",
        doc: "One row per tool and capability class used.",
        fields: {
          "gen_ai.tool.name": {
            type: "word",
            values: OBSERVED_TOOL_IDS,
            optional: true,
            doc: "The tool, when it is one Volli ships. Absent for any other tool.",
          },
          activity_kind: {
            type: "word",
            values: ACTIVITY_KINDS,
            doc: "What kind of work the tool call did.",
          },
          completed: { type: "count", doc: "Calls that completed." },
          failed: { type: "count", doc: "Calls that failed." },
        },
      },
      turns: { type: "tally", keys: TURN_OUTCOMES, doc: "Turns by how they ended." },
      compactions: {
        type: "rows",
        doc: "One row per compaction reason and outcome.",
        fields: {
          reason: { type: "word", values: COMPACTION_REASONS, doc: "Why compaction ran." },
          outcome: { type: "word", values: COMPACTION_OUTCOMES, doc: "How it ended." },
          count: { type: "count", doc: "How many times." },
        },
      },
      attachment_failures: {
        type: "tally",
        keys: RUNTIME_FAILURE_REASONS,
        doc: "Agent Runtime attachments that failed, by reason.",
      },
      attention_raised: {
        type: "tally",
        keys: RUNTIME_ATTENTION_REASONS,
        doc: "Times a Session asked for attention, by reason.",
      },
      dropped: {
        type: "tally",
        keys: TELEMETRY_DROP_REASONS,
        doc: "Telemetry events lost before sending, by reason.",
      },
    },
  },
  turn_sampled: {
    doc: "A random sample of finished turns, for latency percentiles.",
    fields: {
      duration_ms: { type: "duration", doc: "Turn opened to turn ended." },
      queued_ms: {
        type: "duration",
        optional: true,
        doc: "Message received to turn opened, when measured.",
      },
      ttft_ms: {
        type: "duration",
        optional: true,
        doc: "First request to its first streamed event, when one arrived.",
      },
      attempts: { type: "count", doc: "Provider requests in the turn." },
      tool_calls: { type: "count", doc: "Tool calls in the turn." },
      outcome: { type: "word", values: TURN_OUTCOMES, doc: "How the turn ended." },
      sample_rate: { type: "rate", doc: "The fraction of turns sampled." },
    },
  },
  runner_heartbeat_daily: {
    doc: "Once a day per signed-in Runner.",
    fields: {
      runner_kind: { type: "word", values: RUNNER_KINDS, doc: "Where the Runner runs." },
      runner_version: {
        type: "catalog",
        catalog: "version",
        doc: "The Runner's version.",
      },
    },
  },
} as const satisfies Record<string, TelemetryEventSpec>;

// ── Types derived from the schema ────────────────────────────────────────────

type CatalogValue<K> = K extends "provider"
  ? CatalogProviderId | typeof CUSTOM_CATALOG_ID
  : K extends "model"
    ? CatalogModelId | typeof CUSTOM_CATALOG_ID
    : TelemetryVersion | typeof UNKNOWN_VERSION;

type FieldValue<F> = F extends { type: "word"; values: readonly (infer V)[] }
  ? V
  : F extends { type: "count" | "integer" | "duration" | "rate" }
    ? number
    : F extends { type: "flag" }
      ? boolean
      : F extends { type: "catalog"; catalog: infer K }
        ? CatalogValue<K>
        : F extends { type: "tally"; keys: readonly (infer K extends string)[] }
          ? { [Key in K]?: number }
          : F extends { type: "rows"; fields: infer R }
            ? TelemetryProperties<R>[]
            : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The properties object a field map describes: optional specs become optional keys. */
export type TelemetryProperties<R> = Simplify<
  { [K in keyof R as R[K] extends { optional: true } ? never : K]: FieldValue<R[K]> } & {
    [K in keyof R as R[K] extends { optional: true } ? K : never]?: FieldValue<R[K]>;
  }
>;

export type TelemetryEventName = keyof typeof TELEMETRY_EVENTS;

export interface TelemetryEventOf<N extends TelemetryEventName> {
  event: N;
  properties: TelemetryProperties<(typeof TELEMETRY_EVENTS)[N]["fields"]>;
}

/** Everything Volli's own telemetry destination may receive. */
export type TelemetryEvent = { [N in TelemetryEventName]: TelemetryEventOf<N> }[TelemetryEventName];

export type AppStartedEvent = TelemetryEventOf<"app_started">;
export type RendererGoneEvent = TelemetryEventOf<"renderer_gone">;
export type FeatureUsedEvent = TelemetryEventOf<"feature_used">;
export type AgentRollupEvent = TelemetryEventOf<"agent_rollup">;
export type TurnSampledEvent = TelemetryEventOf<"turn_sampled">;
export type RunnerHeartbeatEvent = TelemetryEventOf<"runner_heartbeat_daily">;

// ── Runtime conformance ──────────────────────────────────────────────────────

/**
 * Whether a value is exactly a {@link TelemetryEvent}: a known event, every
 * required field present, no field the schema does not declare, and every
 * value inside its declared shape.
 *
 * The exporter's last gate before a value is queued, and it fails closed. The
 * types already guarantee this for code that does not cast; this catches the
 * code that does, and a value that crossed a process boundary.
 */
export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (!isPlainObject(value) || !hasExactlyKeys(value, ["event", "properties"])) return false;
  const name = value.event;
  if (typeof name !== "string" || !Object.hasOwn(TELEMETRY_EVENTS, name)) return false;
  const spec: TelemetryEventSpec = TELEMETRY_EVENTS[name as TelemetryEventName];
  return conformsToFields(value.properties, spec.fields);
}

function conformsToFields(
  value: unknown,
  fields: Readonly<Record<string, TelemetryFieldSpec>>,
): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) return false;
  }
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      if (field.optional === true) continue;
      return false;
    }
    if (!conformsToField(value[key], field)) return false;
  }
  return true;
}

function conformsToField(value: unknown, field: TelemetryFieldSpec): boolean {
  switch (field.type) {
    case "word":
      return closedWord(field.values, value) !== undefined;
    case "count":
      return Number.isSafeInteger(value) && (value as number) >= 0;
    case "integer":
      return Number.isSafeInteger(value);
    case "duration":
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "rate":
      return typeof value === "number" && value > 0 && value <= 1;
    case "flag":
      return typeof value === "boolean";
    case "catalog":
      return field.catalog === "version"
        ? value === UNKNOWN_VERSION || telemetryVersion(value) !== UNKNOWN_VERSION
        : value === CUSTOM_CATALOG_ID || isCatalogId(value);
    case "tally":
      return (
        isPlainObject(value) &&
        Object.entries(value).every(
          ([key, count]) =>
            closedWord(field.keys, key) !== undefined &&
            Number.isSafeInteger(count) &&
            (count as number) >= 0,
        )
      );
    case "rows":
      return (
        Array.isArray(value) &&
        value.length <= MAX_TELEMETRY_ROWS &&
        value.every((row) => conformsToFields(row, field.fields))
      );
    /* v8 ignore next 4 -- unreachable while the union is exhausted above; it exists to stop being so at compile time. */
    default: {
      const unhandled: never = field;
      return unhandled;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
