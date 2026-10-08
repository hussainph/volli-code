/** Running build identity, supplied by the host; never a user-selected update channel. */
export type ExperimentBuildKind = "dev" | "canary" | "stable";

/** Pure vocabulary for unfinished product work. Dev-only configs stay separate. */
export interface ExperimentDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly default: boolean;
  readonly scope: "host" | "device";
  readonly availableOn: readonly ExperimentBuildKind[];
}

/**
 * Storage classification: `volli:experimental-flags` is host-level settings,
 * NOT workspace data. Today it lives in app_state in volli.db; the future
 * host-level settings database owns it, never a portable workspace database.
 * Device-scoped entries belong to the current device, not a workspace either.
 */
export const EXPERIMENTS = Object.freeze([
  Object.freeze({
    id: "cloud",
    label: "Volli Cloud (unstable)",
    description:
      "Before enabling unstable cloud features, read the cloud threat model at https://github.com/hussainph/volli-code/blob/main/SECURITY.md#cloud-threat-model.",
    default: false,
    scope: "host",
    availableOn: Object.freeze(["dev", "canary"] as const),
  }),
] as const satisfies readonly ExperimentDefinition[]);

export type ExperimentId = (typeof EXPERIMENTS)[number]["id"];
export type ExperimentValues = Record<ExperimentId, boolean>;
export type ExperimentSnapshot = Record<
  ExperimentId,
  {
    enabled: boolean;
    source: "default" | "storage" | "environment";
    /** Absent on older hosts means visible; false hides this setting. */
    visible?: boolean;
  }
>;

/** Code APIs and commands are strict; environment and durable reads are tolerant. */
export function requireExperimentId(id: unknown): ExperimentId {
  const known = EXPERIMENTS.find((entry) => entry.id === id);
  if (!known) throw new Error(`Unknown experiment: ${String(id)}`);
  return known.id;
}

/**
 * A case-insensitive opt-in list, read once at boot, packaged or not.
 * Retired or unknown ids must not prevent launch; the host warns once about
 * the returned unknown list, keeping logging out of this pure registry.
 */
export function parseExperimentEnvironment(value: string | undefined): {
  ids: readonly ExperimentId[];
  unknownIds: readonly string[];
} {
  const ids: ExperimentId[] = [];
  const unknownIds: string[] = [];
  const requested = new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const id of requested) {
    const known = EXPERIMENTS.find((entry) => entry.id === id);
    if (known) ids.push(known.id);
    else unknownIds.push(id);
  }
  return { ids, unknownIds };
}

/** The opaque storage record, including fields a newer build may own. */
function storedExperimentRecord(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

/** Unknown ids from newer builds are ignored. Corrupt known values default independently. */
export function readStoredExperiments(raw: string | undefined): Partial<ExperimentValues> {
  const candidate = storedExperimentRecord(raw);
  const stored: Partial<ExperimentValues> = {};
  for (const entry of EXPERIMENTS) {
    if (Object.hasOwn(candidate, entry.id) && typeof candidate[entry.id] === "boolean") {
      stored[entry.id] = candidate[entry.id] as boolean;
    }
  }
  return stored;
}

/** Update one registered flag without erasing opaque settings owned by newer builds. */
export function serializeExperimentUpdate(
  raw: string | undefined,
  id: ExperimentId,
  enabled: boolean,
): string {
  requireExperimentId(id);
  if (typeof enabled !== "boolean") throw new Error("Experiment enabled must be a boolean");
  return JSON.stringify({ ...storedExperimentRecord(raw), [id]: enabled });
}

/** One resolution rule for the host and every projection. Environment always wins. */
export function resolveExperiments(
  stored: Partial<ExperimentValues>,
  environment: readonly ExperimentId[],
  buildKind: ExperimentBuildKind,
): ExperimentSnapshot {
  return Object.fromEntries(
    EXPERIMENTS.map((entry) => {
      const fromEnvironment = environment.includes(entry.id);
      const available = (entry.availableOn as readonly ExperimentBuildKind[]).includes(buildKind);
      const saved = available ? stored[entry.id] : undefined;
      return [
        entry.id,
        {
          enabled: fromEnvironment || (available && (saved ?? entry.default)),
          source: fromEnvironment ? "environment" : saved === undefined ? "default" : "storage",
          ...(!available && !fromEnvironment ? { visible: false } : {}),
        },
      ];
    }),
  ) as ExperimentSnapshot;
}
