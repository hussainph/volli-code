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
  signal?(): AbortSignal | undefined;
}

const forbidden = () =>
  Object.assign(new Error("Your role cannot perform this move."), {
    data: { code: "forbidden", message: "Your role cannot perform this move." },
  });

export function personMoveBackend(
  options: PersonMoveBackendOptions,
): MoveBackend & { dispose(): void } {
  const lifetime = new AbortController();
  const fetchImpl = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/u, "");
  const signedOut = () => {
    options.onSignInLost?.();
    // No data.code: the engine treats this as waiting, not a data problem to roll back.
    return Object.assign(new Error("Sign in as the person who started this move."), {
      code: "move_signed_out",
    });
  };
  const call = async (
    kind: "query" | "mutation" | "action",
    path: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!options.enabled()) throw new OperationUnavailableError("Volli Cloud is off.");
    const token = await options.accessToken();
    if (token === null) throw signedOut();
    lifetime.signal.throwIfAborted();
    const callerSignal = options.signal?.();
    const response = await fetchImpl(`${base}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ path, args, format: "json" }),
      signal: AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(30_000),
        ...(callerSignal === undefined ? [] : [callerSignal]),
      ]),
    });
    if (response.status === 401) throw signedOut();
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      if (response.status === 403) throw forbidden();
      throw new Error("Volli Cloud did not answer the move.");
    }
    if (body?.status === "success" && response.ok) return body.value;
    if (body?.status === "error") {
      // Older deployments have no re-arm query. Keep its local result list useful
      // without exposing Convex's raw error or classifying other move calls differently.
      if (
        path === "projectImports:rearmList" &&
        typeof body.errorMessage === "string" &&
        body.errorMessage.includes("Could not find public function")
      )
        throw Object.assign(new Error("Paused Automation details are not available yet."), {
          data: { code: "feature_unavailable" },
        });
      const raw = body.errorData;
      const data =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      if (typeof data.code !== "string" || !/^[a-z_]{1,80}$/u.test(data.code))
        throw new Error("Volli Cloud did not answer the move.");
      const code = data.code;
      if (code === "unauthenticated" || code === "no_viewer" || code === "identity_conflict")
        throw signedOut();
      // Only these numeric facts are needed for the changed-cloud rollback confirmation.
      const detail =
        code === "changed_since_commit"
          ? {
              ...(typeof data.boardChanges === "number" && Number.isSafeInteger(data.boardChanges)
                ? { boardChanges: data.boardChanges }
                : {}),
              ...(typeof data.sessionActive === "boolean"
                ? { sessionActive: data.sessionActive }
                : {}),
            }
          : {};
      throw Object.assign(new Error("Volli Cloud refused the move."), {
        data: { code, message: "Volli Cloud refused the move.", ...detail },
      });
    }
    if (response.status === 403) throw forbidden();
    throw new Error("Volli Cloud did not answer the move.");
  };
  return {
    dispose: () => lifetime.abort(),
    query: (path, args) => call("query", path, args),
    mutation: (path, args) => call("mutation", path, args),
    action: (path, args) => call("action", path, args),
  };
}
