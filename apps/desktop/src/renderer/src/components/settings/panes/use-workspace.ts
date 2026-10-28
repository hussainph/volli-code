/** Settings → Workspace: live reads and explicit writes on the window's cloud client. */
import * as React from "react";
import type { FunctionReturnType } from "convex/server";
import type { MemberRole, WhoCanInvite } from "@volli/shared/cloud";

import {
  cloudSession,
  followCloudSession,
  type CloudApi,
  type CloudSession,
} from "@renderer/lib/cloud-client";
import { NOT_CONNECTED } from "@renderer/lib/cloud-board-api";
import { useCloudLinkInputs } from "@renderer/stores/cloud-link";
import { CLOUD_READ_ONLY, cloudFailure, type Watched } from "@renderer/stores/cloud-board/source";
import {
  selectCloudWorkspace,
  useCloudWorkspaceStore,
} from "@renderer/stores/cloud-board/workspace";
import type { FollowSession, Loaded } from "./use-runners";

export type Member = FunctionReturnType<CloudApi["members"]["list"]>[number];
// TODO(VC-971 PR 1): use the generated sponsored-preview fields once the API ships them.
type Preview = { readonly preview?: string };
export type PendingInvite = FunctionReturnType<CloudApi["invites"]["list"]>[number] & Preview;
export type CreatedInvite = FunctionReturnType<CloudApi["invites"]["create"]> & Preview;

const reads = {
  workspace: (s: CloudSession, id: string) =>
    s.client.watchQuery(s.api.workspaces.get, { workspaceId: id }),
  policy: (s: CloudSession, id: string) =>
    s.client.watchQuery(s.api.workspaces.policy, { workspaceId: id }),
  members: (s: CloudSession, id: string) =>
    s.client.watchQuery(s.api.members.list, { workspaceId: id }),
  invites: (s: CloudSession, id: string) =>
    s.client.watchQuery(s.api.invites.list, { workspaceId: id }),
  mine: (s: CloudSession) => s.client.watchQuery(s.api.invites.listMine, {}),
  viewer: (s: CloudSession) => s.client.watchQuery(s.api.accounts.viewer, {}),
};

/** Retains this scope's last live answer during a socket outage, never across scopes/clients. */
function useRead<Value>(
  follow: FollowSession,
  attempt: number,
  scope: string | null,
  read: (s: CloudSession, id: string) => Watched<Value>,
): Loaded<Value> {
  const [state, setState] = React.useState<{ scope: string | null; view: Loaded<Value> }>({
    scope,
    view: { kind: "loading" },
  });
  React.useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    setState({ scope, view: { kind: "loading" } });
    const stopFollow = follow((session) => {
      stop?.();
      stop = undefined;
      if (!active) return;
      setState({ scope, view: { kind: "loading" } });
      if (session === null || scope === null) return;
      const watch = read(session, scope);
      const update = () => {
        if (!active) return;
        try {
          const value = watch.localQueryResult();
          setState({
            scope,
            view: value === undefined ? { kind: "loading" } : { kind: "ready", value },
          });
        } catch (error) {
          setState({ scope, view: { kind: "failed", message: cloudFailure(error).message } });
        }
      };
      stop = watch.onUpdate(update);
      update();
    });
    return () => {
      active = false;
      stop?.();
      stopFollow();
    };
  }, [follow, attempt, scope, read]);
  return state.scope === scope ? state.view : { kind: "loading" };
}

async function write<T>(
  current: () => CloudSession | null,
  run: (s: CloudSession) => Promise<T>,
): Promise<T> {
  const session = current();
  if (session === null || !session.client.connectionState().isWebSocketConnected)
    throw new Error(NOT_CONNECTED);
  const input = useCloudLinkInputs.getState().input;
  if (input.snapshotAt !== null || !input.online) throw new Error(CLOUD_READ_ONLY);
  try {
    return await run(session);
  } catch (error) {
    throw new Error(cloudFailure(error).message, { cause: error });
  }
}

export function useWorkspace({
  follow = followCloudSession,
  current = cloudSession,
  select = selectCloudWorkspace,
}: {
  follow?: FollowSession;
  current?: () => CloudSession | null;
  select?: (workspaceId: string) => Promise<void>;
} = {}) {
  const workspaceId = useCloudWorkspaceStore((s) => s.workspace?.id ?? null);
  const snapshotAt = useCloudLinkInputs((s) => s.input.snapshotAt);
  const online = useCloudLinkInputs((s) => s.input.online);
  const [connected, setConnected] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let stop: (() => void) | undefined;
    const unfollow = follow((s) => {
      stop?.();
      stop = undefined;
      const update = () => setConnected(s?.client.connectionState().isWebSocketConnected === true);
      update();
      stop = s?.client.subscribeToConnectionState(update);
    });
    return () => {
      stop?.();
      unfollow();
    };
  }, [follow]);
  const workspace = useRead(follow, attempt, workspaceId, reads.workspace);
  const policy = useRead(follow, attempt, workspaceId, reads.policy);
  const members = useRead(follow, attempt, workspaceId, reads.members);
  const invites = useRead(follow, attempt, workspaceId, reads.invites) as Loaded<
    readonly PendingInvite[]
  >;
  const mine = useRead(follow, attempt, "viewer", reads.mine);
  const viewer = useRead(follow, attempt, "viewer", reads.viewer);
  const commands = React.useMemo(() => {
    const scoped = <T>(run: (s: CloudSession, id: string) => Promise<T>) =>
      write(current, (s) => {
        if (workspaceId === null) throw new Error("No Workspace selected.");
        return run(s, workspaceId);
      });
    const create = (email: string | null, role: MemberRole): Promise<CreatedInvite> =>
      scoped(({ client, api }, id) =>
        client.mutation(api.invites.create, { workspaceId: id, email, role }),
      );
    const revoke = (inviteId: string) =>
      write(current, ({ client, api }) => client.mutation(api.invites.revoke, { inviteId }));
    return {
      rename: (name: string) =>
        scoped(({ client, api }, id) =>
          client.mutation(api.workspaces.rename, { workspaceId: id, name }),
        ),
      leave: () =>
        scoped(({ client, api }, id) => client.mutation(api.members.leave, { workspaceId: id })),
      setRole: (userId: string, role: MemberRole) =>
        scoped(({ client, api }, id) =>
          client.mutation(api.members.setRole, { workspaceId: id, userId, role }),
        ),
      remove: (userId: string) =>
        scoped(({ client, api }, id) =>
          client.mutation(api.members.remove, { workspaceId: id, userId }),
        ),
      setPolicy: (
        patch: { shareAll?: boolean; whoCanInvite?: WhoCanInvite },
        expectedRevision: number,
      ) =>
        scoped(({ client, api }, id) =>
          client.mutation(api.workspaces.setPolicy, {
            workspaceId: id,
            ...patch,
            expectedRevision,
          }),
        ),
      create,
      revoke,
      newCode: async (invite: PendingInvite) => {
        // Email creation reissues atomically; a code must be revoked before replacing it.
        if (invite.email === null) await revoke(invite.inviteId);
        return create(invite.email, invite.role);
      },
      join: async (inviteId: string) => {
        const joined = await write(current, ({ client, api }) =>
          client.mutation(api.invites.accept, { inviteId }),
        );
        try {
          await select(joined.workspaceId);
        } catch (error) {
          throw new Error(
            `Joined the Workspace, but couldn’t open it: ${error instanceof Error ? error.message : "Try again."}`,
            { cause: error },
          );
        }
      },
    };
  }, [current, select, workspaceId]);
  return {
    workspaceId,
    workspace,
    policy,
    members,
    invites,
    mine,
    viewer,
    commands,
    readOnly: !connected || !online || snapshotAt !== null,
    retry: () => setAttempt((n) => n + 1),
  };
}
