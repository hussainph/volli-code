/**
 * What the Decision model controls show and write, decided without rendering
 * (VC-478). The view in `decision-model-settings.tsx` draws this and does the
 * I/O; every rule about which option a setting is, what a cloud choice
 * writes, and what a model's status says lives here.
 */

import {
  DECISION_PURPOSES,
  DEFAULT_LOCAL_DECISION_URL,
  type DecisionModelCatalogEntry,
  type DecisionModelSetting,
} from "@volli/shared";

/** The three choices the control offers, in order. */
export type DecisionMode = "none" | "local" | "cloud";

export const DECISION_MODES: readonly { key: DecisionMode; label: string }[] = [
  { key: "none", label: "None" },
  { key: "local", label: "Local" },
  { key: "cloud", label: "Cloud" },
];

/**
 * The model id a local setting carries until a person names one. llama-server
 * run with one model ignores the id, so the zero-configuration path — start
 * `llama-server -m model.gguf` and choose Local — works as is; a router-mode
 * server needs the real id typed in.
 */
export const DEFAULT_LOCAL_DECISION_MODEL_ID = "default";

export function decisionMode(setting: DecisionModelSetting): DecisionMode {
  return setting.kind;
}

/** A cloud model's option key: the pair that names it, which no label does. */
export function cloudOptionKey(entry: Pick<DecisionModelCatalogEntry, "providerId" | "modelId">) {
  return JSON.stringify([entry.providerId, entry.modelId]);
}

/** The catalog entry an option key or a setting names, if the catalog still has it. */
export function catalogEntry(
  catalog: readonly DecisionModelCatalogEntry[],
  ref: { providerId: string; modelId: string },
): DecisionModelCatalogEntry | null {
  return (
    catalog.find((entry) => entry.providerId === ref.providerId && entry.modelId === ref.modelId) ??
    null
  );
}

export function entryForKey(
  catalog: readonly DecisionModelCatalogEntry[],
  key: string,
): DecisionModelCatalogEntry | null {
  return catalog.find((entry) => cloudOptionKey(entry) === key) ?? null;
}

/** `Jev · TypeSafe`: a classifier's name is not unique across providers. */
export function cloudLabel(entry: Pick<DecisionModelCatalogEntry, "label" | "providerLabel">) {
  return `${entry.label} · ${entry.providerLabel}`;
}

/**
 * The cloud catalog grouped by provider for the picker, providers and models
 * each in label order, the providers a person is signed in to first — the
 * same reachability-first rule the Accounts list sorts by.
 */
export function catalogGroups(catalog: readonly DecisionModelCatalogEntry[]): readonly {
  providerId: string;
  providerLabel: string;
  ready: boolean;
  entries: readonly DecisionModelCatalogEntry[];
}[] {
  const groups = new Map<string, DecisionModelCatalogEntry[]>();
  for (const entry of catalog) {
    const group = groups.get(entry.providerId);
    if (group === undefined) groups.set(entry.providerId, [entry]);
    else group.push(entry);
  }
  return [...groups.values()]
    .map((entries) => ({
      providerId: entries[0]!.providerId,
      providerLabel: entries[0]!.providerLabel,
      ready: entries.some((entry) => entry.state === "available"),
      entries: entries.toSorted((a, b) => a.label.localeCompare(b.label)),
    }))
    .toSorted(
      (a, b) => Number(b.ready) - Number(a.ready) || a.providerLabel.localeCompare(b.providerLabel),
    );
}

/**
 * The cloud setting a person's opt-in writes, for every purpose this build
 * has. `acceptedAt` is stamped again by main; this value is the renderer's
 * statement that the person pressed Allow.
 */
export function cloudSetting(
  entry: Pick<DecisionModelCatalogEntry, "providerId" | "modelId">,
  now: number,
): DecisionModelSetting {
  return {
    kind: "cloud",
    providerId: entry.providerId,
    modelId: entry.modelId,
    optIn: { acceptedAt: now, purposes: [...DECISION_PURPOSES] },
  };
}

/**
 * A once-only extension prompt, tied to the scope and the existing agreement.
 * Declining changes no authority: this key is only a durable UI receipt.
 * An inherited global agreement is handled in app-wide Settings, never by
 * silently creating a project override.
 */
export function authorityOptInExtensionKey(
  setting: DecisionModelSetting | null,
  projectId: string | null,
): string | null {
  if (setting?.kind !== "cloud" || setting.optIn.purposes.includes("authority.judge")) return null;
  return `volli:decision-opt-in-extension:authority.judge:${JSON.stringify([
    projectId,
    setting.providerId,
    setting.modelId,
    setting.optIn.acceptedAt,
  ])}`;
}

/** Extend only the disclosed purpose, preserving every existing permission. */
export function extendAuthorityCloudOptIn(
  setting: Extract<DecisionModelSetting, { kind: "cloud" }>,
  now: number,
): DecisionModelSetting {
  return {
    ...setting,
    optIn: {
      acceptedAt: now,
      purposes: DECISION_PURPOSES.filter(
        (purpose) => purpose === "authority.judge" || setting.optIn.purposes.includes(purpose),
      ),
    },
  };
}

/** A local setting from what the fields hold, with the defaults filling blanks. */
export function localSetting(baseUrl: string, modelId: string): DecisionModelSetting {
  return {
    kind: "local",
    server: "llama-cpp",
    baseUrl: baseUrl.trim() === "" ? DEFAULT_LOCAL_DECISION_URL : baseUrl.trim(),
    modelId: modelId.trim() === "" ? DEFAULT_LOCAL_DECISION_MODEL_ID : modelId.trim(),
  };
}

/** One line naming a setting, for an inherited value and a revert button. */
export function settingLabel(
  setting: DecisionModelSetting,
  catalog: readonly DecisionModelCatalogEntry[],
): string {
  switch (setting.kind) {
    case "none":
      return "None";
    case "local":
      return setting.modelId === DEFAULT_LOCAL_DECISION_MODEL_ID
        ? "Local server"
        : `Local server · ${setting.modelId}`;
    case "cloud": {
      const entry = catalogEntry(catalog, setting);
      return entry === null ? `${setting.modelId} · ${setting.providerId}` : cloudLabel(entry);
    }
  }
}

/**
 * Where a configured cloud model stands: usable, waiting on a person to sign
 * in to its provider, or gone from the catalog. A local or no model has no
 * status of this kind.
 */
export type CloudStatus =
  | { kind: "ready"; entry: DecisionModelCatalogEntry }
  | { kind: "needs-setup"; entry: DecisionModelCatalogEntry }
  | { kind: "missing" };

export function cloudStatus(
  setting: Extract<DecisionModelSetting, { kind: "cloud" }>,
  catalog: readonly DecisionModelCatalogEntry[],
): CloudStatus {
  const entry = catalogEntry(catalog, setting);
  if (entry === null) return { kind: "missing" };
  return entry.state === "available" ? { kind: "ready", entry } : { kind: "needs-setup", entry };
}

/** A catalog price as a person reads it: `Free`, or dollars per million input tokens. */
export function priceLabel(entry: Pick<DecisionModelCatalogEntry, "inputUsdPerMillion">): string {
  return entry.inputUsdPerMillion === 0 ? "Free" : `$${entry.inputUsdPerMillion}/M input`;
}
