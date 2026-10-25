/**
 * The account's calls into the backend: Convex's HTTP functions API
 * (`POST {url}/api/mutation`), authorized with the person's access token.
 * Three mutations, all in `convex/functions/accounts.ts`; no Convex client
 * library rides in main for them.
 */

/** What `accounts.ensureViewer` and the deletion mutations answer. */
export interface BackendViewer {
  readonly userId: string;
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly status: "active" | "deletion_pending";
  readonly purgeAfter: number | null;
}

export interface AccountBackend {
  ensureViewer(accessToken: string): Promise<BackendViewer>;
  requestDeletion(accessToken: string): Promise<BackendViewer>;
  cancelDeletion(accessToken: string): Promise<BackendViewer>;
}

/** The backend answered, and refused: its typed `code` and its sentence. */
export class BackendRefusedError extends Error {
  readonly name = "BackendRefusedError";
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

function viewerFrom(value: unknown): BackendViewer {
  const record = (value ?? {}) as Record<string, unknown>;
  const { userId, displayName, primaryEmail, status, purgeAfter } = record;
  if (
    typeof userId !== "string" ||
    typeof displayName !== "string" ||
    (primaryEmail !== null && typeof primaryEmail !== "string") ||
    (status !== "active" && status !== "deletion_pending") ||
    (purgeAfter !== null && typeof purgeAfter !== "number")
  ) {
    throw new Error("Volli Cloud answered with an account this build cannot read.");
  }
  return { userId, displayName, primaryEmail, status, purgeAfter };
}

export function convexAccountBackend(options: {
  readonly url: string;
  readonly fetch?: typeof fetch;
}): AccountBackend {
  const base = options.url.replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const mutation = async (path: string, accessToken: string): Promise<BackendViewer> => {
    const response = await fetchImpl(`${base}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ path, args: {}, format: "json" }),
      signal: AbortSignal.timeout(30_000),
    });
    let body: Record<string, unknown> = {};
    try {
      body = ((await response.json()) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (body["status"] === "success") return viewerFrom(body["value"]);
    if (body["status"] === "error") {
      const data = body["errorData"] as Record<string, unknown> | undefined;
      const message =
        typeof data?.["message"] === "string"
          ? data["message"]
          : typeof body["errorMessage"] === "string"
            ? body["errorMessage"]
            : "Volli Cloud refused the request.";
      throw new BackendRefusedError(
        message.slice(0, 300),
        typeof data?.["code"] === "string" ? data["code"] : null,
      );
    }
    throw new Error(`Volli Cloud answered ${response.status}.`);
  };
  return {
    ensureViewer: (token) => mutation("accounts:ensureViewer", token),
    requestDeletion: (token) => mutation("accounts:requestDeletion", token),
    cancelDeletion: (token) => mutation("accounts:cancelDeletion", token),
  };
}
