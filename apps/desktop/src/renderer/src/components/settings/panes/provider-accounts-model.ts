import type { ModelAccessProvider } from "@volli/shared";

/** Common choices are a curated shortcut, not a claim about measured popularity. */
const COMMON_PROVIDERS = ["anthropic", "openai", "google", "github-copilot", "openrouter"];
const PREVIEW_COUNT = COMMON_PROVIDERS.length;

export function availableProviderRows(
  providers: readonly ModelAccessProvider[],
  query: string,
  expanded: boolean,
  requestedProviderId?: string,
): readonly ModelAccessProvider[] {
  const rank = (provider: ModelAccessProvider) => {
    if (provider.id === requestedProviderId) return -1;
    const index = COMMON_PROVIDERS.indexOf(provider.id);
    return index === -1 ? COMMON_PROVIDERS.length : index;
  };
  const ordered = providers.toSorted(
    (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
  const needle = query.trim().toLowerCase();
  if (needle) return ordered.filter((provider) => provider.label.toLowerCase().includes(needle));
  return expanded ? ordered : ordered.slice(0, PREVIEW_COUNT);
}

/** Omit unknown billing and sign-in instructions already expressed by the action. */
export function providerStatus(provider: ModelAccessProvider): string | null {
  const access = provider.state === "unavailable" ? "Unavailable" : provider.accountLabel;
  const billing =
    provider.billingSource === "unknown"
      ? null
      : provider.billingSource
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ");
  return [access, billing].filter(Boolean).join(" · ") || null;
}
