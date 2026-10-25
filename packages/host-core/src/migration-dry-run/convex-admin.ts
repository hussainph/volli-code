/**
 * The one door the migration dry run uses into a backend: Convex's HTTP
 * function API, called with the deployment's admin key so it can reach the
 * `migration:*` internal functions. Plain `fetch`, so host-core takes no
 * dependency on the Convex client; the wire format is Convex's own
 * (`convex_encoded_json`, which equals plain JSON for the values a migration
 * sends: no bigints, no bytes, and no `$`-prefixed keys, because the dry run
 * refuses, or spills, any row holding one before it is sent).
 *
 * Only a loopback URL is accepted: the dry run imports a person's real
 * history, and must never be pointed at a shared or cloud deployment.
 */

export interface ConvexAdmin {
  readonly url: string;
  mutation<T>(path: string, args: Record<string, unknown>): Promise<T>;
  query<T>(path: string, args: Record<string, unknown>): Promise<T>;
}

/** A function call the backend answered with an error (the function threw, or refused its arguments). */
class ConvexCallError extends Error {
  override readonly name = "ConvexCallError";
}

const CALL_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether `url` names a backend on this machine. */
function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function connectConvexAdmin(url: string, adminKey: string): ConvexAdmin {
  if (!isLoopbackUrl(url)) {
    throw new Error("The migration dry run only talks to a local backend (a loopback URL).");
  }
  const base = url.replace(/\/+$/, "");
  async function call<T>(kind: "mutation" | "query", path: string, args: Record<string, unknown>) {
    const response = await fetch(`${base}/api/${kind}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Convex ${adminKey}`,
      },
      body: JSON.stringify({ path, format: "convex_encoded_json", args: [args] }),
      // A wedged backend fails the run instead of hanging it.
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    // 560 is Convex's "the function failed" status; its body still carries the error.
    if (!response.ok && response.status !== 560) {
      throw new ConvexCallError(`${kind} ${path}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as
      | { status: "success"; value: T }
      | { status: "error"; errorMessage: string };
    if (body.status === "success") return body.value;
    throw new ConvexCallError(`${kind} ${path}: ${body.errorMessage}`);
  }
  return {
    url: base,
    mutation: (path, args) => call("mutation", path, args),
    query: (path, args) => call("query", path, args),
  };
}
