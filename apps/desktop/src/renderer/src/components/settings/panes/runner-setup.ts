/** Person-authorized setup calls. Tokens live only in the mounted sheet, never in a store. */
import type { FunctionReturnType } from "convex/server";
import { cloudSession, type CloudApi } from "@renderer/lib/cloud-client";

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

export function runnerSetup(current = cloudSession): RunnerSetup {
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
        defaultWorkspaceId: null,
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
