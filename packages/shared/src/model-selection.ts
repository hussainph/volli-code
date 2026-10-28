/** Lightweight model vocabulary and codec; shared by local records, runtime contracts and cloud payloads. */
/** Volli's reasoning policy, independent of any provider's type names. */
export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** The selected model access for one Session attachment. */
export interface ModelSelection {
  providerId: string;
  modelId: string;
  reasoningLevel: ReasoningLevel;
}

/**
 * A stored `session_model` payload as a {@link ModelSelection}, or `null` for
 * anything that is not one. Unreadable stored selections degrade rather than
 * throwing: a project whose column is nonsense inherits the app-wide default,
 * which is both survivable and visible.
 */
export function parseSessionModel(value: unknown): ModelSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { providerId, modelId, reasoningLevel } = candidate;
  if (typeof providerId !== "string" || providerId.length === 0) return null;
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  const level = REASONING_LEVELS.find((known) => known === reasoningLevel);
  if (level === undefined) return null;
  return { providerId, modelId, reasoningLevel: level };
}
