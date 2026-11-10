/**
 * Display identity only. PSL/private-domain knowledge never authorizes a read
 * or an icon request: acquisition must retain the successful read's EXACT
 * origin. In particular, sibling sites on a private suffix are not one origin.
 *
 * Kept inside host-core, with no package-root export. The cache projection
 * must derive this for every requested origin BEFORE its cache-hit/miss branch;
 * an absent icon says nothing about whether a registrable domain is known.
 */
import { parse } from "tldts";
import { isCanonicalSourceOrigin } from "@volli/shared";

/** Null for IPs, bare suffixes, unknown suffixes and non-canonical origins. */
export function registrableDomainForOrigin(origin: string): string | null {
  if (!isCanonicalSourceOrigin(origin)) return null;
  const result = parse(new URL(origin).hostname, { allowPrivateDomains: true });
  // tldts can offer a best-effort domain for an unknown suffix. That guess is
  // deliberately not a transcript identity. Accept only its real PSL data.
  if (result.isIp || (result.isIcann !== true && result.isPrivate !== true)) return null;
  return result.domain;
}
