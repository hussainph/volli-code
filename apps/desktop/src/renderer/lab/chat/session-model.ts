import type { SessionCapabilitySnapshot, SessionCapabilityState } from "@volli/shared";

export interface RuntimeModel {
  id: string;
  label: string;
  state: SessionCapabilityState;
  providerId: string;
  modelId: string;
  variants: readonly string[];
}

export interface RuntimeAgent {
  id: string;
  label: string;
  state: SessionCapabilityState;
  mode: string | null;
  description: string | null;
}

export interface RuntimeCatalog {
  providers: readonly string[];
  models: readonly RuntimeModel[];
  agents: readonly RuntimeAgent[];
}

export interface RuntimeSelection {
  providerId: string;
  modelId: string;
  variant: string;
  agent: string;
}

export function deriveRuntimeCatalog(snapshot: SessionCapabilitySnapshot | null): RuntimeCatalog {
  const models = (snapshot?.catalog ?? []).flatMap((item): RuntimeModel[] => {
    if (item.kind !== "model" || !isRecord(item.detail)) return [];
    const providerId = recordString(item.detail, "providerId");
    const modelId = recordString(item.detail, "modelId");
    if (!providerId || !modelId) return [];
    return [
      {
        id: item.id,
        label: item.label,
        state: item.state,
        providerId,
        modelId,
        variants: recordStrings(item.detail, "variants"),
      },
    ];
  });
  const agents = (snapshot?.catalog ?? []).flatMap((item): RuntimeAgent[] => {
    if (item.kind !== "agent") return [];
    const detail = isRecord(item.detail) ? item.detail : null;
    return [
      {
        id: item.id,
        label: item.label,
        state: item.state,
        mode: detail ? recordString(detail, "mode") : null,
        description: detail ? recordString(detail, "description") : null,
      },
    ];
  });
  return {
    providers: [
      ...new Set(
        models.filter((model) => model.state === "available").map((model) => model.providerId),
      ),
    ],
    models,
    agents,
  };
}

export function resolveRuntimeSelection(
  catalog: RuntimeCatalog,
  current: RuntimeSelection,
): RuntimeSelection {
  const currentModel = catalog.models.find(
    (model) =>
      model.providerId === current.providerId &&
      model.modelId === current.modelId &&
      model.state === "available",
  );
  const model = currentModel ?? catalog.models.find((candidate) => candidate.state === "available");
  const agent =
    catalog.agents.find(
      (candidate) => candidate.id === current.agent && candidate.state === "available",
    ) ?? catalog.agents.find((candidate) => candidate.state === "available");
  return {
    providerId: model?.providerId ?? "",
    modelId: model?.modelId ?? "",
    variant: model?.variants.includes(current.variant)
      ? current.variant
      : (model?.variants[0] ?? ""),
    agent: agent?.id ?? "",
  };
}

function recordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordStrings(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
