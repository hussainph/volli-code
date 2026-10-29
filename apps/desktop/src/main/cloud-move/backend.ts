/** All move calls use the person's own token, never a runner or agent credential. */
import type { MoveBackend } from "@volli/host-core/cloud-move";
import { OperationUnavailableError } from "@volli/shared";

export interface PersonMoveBackendOptions {
  url: string;
  enabled(): boolean;
  accessToken(): Promise<string | null>;
  /** The coordinator pauses its lane immediately instead of retrying with a lost sign-in. */
  onSignInLost?(): void;
  fetch?: typeof fetch;
}

export function personMoveBackend(options: PersonMoveBackendOptions): MoveBackend {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/u, "");
  const signedOut = () => {
    options.onSignInLost?.();
    // No data.code: the engine treats this as waiting, not a data problem to roll back.
    return new Error("Sign in as the person who started this move.");
  };
  const call = async (kind: "query" | "mutation" | "action", path: string, args: Record<string, unknown>): Promise<unknown> => {
    if (!options.enabled()) throw new OperationUnavailableError("Volli Cloud is off.");
    const token = await options.accessToken();
    if (token === null) throw signedOut();
    const response = await fetchImpl(`${base}/api/${kind}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ path, args, format: "json" }), signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) throw signedOut();
    let body: Record<string, unknown>;
    try { body = await response.json() as Record<string, unknown>; }
    catch { throw new Error("Volli Cloud did not answer the move."); }
    if (body?.status === "success") return body.value;
    if (body?.status === "error") {
      const raw = body.errorData;
      const data = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const code = typeof data.code === "string" && /^[a-z_]{1,80}$/u.test(data.code) ? data.code : "backend_error";
      if (code === "unauthenticated" || code === "no_viewer" || code === "identity_conflict") throw signedOut();
      // Only these numeric facts are needed for the changed-cloud rollback confirmation.
      const detail = code === "changed_since_commit" ? {
        ...(typeof data.boardChanges === "number" && Number.isSafeInteger(data.boardChanges) ? { boardChanges: data.boardChanges } : {}),
        ...(typeof data.sessionActive === "boolean" ? { sessionActive: data.sessionActive } : {}),
      } : {};
      throw Object.assign(new Error("Volli Cloud refused the move."), { data: { code, message: "Volli Cloud refused the move.", ...detail } });
    }
    throw new Error("Volli Cloud did not answer the move.");
  };
  return { query: (path, args) => call("query", path, args), mutation: (path, args) => call("mutation", path, args), action: (path, args) => call("action", path, args) };
}
