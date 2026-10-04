/** Pure vocabulary for unfinished product work. Dev-only configs stay separate. */
export interface ExperimentDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly default: boolean;
  readonly scope: "host" | "device";
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
    description: "Unfinished cloud features may change or break.",
    default: false,
    scope: "host",
  }),
] as const satisfies readonly ExperimentDefinition[]);

export type ExperimentId = (typeof EXPERIMENTS)[number]["id"];
export type ExperimentValues = Record<ExperimentId, boolean>;
export type ExperimentSnapshot = Record<
  ExperimentId,
  { enabled: boolean; source: "default" | "storage" | "environment" }
>;

/** Commands and environment configuration are strict; durable reads are tolerant. */
export function requireExperimentId(id: unknown): ExperimentId {
  const known = EXPERIMENTS.find((entry) => entry.id === id);
  if (!known) throw new Error(`Unknown experiment: ${String(id)}`);
  return known.id;
}

/** A comma-separated opt-in list, read once by the host at boot, packaged or not. */
export function parseExperimentEnvironment(value: string | undefined): readonly ExperimentId[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map(requireExperimentId),
    ),
  ];
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
): ExperimentSnapshot {
  return Object.fromEntries(
    EXPERIMENTS.map((entry) => {
      const fromEnvironment = environment.includes(entry.id);
      const saved = stored[entry.id];
      return [
        entry.id,
        {
          enabled: fromEnvironment || (saved ?? entry.default),
          source: fromEnvironment ? "environment" : saved === undefined ? "default" : "storage",
        },
      ];
    }),
  ) as ExperimentSnapshot;
}
