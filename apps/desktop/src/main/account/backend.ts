/**
 * The account's calls into the backend: Convex's HTTP functions API
 * (`POST {url}/api/{query|mutation|action}`), authorized with the person's
 * access token. Three mutations here, all in `convex/functions/accounts.ts`;
 * the GitHub half's calls (`./github`) ride the same {@link convexCaller}. No
 * Convex client library rides in main for them.
 */

import type { PreviewAccess } from "@volli/shared/cloud";

/** What `accounts.ensureViewer` and the deletion mutations answer. */
export interface BackendViewer {
  readonly previewAccess: PreviewAccess;
  readonly previewAgreementAccepted: boolean;
  readonly userId: string;
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly status: "active" | "deletion_pending";
  readonly purgeAfter: number | null;
}

export interface AccountBackend {
  ensureViewer(
    accessToken: string,
    inviteCode?: string,
    acceptedAgreementVersion?: string,
  ): Promise<BackendViewer>;
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
  // Older or unknown backend replies never grant preview access.
  const previewAccess = record["previewAccess"] === "granted" ? "granted" : "waitlisted";
  return {
    userId,
    displayName,
    primaryEmail,
    status,
    purgeAfter,
    previewAccess,
    previewAgreementAccepted: record["previewAgreementAccepted"] === true,
  };
}

/** Which of Convex's HTTP functions endpoints a call goes to. */
export type ConvexFunctionKind = "query" | "mutation" | "action";

/**
 * One call into Convex's HTTP functions API (`POST {url}/api/{kind}`) with
 * the person's bearer token: the function's value, or a
 * {@link BackendRefusedError} carrying its typed `code`, or a plain error for
 * anything in transit.
 */
export type ConvexCall = (
  kind: ConvexFunctionKind,
  path: string,
  accessToken: string,
  args?: Record<string, string>,
) => Promise<unknown>;

export function convexCaller(options: {
  readonly url: string;
  readonly fetch?: typeof fetch;
}): ConvexCall {
  const base = options.url.replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  return async (kind, path, accessToken, args = {}) => {
    const response = await fetchImpl(`${base}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ path, args, format: "json" }),
      signal: AbortSignal.timeout(30_000),
    });
    let body: Record<string, unknown> = {};
    try {
      body = ((await response.json()) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (body["status"] === "success") return body["value"];
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
    if (response.status === 401 || response.status === 403) {
      // The deployment did not accept the token: a configuration or sign-in
      // problem the person must act on, not a network one.
      throw new BackendRefusedError("Volli Cloud did not accept this sign-in.", "unauthenticated");
    }
    throw new Error(`Volli Cloud answered ${response.status}.`);
  };
}

export function convexAccountBackend(options: {
  readonly url: string;
  readonly fetch?: typeof fetch;
}): AccountBackend {
  const call = convexCaller(options);
  const mutation = async (
    path: string,
    accessToken: string,
    args: Record<string, string> = {},
  ): Promise<BackendViewer> => viewerFrom(await call("mutation", path, accessToken, args));
  return {
    ensureViewer: (token, inviteCode, acceptedAgreementVersion) =>
      mutation("accounts:ensureViewer", token, {
        ...(inviteCode === undefined ? {} : { inviteCode }),
        ...(acceptedAgreementVersion === undefined ? {} : { acceptedAgreementVersion }),
      }),
    // The deletion's Actor names the client it came through.
    requestDeletion: (token) => mutation("accounts:requestDeletion", token, { via: "desktop" }),
    cancelDeletion: (token) => mutation("accounts:cancelDeletion", token, { via: "desktop" }),
  };
}
