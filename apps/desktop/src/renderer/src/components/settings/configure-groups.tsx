import { OverviewPane } from "./configure/overview-pane";
import {
  SettingsIcon,
  GuideIcon,
  CommandIcon,
  ProcessorIcon,
  KeyIcon,
  PaletteIcon,
  ConnectedIcon,
  TreeIcon,
} from "@renderer/components/ui/icon";

/** Project-specific settings and the shared agent pane definitions. */

import type { Project } from "@volli/shared";
import type * as React from "react";

import { LocalOnly } from "@renderer/components/hosts/local-only";

import { ProjectAppearanceSettings } from "./panes/project-appearance-pane";
import type { PrefGroup } from "@renderer/components/settings/kit";
import { CommandsPane } from "./configure/commands-pane";
import { McpPane } from "./configure/mcp-pane";
import { SessionsPane } from "./configure/sessions-pane";
import { SecretsPane } from "./configure/secrets-pane";
import { SkillsPane } from "./configure/skills-pane";
import { WorktreesPane } from "./configure/worktrees-pane";
import { useAddProject } from "@renderer/hooks/use-add-project";
import { SettingsProjectWelcome } from "./settings-scope";

function ChooseProject() {
  const addProject = useAddProject();
  return <SettingsProjectWelcome hasProjects={false} onOpen={() => void addProject()} />;
}

/** The one shared Skills/MCP inventory, outside project override navigation. */
export function globalAgentGroups(project: Project | null): readonly PrefGroup[] {
  if (project)
    return [
      {
        key: "agent",
        label: "Agent",
        categories: configureGroups(project)
          .flatMap((group) => group.categories)
          .filter((category) => category.key === "skills" || category.key === "mcp")
          .map((category) =>
            Object.assign({}, category, {
              content:
                category.key === "mcp" ? (
                  <McpPane project={{ id: "" }} />
                ) : (
                  local(project, <SkillsPane project={project} policyProjectPicker />)
                ),
            }),
          ),
      },
    ];
  return [
    {
      key: "agent",
      label: "Agent",
      categories: [
        {
          key: "skills",
          label: "Skills",
          icon: GuideIcon,
          keywords: ["global", "workspace", "mode", "source", "activation project"],
          content: <ChooseProject />,
        },
        {
          key: "mcp",
          label: "MCP Servers",
          icon: ConnectedIcon,
          keywords: ["server", "tools", "global"],
          content: <McpPane project={{ id: "" }} />,
        },
      ],
    },
  ];
}

/**
 * Project override panes read or write this Mac's own config for the project
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
          icon: GuideIcon,
          keywords: [
            "skill",
            "agents",
            "capability",
            "auto",
            "manual",
            "off",
            "index",
            "prompt budget",
            "activation project",
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
          icon: ConnectedIcon,
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
          key: "overview",
          label: "Overview",
          icon: SettingsIcon,
          keywords: [
            "global overrides",
            "reset",
            "defaults",
            "canvas",
            "mode",
            "chat model",
            "decision model",
          ],
          content: local(project, <OverviewPane project={project} />),
        },
        {
          key: "sessions",
          label: "Sessions",
          icon: ProcessorIcon,
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
          icon: TreeIcon,
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
          content: local(project, <WorktreesPane key={project.id} project={project} />),
        },
      ],
    },
  ];
}
