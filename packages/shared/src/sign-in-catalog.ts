/**
 * This Client's browser authorization policy, versioned independently of the
 * host's provider list. Domains are exact URL hosts (no wildcards, subdomains
 * or non-default ports). Never accept an allowlist supplied by a remote host.
 *
 * Version 1 follows the browser/device methods in pi-ai 1.0.0. Radius discovers
 * its authorization endpoint from a configurable gateway, so it deliberately
 * has no automatic-open domains. Enterprise Copilot, provider overrides and
 * newer/unknown providers remain available through domain-named manual links.
 * This static catalog is bounded: nine providers, at most two domains per row,
 * DNS names of at most 253 characters. Review and bump the version on changes.
 */
export const SIGN_IN_CATALOG = {
  version: 1,
  providers: [
    { id: "anthropic", authorizationDomains: ["claude.ai"] },
    { id: "openai", authorizationDomains: ["auth.openai.com"] },
    { id: "openai-codex", authorizationDomains: ["auth.openai.com"] },
    { id: "github-copilot", authorizationDomains: ["github.com"] },
    { id: "openrouter", authorizationDomains: ["openrouter.ai"] },
    { id: "xai", authorizationDomains: ["auth.x.ai", "accounts.x.ai"] },
    { id: "kimi-coding", authorizationDomains: ["auth.kimi.com"] },
    { id: "meta", authorizationDomains: ["auth.meta.com"] },
    { id: "radius", authorizationDomains: [] },
  ],
} as const;

/** A bounded web page safe to offer as a manual sign-in link; not permission to auto-open. */
export function signInWebUrl(value: string): URL | null {
  if (value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
