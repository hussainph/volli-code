import { describe, expect, it } from "vite-plus/test";
import type { ModelAccessProvider, UsageLimits, UsageWindow } from "@volli/shared";

import { usageLimitAccounts } from "./accounts";

const NOW = Date.parse("2026-03-01T12:00:00Z");

function window(id: string, usedPercent: number): UsageWindow {
  return { id, kind: "session", label: "Session", usedPercent, windowDurationMins: 300 };
}

function provider(id: string, label: string, usageLimits?: UsageLimits): ModelAccessProvider {
  return {
    id,
    label,
    state: "available",
    accountLabel: null,
    billingSource: "subscription",
    recovery: null,
    signIn: [],
    hasStoredCredential: true,
    ...(usageLimits === undefined ? {} : { usageLimits }),
  };
}

const limits = (...windows: UsageWindow[]): UsageLimits => ({ checkedAt: NOW, windows });

describe("usageLimitAccounts", () => {
  it("keeps only the accounts that have windows to show", () => {
    const accounts = usageLimitAccounts([
      // Signed in, metered: the case the surface exists for.
      provider("anthropic", "Anthropic", limits(window("five_hour", 20))),
      // No reader at all — most of the catalogue.
      provider("openai", "OpenAI"),
      // Read and answered: this account is not metered in windows and never
      // will be, so a row saying so would be a row that never changes.
      provider("mistral", "Mistral", {
        checkedAt: NOW,
        windows: [],
        unavailable: { reason: "unsupported" },
      }),
    ]);
    expect(accounts.map((account) => account.providerId)).toEqual(["anthropic"]);
  });

  it("names the window closest to running out, which is what the collapsed row says", () => {
    const accounts = usageLimitAccounts([
      provider(
        "openai-codex",
        "OpenAI Codex",
        limits(window("session", 12), window("weekly", 81), window("monthly", 40)),
      ),
    ]);
    expect(accounts[0]?.binding?.id).toBe("weekly");
  });

  it("puts the account closest to running out first", () => {
    const accounts = usageLimitAccounts([
      provider("anthropic", "Anthropic", limits(window("five_hour", 10))),
      provider("xai", "xAI", limits(window("weekly", 95))),
      provider("kimi-coding", "Kimi For Coding", limits(window("session", 60))),
    ]);
    expect(accounts.map((account) => account.providerId)).toEqual([
      "xai",
      "kimi-coding",
      "anthropic",
    ]);
  });

  it("sorts accounts that measured the same by name, so the order holds still", () => {
    const accounts = usageLimitAccounts([
      provider("kimi-coding", "Kimi For Coding", limits(window("session", 50))),
      provider("anthropic", "Anthropic", limits(window("five_hour", 50))),
    ]);
    expect(accounts.map((account) => account.label)).toEqual(["Anthropic", "Kimi For Coding"]);
  });

  it("keeps an account whose read failed, last and with nothing to compare", () => {
    // A failed read is not an account with nothing to show — it is one whose
    // numbers are a Refresh away, so it stays on the surface that offers one.
    const accounts = usageLimitAccounts([
      provider("github-copilot", "GitHub Copilot", {
        checkedAt: NOW,
        windows: [],
        unavailable: { reason: "probeFailed" },
      }),
      provider("anthropic", "Anthropic", limits(window("five_hour", 3))),
    ]);
    expect(accounts.map((account) => account.providerId)).toEqual(["anthropic", "github-copilot"]);
    expect(accounts[1]?.binding).toBeNull();
  });
});
