/**
 * The Configure rail: two groups, seven categories, this project always.
 *
 * AGENT CONFIG LANDS HERE because agent config *is* project-scoped — which
 * skills a repo's agents can reach, which commands it defines, which harness
 * its sessions start on. Putting it in Settings was the original surface's
 * central confusion: the same words appeared on both pages with no way to tell
 * which one won.
 *
 * Project is the rest: how this repo's sessions, theming and worktrees behave.
 */
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import type { Project } from "@volli/shared";

import { ProjectAppearanceSettings } from "@renderer/components/pages/project-appearance-settings";
import type { PrefGroup } from "@renderer/components/settings/kit";
import { CommandsPane } from "./configure/commands-pane";
import { McpPane } from "./configure/mcp-pane";
import { PluginsPane } from "./configure/plugins-pane";
import { SessionsPane } from "./configure/sessions-pane";
import { SkillsPane } from "./configure/skills-pane";
import { WorktreesPane } from "./configure/worktrees-pane";

export function configureGroups(project: Project): readonly PrefGroup[] {
  return [
    {
      key: "agent",
      label: "Agent",
      categories: [
        {
          key: "skills",
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
          content: <SkillsPane project={project} />,
        },
        {
          key: "commands",
          label: "Commands",
          icon: CommandIcon,
          keywords: ["command", "slash", "prompt", "template", "new command", "description"],
          content: <CommandsPane project={project} />,
        },
        {
          key: "mcp",
          label: "MCP Servers",
          icon: PlugsConnectedIcon,
          keywords: ["mcp", "server", "servers", "tool", "tools", "context protocol", "status"],
          content: <McpPane />,
        },
        {
          key: "plugins",
          label: "Plugins",
          icon: PuzzlePieceIcon,
          keywords: ["plugin", "bundle", "marketplace", "installed", "contents", "browse"],
          content: <PluginsPane />,
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
            "harness",
            "model",
            "claude code",
            "codex",
            "agents.md",
            "claude.md",
            "instructions",
            "new sessions",
            "precedence",
            "override",
          ],
          content: <SessionsPane project={project} />,
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
          content: <ProjectAppearanceSettings project={project} />,
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
          content: <WorktreesPane project={project} />,
        },
      ],
    },
  ];
}
