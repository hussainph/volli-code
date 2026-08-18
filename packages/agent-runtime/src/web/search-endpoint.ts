/**
 * Where a search provider's own endpoint is allowed to be.
 *
 * This module exists because of one honest tension. `admitWebTarget` answers
 * "may Volli read this URL", and it answers it for URLs the *model* chose, or
 * that a page the model read handed it — an attacker picks the target and the
 * policy is the only thing between that choice and a socket. A search provider
 * endpoint is not that. It is one string a person typed into their own settings,
 * before any Session ran, and the model can neither see it nor influence it: the
 * search tool takes a query and nothing else. Those are different trust classes,
 * and pretending otherwise in either direction costs something real —
 * `http://localhost:8888` is what a self-hosted SearXNG actually is, and
 * `admitWebTarget` refuses it twice over, for the blocked name and for the port.
 *
 * So the relaxation is made here, in its own named policy, rather than by
 * widening the one the model's URLs run through. Seam 1 and seam 2 are untouched
 * and still refuse loopback for everything they judge. What this adds is
 * deliberately a class of one: **this machine**. A SearXNG on the LAN, on a VPN,
 * behind a name that resolves inward, or at a metadata address is refused, the
 * same as before — "my own machine" is a claim a person can make about their own
 * computer, and "somewhere inside my network" is the SSRF prize with a
 * self-host story attached. That line is drawn narrow on purpose and widening it
 * is a product decision, not a constant to edit.
 *
 * Admission is only half of it. The reach class this returns is a claim about a
 * *name*, and a name resolves to whatever its operator says: `./search.ts`
 * resolves the hostname and requires every answer to match the class before it
 * connects, so a `foo.localhost` pointed at the LAN is refused at the address,
 * not merely at the label.
 */

import {
  admitWebTarget,
  classifyWebAddress,
  type WebScheme,
  type WebTargetRuleId,
} from "@volli/shared";

/**
 * Which of the two trust classes an endpoint belongs to.
 *
 * Carried forward rather than discarded after admission, because the address
 * check that follows it differs: a public endpoint must resolve to addresses
 * that are all public, and a self-hosted one must resolve to addresses that are
 * all this machine. Collapsing them to a boolean would leave the harder of the
 * two checks looking like the absence of the easier one.
 */
export type SearchEndpointReach = "public" | "this-machine";

/** Where a search request is permitted to go, after normalization. */
export interface AdmittedSearchEndpoint {
  url: string;
  scheme: WebScheme;
  hostname: string;
  port: number;
  reach: SearchEndpointReach;
}

/** Every rule this policy can cite that is its own rather than the public policy's. */
export const SEARCH_ENDPOINT_RULE_IDS = [
  /** Not a URL at all. */
  "endpoint.unparsable",
  /** A scheme that is not an ordinary web request. */
  "endpoint.scheme",
  /** Credentials in the authority, which disguise the host and outlive every log. */
  "endpoint.credentials",
] as const;

/** A refusal's name: this policy's rules, plus every rule the public one owns. */
export type SearchEndpointRuleId = (typeof SEARCH_ENDPOINT_RULE_IDS)[number] | WebTargetRuleId;

/** Admission's answer: one endpoint to connect to, or one named refusal. */
export type SearchEndpointAdmission =
  | { outcome: "admit"; endpoint: AdmittedSearchEndpoint }
  | { outcome: "refuse"; rule: SearchEndpointRuleId; reason: string };

const PERMITTED_SCHEMES = new Set(["http:", "https:"]);

const DEFAULT_PORT: Record<WebScheme, number> = { http: 80, https: 443 };

/**
 * The names reserved to this machine.
 *
 * RFC 6761 reserves `localhost` and everything under it to loopback, which is
 * why the subdomain form is here: `searxng.localhost` is a spelling people
 * actually use, and it is reserved to the same place. Nothing else is a name for
 * this machine — a host's own DNS name resolves wherever its operator points it,
 * and the address check below is what settles that either way.
 */
function namesThisMachine(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  const host = lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
  return host === "localhost" || host.endsWith(".localhost");
}

/** The address a URL names outright, with the IPv6 literal's URL brackets removed. */
function literalAddress(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Whether one address is this machine.
 *
 * Read off the same classifier the public policy uses, rather than a second
 * `127.` prefix test written here: `127.0.0.0/8` is wider than `127.0.0.1`,
 * `::1` is loopback too, and a policy that had its own opinion about which is
 * a policy that can disagree with the one that matters.
 */
export function isThisMachine(address: string): boolean {
  const verdict = classifyWebAddress(address);
  return verdict.outcome === "refuse" && verdict.class === "loopback";
}

/**
 * Judge one endpoint a person configured.
 *
 * Only ever called with a string the host supplied. Nothing derived from a
 * model, a page or a search result reaches this function — the tool above it
 * takes a query and has no field a URL could arrive in — and that is what makes
 * the relaxed class safe to have at all.
 */
export function admitSearchEndpoint(input: string): SearchEndpointAdmission {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {
      outcome: "refuse",
      rule: "endpoint.unparsable",
      reason: "That search endpoint is not a URL Volli can call.",
    };
  }
  // Scheme and credentials are judged before the reach class, so the relaxed
  // class never becomes the thing that decides a `ws://127.0.0.1` or a URL
  // carrying a key in its authority.
  if (!PERMITTED_SCHEMES.has(url.protocol)) {
    return {
      outcome: "refuse",
      rule: "endpoint.scheme",
      reason: `A search endpoint must be http or https; this one is ${url.protocol}`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      outcome: "refuse",
      rule: "endpoint.credentials",
      reason: "A search endpoint must not carry credentials in its URL; configure a key instead.",
    };
  }
  // Dropped once, here, so both classes agree on what the endpoint is. A
  // fragment is never sent to a server, and one left on the value would be a
  // difference between the URL this policy admitted and the request that goes
  // out — the kind of gap a validator and a client come to disagree across.
  url.hash = "";
  const hostname = literalAddress(url.hostname);
  if (namesThisMachine(hostname) || isThisMachine(hostname)) {
    const scheme = url.protocol.slice(0, -1) as WebScheme;
    return {
      outcome: "admit",
      endpoint: {
        // A person's own `?format=json` is part of the endpoint they configured,
        // so the query survives where the fragment did not.
        url: url.href,
        scheme,
        hostname,
        port: url.port === "" ? DEFAULT_PORT[scheme] : Number(url.port),
        reach: "this-machine",
      },
    };
  }
  const admission = admitWebTarget(url.href);
  if (admission.outcome === "refuse") return admission;
  return { outcome: "admit", endpoint: { ...admission.target, reach: "public" } };
}
