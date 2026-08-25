/**
 * Which URLs a Session may read from the network, as data plus a total function
 * over it.
 *
 * The same split `./authority-policy.ts` is written to: no sockets, no DNS, no
 * clock, no runtime. `@volli/agent-runtime` owns resolution and the connection
 * and asks here for a decision; everything below is a unit test with nothing
 * underneath it to mock.
 */

import { classifyWebAddress } from "./web-address-policy";

/** The scheme a target may carry once admitted. Nothing else reaches a socket. */
export type WebScheme = "http" | "https";

/**
 * Where the runtime is permitted to connect, after normalization.
 *
 * The hostname is kept separate from the URL because the two are used for
 * different things downstream: the address is resolved and pinned from
 * {@link hostname}, while TLS verification and SNI keep using that same name.
 */
export interface AdmittedWebTarget {
  url: string;
  scheme: WebScheme;
  hostname: string;
  port: number;
}

/**
 * Every rule admission can cite, in the order it evaluates them.
 *
 * Named for the same reason `AUTHORITY_RULE_IDS` are: a refusal that is only a
 * string is a refusal nothing can count, test by name, or show a person twice
 * in the same words.
 */
export const WEB_TARGET_RULE_IDS = [
  /** Longer than any real URL, and long enough to be a message rather than an address. */
  "target.length",
  /** Not a URL at all, or one carrying characters a parser and a client would read differently. */
  "target.unparsable",
  /** A scheme that is not an ordinary web read. */
  "target.scheme",
  /** Credentials embedded in the authority, which also disguise the real host. */
  "target.credentials",
  /** A hostname that names the local machine or a cloud metadata service. */
  "target.host",
  /** A literal IP address in the URL that is not on the public Internet. */
  "target.address",
  /** A port outside the narrow set this slice is willing to call a web read. */
  "target.port",
] as const;

export type WebTargetRuleId = (typeof WEB_TARGET_RULE_IDS)[number];

/** Admission's answer: one target to connect to, or one named refusal. */
export type WebTargetAdmission =
  | { outcome: "admit"; target: AdmittedWebTarget }
  | { outcome: "refuse"; rule: WebTargetRuleId; reason: string };

/**
 * The longest a URL may be and still be a URL.
 *
 * A length rule reads like housekeeping and is not. An admitted URL is quoted
 * back in two places that sit *outside* the untrusted-content envelope and are
 * therefore delivered in Volli's own voice: the refusal text a caller reads
 * when a read is declined, and the provenance line above a document that says
 * which URL answered. Once redirects are followed, that URL may have been
 * chosen by the previous hop rather than by the caller — and a `Location`
 * header is bounded only by the 16 KiB header limit.
 *
 * Measured before this rule existed: a server that redirected to its own URL
 * with a long query string put 10,003 characters of its own text into a refusal
 * message, and a server that redirected once before answering put 10,600
 * characters into the envelope preamble above a twenty-character document. Both
 * read as Volli's words, which is exactly the claim the envelope makes and the
 * one thing a page must not be able to borrow.
 *
 * Two kibibytes is far above any real URL — the de-facto browser ceiling is
 * about 2,083 characters, and signed storage URLs, the longest ordinary case,
 * run to roughly one — and far below room to write an instruction. The research
 * note that specified this boundary asked for a bound here and suggested 8 KiB;
 * nothing legitimate lives between the two figures.
 */
const MAX_URL_CHARS = 2048;

/** The only two schemes that describe reading a public document over the network. */
const PERMITTED_SCHEMES = new Set(["http:", "https:"]);

/** The port a scheme implies when the URL does not spell one. */
const DEFAULT_PORT: Record<WebScheme, number> = { http: 80, https: 443 };

/**
 * The only ports this slice will connect to.
 *
 * Deliberately narrower than the Internet. Admin consoles, databases and
 * message brokers listen elsewhere, and refusing the rest removes them as
 * targets without anyone having to argue that reaching them is harmless. A
 * wider set is a reviewed policy change, not a constant someone edits.
 */
const PERMITTED_PORTS: ReadonlySet<number> = new Set([80, 443]);

/**
 * Names refused before anything resolves them.
 *
 * Defence in depth and a legible error, not the control that makes these
 * unreachable: a hostname its operator controls can resolve to loopback or to a
 * metadata address, and only address classification sees that. This list exists
 * so the common spellings fail early and clearly, and it must never be read as
 * the reason the policy is safe.
 */
const BLOCKED_HOST_LABELS: ReadonlySet<string> = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/**
 * Compare hostnames the way a resolver does.
 *
 * Case is folded because DNS is case-insensitive, and one trailing dot is
 * dropped because `localhost.` is the fully-qualified spelling of the same name.
 */
function canonicalHost(hostname: string): string {
  const lowered = hostname.toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

/**
 * The address a URL names outright, with URL syntax removed.
 *
 * IPv6 literals are bracketed in a URL and those brackets are not part of the
 * address, so they come off before classification and before the runtime is
 * handed a hostname to resolve and pin to.
 *
 * Returns nothing for an ordinary name. Deciding that here rather than asking
 * the address policy to judge every hostname keeps "cannot classify" meaning
 * *refuse* in that policy, which is what makes it safe to fail closed there.
 */
function literalAddress(hostname: string): string | undefined {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  // The URL parser has already normalized every IPv4 spelling it accepts —
  // `0177.0.0.1` and `2130706433` both arrive here as `127.0.0.1` — so matching
  // the canonical dotted form is enough to catch them all.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ? hostname : undefined;
}

/**
 * Whether a name is, or sits beneath, a blocked name.
 *
 * Matched on label boundaries rather than as text: `app.localhost` resolves to
 * loopback and is refused, while `localhost.example.com` is an ordinary public
 * name that a substring test would wrongly catch.
 */
function isBlockedHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  for (const blocked of BLOCKED_HOST_LABELS) {
    if (host === blocked || host.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

/**
 * Judge one caller-supplied URL string.
 *
 * Parsed exactly once, and every later decision reads the parse rather than the
 * original text — two parses of one string is how a validator and a client come
 * to disagree about what they are talking about.
 */
export function admitWebTarget(input: string): WebTargetAdmission {
  // Before parsing, because the parser is happy to build a URL out of a
  // document's worth of text and every later step would then be carrying it.
  if (input.length > MAX_URL_CHARS) {
    return {
      outcome: "refuse",
      rule: "target.length",
      reason: `A URL Volli reads is at most ${MAX_URL_CHARS} characters; this one is ${input.length}.`,
    };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {
      outcome: "refuse",
      rule: "target.unparsable",
      reason: "That is not a URL Volli can read.",
    };
  }
  if (!PERMITTED_SCHEMES.has(url.protocol)) {
    return {
      outcome: "refuse",
      rule: "target.scheme",
      reason: `Only http and https can be read; this URL is ${url.protocol}`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      outcome: "refuse",
      rule: "target.credentials",
      reason: "A URL with embedded credentials disguises its host; supply the host directly.",
    };
  }
  if (isBlockedHost(url.hostname)) {
    return {
      outcome: "refuse",
      rule: "target.host",
      reason: `${url.hostname} names this machine or a cloud metadata service, not the public web.`,
    };
  }
  const literal = literalAddress(url.hostname);
  const hostname = literal ?? url.hostname;
  if (literal !== undefined) {
    const verdict = classifyWebAddress(literal);
    if (verdict.outcome === "refuse") {
      return {
        outcome: "refuse",
        rule: "target.address",
        reason: `${literal} is not on the public Internet: ${verdict.reason}`,
      };
    }
  }
  const scheme = url.protocol.slice(0, -1) as WebScheme;
  const port = url.port === "" ? DEFAULT_PORT[scheme] : Number(url.port);
  if (!PERMITTED_PORTS.has(port)) {
    return {
      outcome: "refuse",
      rule: "target.port",
      reason: `Only ports 80 and 443 can be read; this URL asks for ${port}`,
    };
  }
  return {
    outcome: "admit",
    target: { url: url.href, scheme, hostname, port },
  };
}
