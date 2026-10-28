import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import type { PrefCategory } from "./kit";
import { WorkspacePane } from "./panes/workspace-pane";

/** Only offered next to Runners in a cloud launch. */
export function workspaceCategory(): PrefCategory {
  return {
    key: "workspace",
    label: "Workspace",
    icon: UsersIcon,
    keywords: [
      "workspace",
      "name",
      "rename",
      "your role",
      "membership",
      "leave",
      "members",
      "owner",
      "admin",
      "remove",
      "invite",
      "invites",
      "invitations to you",
      "email",
      "code",
      "copy invite",
      "new code",
      "revoke",
      "join",
      "sharing",
      "make everything shared",
      "who can invite",
    ],
    content: <WorkspacePane />,
  };
}
