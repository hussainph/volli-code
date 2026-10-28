/** The rail's account-scoped reads and writes, using the Workspace pane's client guards. */
import * as React from "react";
import { toast } from "sonner";

import { cloudSession, followCloudSession, type CloudSession } from "@renderer/lib/cloud-client";
import { toastError } from "@renderer/lib/toast";
import { selectCloudWorkspace } from "@renderer/stores/cloud-board/workspace";
import {
  useWorkspaceRead,
  useWorkspaceReadOnly,
  writeWorkspace,
} from "@renderer/components/settings/panes/use-workspace";
import type { FollowSession } from "@renderer/components/settings/panes/use-runners";

const reads = {
  workspaces: (s: CloudSession) => s.client.watchQuery(s.api.workspaces.listMine, {}),
  mine: (s: CloudSession) => s.client.watchQuery(s.api.invites.listMine, {}),
};

export function useWorkspaceSwitcher({
  follow = followCloudSession,
  current = cloudSession,
  select = selectCloudWorkspace,
}: {
  follow?: FollowSession;
  current?: () => CloudSession | null;
  select?: (id: string) => Promise<void>;
} = {}) {
  const readOnly = useWorkspaceReadOnly(follow);
  const [attempt, setAttempt] = React.useState(0);
  const workspaces = useWorkspaceRead(follow, attempt, "viewer", reads.workspaces);
  const mine = useWorkspaceRead(follow, attempt, "viewer", reads.mine);
  const commands = React.useMemo(() => {
    const open = async (run: (s: CloudSession) => Promise<{ workspaceId: string }>) => {
      const joined = await writeWorkspace(current, run);
      try {
        await select(joined.workspaceId);
      } catch (error) {
        throw new Error(
          `Workspace ready, but couldn’t open it: ${error instanceof Error ? error.message : "Try again."}`,
          { cause: error },
        );
      }
    };
    return {
      select: (id: string) => writeWorkspace(current, async () => select(id)),
      create: (workspaceId: string, name: string) =>
        open(({ client, api }) => client.mutation(api.workspaces.create, { workspaceId, name })),
      preview: (token: string) =>
        writeWorkspace(current, ({ client, api }) => client.query(api.invites.preview, { token })),
      joinCode: (token: string) =>
        open(({ client, api }) => client.mutation(api.invites.acceptLink, { token })),
      join: (inviteId: string) =>
        open(({ client, api }) => client.mutation(api.invites.accept, { inviteId })),
    };
  }, [current, select]);
  const seen = React.useRef(new Set<string>());
  const shown = React.useRef(new Set<string>());
  const joining = React.useRef(new Set<string>());
  // Stable ids dedupe repeated live answers. Removing/revoking an invitation
  // removes its action too; reconnecting does not toast it a second time.
  React.useEffect(() => {
    const active = new Set(
      mine.kind === "ready" && !readOnly ? mine.value.map((i) => i.inviteId) : [],
    );
    for (const id of shown.current) {
      if (!active.has(id)) {
        toast.dismiss(`workspace-invite:${id}`);
        shown.current.delete(id);
      }
    }
    if (mine.kind !== "ready" || readOnly) return;
    for (const invite of mine.value) {
      if (seen.current.has(invite.inviteId)) continue;
      seen.current.add(invite.inviteId);
      shown.current.add(invite.inviteId);
      toast(`${invite.invitedByName} invited you to ${invite.workspaceName}`, {
        id: `workspace-invite:${invite.inviteId}`,
        action: {
          label: "Join",
          onClick: () => {
            if (joining.current.has(invite.inviteId)) return;
            joining.current.add(invite.inviteId);
            void commands
              .join(invite.inviteId)
              .catch((error: unknown) => {
                toastError(error instanceof Error ? error.message : "Couldn’t join the Workspace.");
              })
              .finally(() => joining.current.delete(invite.inviteId));
          },
        },
      });
    }
  }, [mine, readOnly, commands]);
  React.useEffect(
    () => () => {
      for (const id of shown.current) toast.dismiss(`workspace-invite:${id}`);
    },
    [],
  );
  return {
    workspaces,
    readOnly,
    commands,
    retry: () => setAttempt((n) => n + 1),
    mine,
  };
}
