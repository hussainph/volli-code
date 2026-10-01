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
 * The Protection experiment (VC-480) swaps what the Authority entry draws, not
 * where it sits: the same key, so a selection survives the switch flipping,
 * labelled "Protection" and drawing `ProtectionPane` while it is on, and exactly
 * the Authority entry while it is off. The flag arrives as an argument rather
 * than a store read so the page that owns the rail re-derives it reactively.
 */
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import type { Project } from "@volli/shared";

import { ProjectAppearanceSettings } from "@renderer/components/pages/project-appearance-settings";
import type { PrefGroup } from "@renderer/components/settings/kit";
import { AuthorityPane } from "./configure/authority-pane";
import { CommandsPane } from "./configure/commands-pane";
import { McpPane } from "./configure/mcp-pane";
import { ProtectionPane } from "./configure/protection-pane";
import { SessionsPane } from "./configure/sessions-pane";
import { SkillsPane } from "./configure/skills-pane";
import { WorktreesPane } from "./configure/worktrees-pane";

/**
 * The Authority entry's search terms. Held apart because the Protection
 * experiment extends them: the rail matches a lowercased SUBSTRING of a stored
 * term, so every label the Protection page draws needs one here too.
 */
const AUTHORITY_KEYWORDS: readonly string[] = [
  "authority",
  "permission",
  "permissions",
  "policy",
  "enforce",
  "observe",
  "sandbox",
  "guardrail",
  "approval",
  "escalation",
  "denial",
  "transcript",
  "peek",
  "auto mode",
  // The row labels, so rail search finds the page from what is on
  // it — `settings-search-smoke.mjs` walks every visible label and
  // holds this list to that contract.
  "rule enforcement",
  // The whole label, em dash included, because the rail matches a
  // lowercased SUBSTRING of a stored term: "decision mode" alone
  // could not be found by someone typing what the row says. VC-285
  // renamed this row from "Who judges the rest" and the old term
  // went with it — a keyword for a label nobody can see finds
  // nothing and hides the one that is missing.
  "decision mode \u2014 not active yet",
  "ask me after",
  "or after, in total",
  "you can read",
  "an authenticated session can read",
  "an unauthenticated caller can read",
];

/**
 * What the Protection page adds, only while it is the page drawn — a term for
 * a page nobody can see would land a search on one that cannot answer it. The
 * section titles are whole, for the same substring reason as above.
 */
const PROTECTION_KEYWORDS: readonly string[] = [
  "protection",
  "protect",
  "protection is on",
  "protection is off",
  "approved actions",
  "approvals",
  "ledger",
  "revoke",
  "advanced",
  "transcripts a session can read",
];

export function configureGroups(
  project: Project,
  { protection = false }: { protection?: boolean } = {},
): readonly PrefGroup[] {
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
          content: <SkillsPane project={project} />,
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
          content: <CommandsPane project={project} />,
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
          content: <McpPane project={project} />,
        },
        {
          // Agent, not Project: this is what this repo's agents are ALLOWED to
          // do, which is the same question Skills and Commands answer about
          // what they can reach. It is also the only surface in the product
          // that writes authority policy — no agent verb projects it, by
          // design (VC-172).
          key: "authority",
          label: protection ? "Protection" : "Authority",
          icon: ShieldCheckIcon,
          keywords: protection
            ? [...AUTHORITY_KEYWORDS, ...PROTECTION_KEYWORDS]
            : AUTHORITY_KEYWORDS,
          content: protection ? (
            <ProtectionPane project={project} />
          ) : (
            <AuthorityPane project={project} />
          ),
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
