import { describe, expect, it } from "vite-plus/test";
import {
  BILLING_LOG_KEY,
  BILLING_LOG_LIMIT,
  billingLogJson,
  loadBillingLog,
  saveBillingLog,
  type LabelledRun,
} from "./billing-run-log";

const run: LabelledRun = { id: "one", createdAt: "2026-01-01", correctOption: "option_2" };
const isRun = (value: unknown): value is LabelledRun =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  "createdAt" in value &&
  "correctOption" in value;

describe("billing scratch run log", () => {
  it("loads empty storage without writing", () => {
    expect(loadBillingLog({ getItem: () => null }, isRun)).toEqual({ runs: [], error: null });
  });
  it("round-trips labels in a versioned JSON export", () => {
    let saved = "";
    expect(
      saveBillingLog(
        {
          setItem(key, value) {
            expect(key).toBe(BILLING_LOG_KEY);
            saved = value;
          },
        },
        [run],
      ),
    ).toBeNull();
    expect(saved).toBe(billingLogJson([run]));
    expect(loadBillingLog({ getItem: () => saved }, isRun)).toEqual({ runs: [run], error: null });
  });
  it("retains only the latest bounded set", () => {
    const runs = Array.from({ length: BILLING_LOG_LIMIT + 1 }, (_, i) => ({
      ...run,
      id: String(i),
    }));
    const loaded = loadBillingLog({ getItem: () => billingLogJson(runs) }, isRun);
    expect(loaded.runs).toHaveLength(BILLING_LOG_LIMIT);
    expect(loaded.runs[0]?.id).toBe("0");
  });
  it.each(["not json", '{"version":2,"runs":[]}', '{"version":1,"runs":[{}]}'])(
    "reports invalid storage without overwriting it: %s",
    (raw) => {
      expect(loadBillingLog({ getItem: () => raw }, isRun).error).toContain(
        "Existing storage has not been changed",
      );
    },
  );
  it("reports disabled or full storage", () => {
    expect(
      loadBillingLog(
        {
          getItem() {
            throw new Error("disabled");
          },
        },
        isRun,
      ).error,
    ).toBeTruthy();
    expect(
      saveBillingLog(
        {
          setItem() {
            throw new Error("full");
          },
        },
        [run],
      ),
    ).toContain("export JSON");
  });
});
