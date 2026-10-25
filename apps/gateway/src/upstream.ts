/**
 * Where a relayed request goes, and which headers cross the hop.
 *
 * The upstream origin comes only from the signed grant. The request path after
 * the connection id is appended to the route's base URL unchanged, and the
 * result must stay under that base: a path that climbs out of it (`%2e%2e`
 * segments) is refused rather than sent somewhere the grant never named.
 */

/** Hosts that are never a public provider endpoint. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"];

/**
 * The base URL when `up` is https on a public DNS name, else `null`. IP
 * literals, single-label names, credentials in the URL, and private-use
 * suffixes are all refused: the backend checks this when a connection is
 * saved, and the gateway checks again because it is the one that connects.
 */
export function parseUpstreamBase(up: string): URL | null {
  let url: URL;
  try {
    url = new URL(up);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  // A trailing dot names the same host ("localhost." is localhost).
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || !host.includes(".")) return null;
  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  return url;
}

/** The upstream URL for `rest` (the path after the connection id) and `search`, or `null` if it escapes the base. */
export function upstreamUrl(base: URL, rest: string, search: string): URL | null {
  const basePath = base.pathname.replace(/\/+$/, "");
  const target = new URL(`${base.origin}${basePath}${rest}${search}`);
  if (target.origin !== base.origin) return null;
  if (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) return null;
  return target;
}

/** Never forwarded upstream: every place a grant can ride, hop-by-hop and edge headers. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "host",
  "content-length",
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-real-ip",
]);

const STRIPPED_REQUEST_PREFIXES = ["cf-", "x-forwarded-", "x-volli-"];

/**
 * Which organization or project a key bills is the connection's choice, never
 * the runner's. A connection that needs one sets it in its own headers.
 */
const CONNECTION_CHOSEN_HEADERS = new Set(["openai-organization", "openai-project"]);

function crosses(name: string): boolean {
  return (
    !STRIPPED_REQUEST_HEADERS.has(name) &&
    !STRIPPED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** The runner's request headers that cross to the provider, before the real key is added. */
export function forwardedRequestHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of incoming) {
    if (crosses(name) && !CONNECTION_CHOSEN_HEADERS.has(name)) out.append(name, value);
  }
  return out;
}

/** The connection's own extra headers that cross, from the grant route's `hdr`. */
export function connectionHeaders(hdr: Record<string, string> | undefined): Headers {
  const out = new Headers();
  for (const [name, value] of new Headers(hdr)) {
    if (crosses(name)) out.append(name, value);
  }
  return out;
}

/**
 * Never relayed back. The body the gateway returns is the decoded stream, so
 * the provider's encoding and length no longer describe it.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "set-cookie",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The provider's response headers that reach the runner. `x-volli-*` is the gateway's alone to set. */
export function relayedResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of upstream) {
    if (!STRIPPED_RESPONSE_HEADERS.has(name) && !name.startsWith("x-volli-"))
      out.append(name, value);
  }
  return out;
}
