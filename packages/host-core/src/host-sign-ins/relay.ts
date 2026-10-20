/**
 * The auth-callback relay, host side (HP § Auth-callback relay; VC-702).
 *
 * Pi's browser sign-ins (Anthropic, Sign in with ChatGPT, OpenAI Codex's
 * browser method, OpenRouter) start a loopback listener on the host and put
 * its address in the authorization URL they emit: `redirect_uri`, or
 * OpenRouter's `callback_url`. A Client on another machine opens that URL in
 * its own browser, so the provider redirects to the Client's loopback, where
 * nothing of the host's listens. The relay closes that gap for one request:
 *
 * 1. {@link relayTargetOf} reads the redirect out of the authorization URL.
 *    Only an `http` loopback address qualifies (`localhost`, `127.0.0.1`,
 *    `[::1]`), so a grant can only ever point back at this host's own
 *    listener; any other redirect leaves the flow to device code or paste.
 * 2. The host grants the asking connection `auth-callback {flowId,
 *    redirectUri}`. The Client binds that loopback port, accepts one request
 *    on the path, and sends its path and query with `auth.callback.deliver`.
 * 3. {@link replayCallback} replays it to the host's listener, at exactly the
 *    origin the flow registered. Pi's listener checks `state` and exchanges
 *    the code with the PKCE verifier only the host holds. Tokens never reach
 *    the Client: it learns only the listener's HTTP status.
 */

/** Where a flow's loopback listener waits, as the relay grant names it. */
export interface RelayTarget {
  /** The redirect exactly as the flow registered it, for the Client to bind. */
  readonly redirectUri: string;
  /** Where the host replays to: the listener's own loopback address. */
  readonly origin: string;
  /** The one path the listener answers on. */
  readonly path: string;
}

const REDIRECT_PARAMETERS = ["redirect_uri", "callback_url"] as const;

/**
 * The loopback redirect an authorization URL names, or null when it names
 * none this host may relay to.
 *
 * `localhost` replays to `127.0.0.1`: Pi binds its callback listener there
 * (`PI_OAUTH_CALLBACK_HOST`, default `127.0.0.1`) while advertising
 * `localhost`, and a resolver that prefers `::1` would miss it.
 */
export function relayTargetOf(authorizationUrl: string): RelayTarget | null {
  let url: URL;
  try {
    url = new URL(authorizationUrl);
  } catch {
    return null;
  }
  for (const name of REDIRECT_PARAMETERS) {
    const value = url.searchParams.get(name);
    if (value === null) continue;
    let redirect: URL;
    try {
      redirect = new URL(value);
    } catch {
      return null;
    }
    if (redirect.protocol !== "http:" || redirect.username !== "" || redirect.password !== "") {
      return null;
    }
    if (redirect.port === "") return null;
    const host = loopbackReplayHost(redirect.hostname);
    if (host === null) return null;
    return {
      redirectUri: value,
      origin: `http://${host}:${redirect.port}`,
      path: redirect.pathname,
    };
  }
  return null;
}

function loopbackReplayHost(hostname: string): string | null {
  if (hostname === "localhost" || hostname === "127.0.0.1") return "127.0.0.1";
  if (hostname === "[::1]") return "[::1]";
  return null;
}

/**
 * Whether a delivered request target belongs to the grant: the same path,
 * then nothing or a query. No scheme, host, fragment or second path.
 */
export function deliveryMatches(target: RelayTarget, pathAndQuery: string): boolean {
  if (!pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//")) return false;
  if (pathAndQuery.includes("#") || /[\s\0]/u.test(pathAndQuery)) return false;
  const query = pathAndQuery.indexOf("?");
  const path = query === -1 ? pathAndQuery : pathAndQuery.slice(0, query);
  return path === target.path;
}

/** Replays one request to the host's own listener; answers its HTTP status. */
export type CallbackReplay = (url: string, signal: AbortSignal) => Promise<number>;

/** How long the host's own listener has to answer a replayed callback. */
export const CALLBACK_REPLAY_TIMEOUT_MS = 30_000;

/**
 * The default replay: one GET, no redirects followed, the body drained and
 * dropped. The listener answers once it has exchanged the code, which is a
 * provider round trip, so the bound is generous.
 */
export const fetchCallbackReplay: CallbackReplay = async (url, signal) => {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(CALLBACK_REPLAY_TIMEOUT_MS)]),
  });
  await response.body?.cancel();
  return response.status;
};

/** The replay's URL: the grant's origin and the delivered path and query, nothing from input else. */
export function replayUrl(target: RelayTarget, pathAndQuery: string): string {
  return `${target.origin}${pathAndQuery}`;
}
