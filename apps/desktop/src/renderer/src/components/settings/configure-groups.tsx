/**
 * The Configure rail: two groups, seven categories, this project always.
 *
 * AGENT CONFIG LANDS HERE because agent config *is* project-scoped — which
 * skills a repo's agents can reach and which commands it defines. Putting it
 * in Settings was the original surface's central confusion: the same words
 * appeared on both pages with no way to tell which one won.
 *
 * Project is the rest: how this repo's sessions, theming and worktrees behave.
 *
 */
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import type { Project } from "@volli/shared";
import type * as React from "react";

import { LocalOnly } from "@renderer/components/hosts/local-only";

import { ProjectAppearanceSettings } from "@renderer/components/pages/project-appearance-settings";
import type { PrefGroup } from "@renderer/components/settings/kit";
import { CommandsPane } from "./configure/commands-pane";
import { McpPane } from "./configure/mcp-pane";
import { SessionsPane } from "./configure/sessions-pane";
import { SecretsPane } from "./configure/secrets-pane";
import { SkillsPane } from "./configure/skills-pane";
import { WorktreesPane } from "./configure/worktrees-pane";

/**
 * Every Configure pane reads or writes this Mac's own config for the project
 * (its files, MCP servers, secrets, worktrees): for a remote project's, each
 * says "Not available on <host> yet" until its host serves them (VC-711).
 */
function local(project: Project, content: React.ReactNode): React.ReactNode {
  return <LocalOnly projectId={project.id}>{content}</LocalOnly>;
}

export function configureGroups(project: Project): readonly PrefGroup[] {
  return [
    {
      key: "agent",
      label: "Agent",
      categories: [
        {
          key: "skills",
          fill: true,
          label: "Skills",
          icon: BookOpenIcon,
          keywords: [
            "skill",
            "agents",
            "capability",
            "auto",
            "manual",
            "off",
            "index",
            "prompt budget",
            "source",
            "description",
            "mode",
          ],
          content: local(project, <SkillsPane project={project} />),
        },
        {
          key: "commands",
          fill: true,
          label: "Commands",
          icon: CommandIcon,
          keywords: [
            "command",
            "slash",
            "prompt",
            "template",
            "new command",
            "description",
            "source",
            "this project",
            "personal",
          ],
          content: local(project, <CommandsPane project={project} />),
        },
        {
          key: "mcp",
          // NOT a `fill` pane (VC-397). `fill` is for a pane where the table IS
          // the page; this one has an editor and an audit list after its table,
          // and a filling section whose content outgrew the leftover height
          // painted straight through both of them.
          label: "MCP Servers",
          icon: PlugsConnectedIcon,
          keywords: [
            "mcp",
            "server",
            "servers",
            "tool",
            "tools",
            "context protocol",
            "status",
            "stdio",
            "streamable http",
            // The editor section's two titles. Rail search matches a
            // lowercased SUBSTRING of a stored term, so "server" alone does
            // not answer someone typing the whole label — and
            // `settings-search-smoke.mjs` walks every visible one.
            "add server",
            "edit server",
          ],
          content: local(project, <McpPane project={project} />),
        },
        {
          key: "secrets",
          label: "Secrets",
          icon: KeyIcon,
          keywords: [
            "secret",
            "credential",
            "scope",
            "last used",
            "replacement credential",
            "replace",
            "revoke",
            "refresh",
          ],
          content: local(project, <SecretsPane project={project} />),
        },
      ],
    },
    {
      key: "project",
      label: "Project",
      categories: [
        {
          key: "sessions",
          label: "Sessions",
          icon: CpuIcon,
          keywords: [
            "chat",
            "model",
            "agents.md",
            "claude.md",
            "instructions",
            "new chats",
            "precedence",
            "override",
            "decision model",
            "classifier",
          ],
          content: local(project, <SessionsPane project={project} />),
        },
        {
          key: "appearance",
          label: "Appearance",
          icon: PaletteIcon,
          keywords: [
            "theme",
            "app theme",
            "dark",
            "light",
            "canvas",
            "terminal",
            "override",
            "mode",
            "config file",
          ],
          content: local(project, <ProjectAppearanceSettings project={project} />),
        },
        {
          key: "worktrees",
          label: "Worktrees",
          icon: TreeStructureIcon,
          keywords: [
            "worktree",
            "branch",
            "base",
            "setup",
            "copy",
            "copied files",
            "worktreeinclude",
            "env",
            "then run",
            "branch from",
            "new worktrees",
          ],
          content: local(project, <WorktreesPane project={project} />),
        },
      ],
    },
  ];
}
