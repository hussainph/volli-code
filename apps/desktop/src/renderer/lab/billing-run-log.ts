/** Lab-only, versioned export envelope. No product persistence or ledger writes. */
export const BILLING_LOG_KEY = "volli.lab.billing-auto-select.v1";
export const BILLING_LOG_LIMIT = 100;

export interface LabelledRun {
  id: string;
  createdAt: string;
  correctOption: string | null;
}

export function loadBillingLog<T extends LabelledRun>(
  storage: Pick<Storage, "getItem">,
  isRun: (value: unknown) => value is T,
): {
  runs: T[];
  error: string | null;
} {
  try {
    const raw = storage.getItem(BILLING_LOG_KEY);
    if (raw === null) return { runs: [], error: null };
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("runs" in value) ||
      !Array.isArray(value.runs) ||
      !value.runs.every(isRun)
    )
      throw new Error("Unrecognized log format");
    return { runs: value.runs.slice(0, BILLING_LOG_LIMIT), error: null };
  } catch {
    return {
      runs: [],
      error: "Could not read the saved run log. Existing storage has not been changed.",
    };
  }
}

export function billingLogJson(runs: readonly LabelledRun[]): string {
  return JSON.stringify({ version: 1, runs }, null, 2);
}

export function saveBillingLog(
  storage: Pick<Storage, "setItem">,
  runs: readonly LabelledRun[],
): string | null {
  try {
    storage.setItem(BILLING_LOG_KEY, billingLogJson(runs.slice(0, BILLING_LOG_LIMIT)));
    return null;
  } catch {
    return "Could not save the run log (storage may be full or disabled). Runs remain in memory; export JSON to keep them.";
  }
}
