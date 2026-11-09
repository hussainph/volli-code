/** Person-authorized setup calls. Tokens live only in the mounted sheet, never in a store. */
import type { FunctionReturnType } from "convex/server";
import { cloudSession, type CloudApi } from "@renderer/lib/cloud-client";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { cloudFailure } from "@renderer/stores/cloud-board/source";

/** Use only known refusal codes: raw errors can contain commands or credentials. */
export function runnerSetupFailure(error: unknown, fallback: string): string {
  switch (cloudFailure(error).code) {
    case "unauthenticated":
    case "no_viewer":
    case "identity_conflict":
      return "Your sign-in needs attention. Open Settings → Account and sign in again.";
    case "account_deleted":
    case "account_deletion_pending":
    case "preview_waitlisted":
    case "preview_agreement_required":
    case "preview_access_required":
      return "Your account needs attention. Open Settings → Account to review your access.";
    case "forbidden":
    case "not_a_member":
    case "not_a_person":
      return "Your account cannot perform this action. Review your account and Workspace access.";
    case "rate_limited":
      return "Too many attempts. Wait a minute before trying again.";
    case "invalid_request":
      return "The request was refused. Check the runner name or code before trying again.";
    case "not_found":
      return "This request is no longer available. Start again with a fresh token or code.";
    default:
      return fallback;
  }
}

export type InstallGrant = FunctionReturnType<CloudApi["runners"]["createInstallToken"]>;
export type InstallStatus = FunctionReturnType<CloudApi["runners"]["installTokenStatus"]>;
export type LinkPreview = FunctionReturnType<CloudApi["runners"]["previewLink"]>;

export interface RunnerSetup {
  create(name: string): Promise<InstallGrant>;
  revoke(installTokenId: string): Promise<unknown>;
  watch(
    installTokenId: string,
    receive: (status: InstallStatus) => void,
    fail: () => void,
  ): () => void;
  preview(userCode: string): Promise<LinkPreview>;
  decide(
    requestId: string,
    userCode: string,
    decision: "approve" | "deny",
  ): Promise<{ ok: boolean }>;
}

export function runnerSetup(
  current = cloudSession,
  workspace = () => useCloudWorkspaceStore.getState().workspace?.id ?? null,
): RunnerSetup {
  const connected = () => {
    const session = current();
    if (!session?.client.connectionState().isWebSocketConnected) throw new Error("Not connected");
    return session;
  };
  return {
    create: (name) => {
      const { client, api } = connected();
      return client.action(api.runners.createInstallToken, {
        nameHint: name.trim() || null,
        defaultWorkspaceId: workspace(),
      });
    },
    revoke: (installTokenId) => {
      const { client, api } = connected();
      return client.mutation(api.runners.revokeInstallToken, { installTokenId });
    },
    watch: (installTokenId, receive, fail) => {
      try {
        const { client, api } = connected();
        const watch = client.watchQuery(api.runners.installTokenStatus, { installTokenId });
        const read = () => {
          try {
            const status = watch.localQueryResult();
            if (status !== undefined) receive(status);
          } catch {
            fail();
          }
        };
        const stop = watch.onUpdate(read);
        read();
        return stop;
      } catch {
        fail();
        return () => {};
      }
    },
    preview: (userCode) => {
      const { client, api } = connected();
      return client.mutation(api.runners.previewLink, { userCode });
    },
    decide: (requestId, userCode, decision) => {
      const { client, api } = connected();
      return client.mutation(api.runners.decideLink, { requestId, userCode, decision });
    },
  };
}
