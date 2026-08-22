/**
 * VC-111 — the proposed **Configure** surface (this project's agent setup).
 *
 * The brief: "Configure becomes the new home for workspace agent configuration
 * — Skills, Plugins, MCPs, etc. — since I want them easily accessible and
 * editable."
 *
 * That gives Configure an identity it has never had. Today it is three
 * categories, two of which are barely settings at all: a General card with two
 * Input+Save fields, an Appearance card that duplicates Settings, and a
 * Worktrees card that is two paragraphs of prose about `.worktreeinclude`.
 * Under this pass, theming leaves (it is a preference, and Settings' `ScopeBar`
 * absorbs it) and the agent's whole configurable surface arrives.
 *
 * ── WHY THIS IS THE BIG WIN ───────────────────────────────────────────────
 * Skills, commands and MCP servers are already REAL in this codebase and have
 * NO user interface whatsoever. `main/skills.ts` reads
 * `<project>/.agents/skills/` and `~/.agents/skills/`; `main/prompt-templates.ts`
 * reads `<project>/.volli/commands/` and `<userData>/commands/`. Both merge
 * project-over-personal. Both are invisible unless you type `/` in a composer
 * and notice what appears. So "add a Skills page" is mostly *surfacing what
 * already loads*, not new plumbing.
 *
 * This is also precisely the move Cursor made: their Customize page put
 * plugins, skills, MCP, subagents, rules, commands and hooks in ONE place
 * filtered by scope, explicitly so people stop "switching between separate
 * settings pages".
 * ──────────────────────────────────────────────────────────────────────────
 *
 * THE ONE VOCABULARY RULE THIS PAGE ADDS: every item here comes from either
 * this project or your personal directory, and every list says which with the
 * same chip in the same place. That is the `Origin` primitive doing the same
 * job it does for Ghostty provenance in Settings — one drawing, one meaning.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";

import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";

import {
  CommitField,
  Health,
  ItemList,
  ItemRow,
  Origin,
  PrefRow,
  PrefSection,
  SectionAction,
  type PrefGroup,
} from "./kit";

/* -------------------------------------------------------------------------- */

/** Where an item was found. The one chip, used identically by all four agent lists. */
function Where({ project }: { project: boolean }) {
  return <Origin mine={project}>{project ? "This project" : "Personal"}</Origin>;
}

/**
 * Skills — `.agents/skills/<slug>/SKILL.md`, project tier over personal tier.
 *
 * Everything in this list already loads today (`main/skills.ts`) and there has
 * never been a way to see it, let alone switch one off. The switch is the one
 * genuinely new capability: today a skill on disk is a skill in the model's
 * index, and the only way to remove it is to move the directory.
 *
 * A skill shadowed by a same-named project skill says so on its own row rather
 * than vanishing — the merge is `mergeSkills`' project-over-personal rule made
 * visible, because a personal skill that silently stops applying in one repo is
 * exactly the kind of thing you lose an afternoon to.
 */
function SkillsPane() {
  return (
    // NO section title: the pane header already says "Skills", and a card that
    // repeats its own page's masthead is the kind of redundancy that makes a
    // settings surface feel padded. A single-list pane states the subject once,
    // in the header, and the section carries only what the header cannot — the
    // provenance line and the action.
    <PrefSection
      icon={BookOpenIcon}
      description="Loaded from .agents/skills. The agent picks these up when they're relevant."
      action={<SectionAction label="Reveal folder" icon={FolderOpenIcon} />}
    >
      <ItemList placeholder="Search skills" empty="No skills match.">
        {[
          { name: "tdd", meta: "Test-driven development", project: true, on: true },
          {
            name: "code-review",
            meta: "Review a branch against standards",
            project: true,
            on: true,
          },
          { name: "diagnose", meta: "Disciplined loop for hard bugs", project: false, on: true },
          {
            name: "writing-for-agents",
            meta: "Writing skills and AGENTS.md",
            project: false,
            on: true,
          },
          {
            name: "svelte-code-writer",
            meta: "Shadowed by this project's own copy",
            project: false,
            on: false,
          },
          { name: "mintlify", meta: "Build Mintlify docs sites", project: false, on: false },
          {
            name: "research",
            meta: "Investigate against primary sources",
            project: false,
            on: true,
          },
        ].map((skill) => (
          <ItemRow
            key={skill.name}
            name={skill.name}
            meta={skill.meta}
            badges={<Where project={skill.project} />}
          >
            <Button size="icon-xs" variant="ghost" aria-label={`Open ${skill.name}`}>
              <ArrowSquareOutIcon />
            </Button>
            <Switch defaultChecked={skill.on} aria-label={`Enable ${skill.name}`} />
          </ItemRow>
        ))}
      </ItemList>
    </PrefSection>
  );
}

/**
 * Commands — `.volli/commands/*.md` and `<userData>/commands/*.md`, the `/`
 * picker's supply. Same merge rule, same chip, same list shape as Skills.
 *
 * Drawn identically to Skills ON PURPOSE. They are two directories of markdown
 * with frontmatter, read by the same parser, merged by the same rule; the whole
 * argument of this redesign is that two things that are the same shape should
 * not be two shapes.
 */
function CommandsPane() {
  return (
    <PrefSection
      icon={CommandIcon}
      description="Read from .volli/commands and your personal commands folder."
      action={<SectionAction label="New command" icon={PlusIcon} />}
    >
      <ItemList placeholder="Search commands" empty="No commands match.">
        {[
          { name: "/ship", meta: "Open a PR with the ticket body as description", project: true },
          { name: "/audit", meta: "Read a surface and list what's wrong", project: true },
          { name: "/handoff", meta: "Compact this conversation for another agent", project: false },
          { name: "/grill", meta: "Stress-test a plan", project: false },
        ].map((command) => (
          <ItemRow
            key={command.name}
            name={command.name}
            meta={command.meta}
            badges={<Where project={command.project} />}
          >
            <Button size="icon-xs" variant="ghost" aria-label={`Edit ${command.name}`}>
              <ArrowSquareOutIcon />
            </Button>
          </ItemRow>
        ))}
      </ItemList>
    </PrefSection>
  );
}

/**
 * MCP servers — genuinely new plumbing, and the one pane here that needs a
 * health dot, because an MCP server is the only thing on this page that can be
 * *configured correctly and still not working*.
 *
 * Note what the failing row does NOT do: it does not print the spawn command,
 * the exit code or the stderr tail. Same rule as About — one sentence, one
 * button, internals on request.
 */
function McpPane() {
  return (
    <>
      <PrefSection
        icon={PlugsConnectedIcon}
        description="Each server is a set of tools the agent can call."
        action={<SectionAction label="Add server" icon={PlusIcon} />}
      >
        <ItemRow
          name="linear"
          meta="12 tools · issues, projects, cycles"
          badges={<Where project />}
        >
          <Health state="ready">Connected</Health>
          <Switch defaultChecked aria-label="Enable linear" />
        </ItemRow>
        <ItemRow name="sentry" meta="6 tools · issues, releases" badges={<Where project />}>
          <Health state="ready">Connected</Health>
          <Switch defaultChecked aria-label="Enable sentry" />
        </ItemRow>
        <ItemRow
          name="postgres"
          meta="Couldn't start — check the connection string"
          badges={<Where project={false} />}
        >
          <Health state="error">Failed</Health>
          <Button size="sm" variant="outline">
            Fix
          </Button>
        </ItemRow>
        <ItemRow name="figma" meta="4 tools · files, comments" badges={<Where project={false} />}>
          <Health state="idle">Off</Health>
          <Switch aria-label="Enable figma" />
        </ItemRow>
      </PrefSection>
    </>
  );
}

/** Plugins — bundles that install skills, commands and MCP servers together. */
function PluginsPane() {
  return (
    <PrefSection
      icon={PuzzlePieceIcon}
      description="Installing a plugin installs everything inside it."
      action={<SectionAction label="Browse…" icon={PlusIcon} />}
    >
      <ItemRow
        name="matt-pocock-engineering"
        meta="9 skills · 3 commands"
        badges={<Where project />}
      >
        <Button size="sm" variant="outline">
          Manage
        </Button>
        <Switch defaultChecked aria-label="Enable matt-pocock-engineering" />
      </ItemRow>
      <ItemRow
        name="emil-design-eng"
        meta="4 skills · 1 command"
        badges={<Where project={false} />}
      >
        <Button size="sm" variant="outline">
          Manage
        </Button>
        <Switch defaultChecked aria-label="Enable emil-design-eng" />
      </ItemRow>
    </PrefSection>
  );
}

/**
 * Sessions — what a new Session in THIS project starts as.
 *
 * Audit item 30: today model defaults, harness choice and web access are all
 * app-wide only, while appearance — the least consequential of them — got full
 * per-project scoping. This pane is that imbalance corrected, and it is where
 * a per-project model override finally has an honest home. Note the inherit
 * options name what they inherit, the same rule Settings' Models pane follows.
 */
function SessionsPane() {
  return (
    <>
      <PrefSection
        title="New sessions"
        icon={LightningIcon}
        description="What a Ticket Session in this project starts with."
      >
        <PrefRow label="Harness" htmlFor="harness">
          <Select value="claude-code">
            <SelectTrigger id="harness" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude-code">Claude Code</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
            </SelectContent>
          </Select>
        </PrefRow>
        <PrefRow label="Model" htmlFor="model">
          <Select value="inherit">
            <SelectTrigger id="model" className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">Same as Settings — claude-sonnet-4.6</SelectItem>
              <SelectItem value="opus">claude-opus-4.6 · Anthropic</SelectItem>
            </SelectContent>
          </Select>
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Instructions"
        icon={SlidersHorizontalIcon}
        description="Read at the start of every session in this project."
        action={<SectionAction label="Open AGENTS.md" icon={ArrowSquareOutIcon} />}
      >
        <ItemRow name="AGENTS.md" meta="12 KB · repo root" badges={<Where project />} />
        <ItemRow name="CLAUDE.md" meta="15 KB · repo root" badges={<Where project />} />
      </PrefSection>
    </>
  );
}

/**
 * Worktrees — the project automation that was already here, plus the thing
 * that was only ever documentation.
 *
 * Audit item 31: the copy set is two read-only `<p>`s about `.worktreeinclude`
 * today. It is a gitignore-syntax file at a known path — there is no reason it
 * cannot be edited in place, and every reason it should be, since the default
 * set silently decides whether a fresh worktree can run at all.
 */
function WorktreesPane() {
  const [base, setBase] = React.useState("main");
  const [setup, setSetup] = React.useState("pnpm install");

  return (
    <>
      <PrefSection title="New worktrees" icon={TreeStructureIcon}>
        <PrefRow label="Branch from" htmlFor="base">
          <CommitField id="base" value={base} placeholder="main" width="w-48" onCommit={setBase} />
        </PrefRow>
        <PrefRow label="Then run" htmlFor="setup">
          <CommitField
            id="setup"
            value={setup}
            placeholder="pnpm install"
            width="w-56"
            onCommit={setSetup}
          />
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Copied files"
        icon={TerminalWindowIcon}
        description="Gitignore syntax. ! negates. Copied into every new worktree."
        action={<SectionAction label="Reveal" icon={FolderOpenIcon} />}
      >
        <div className="py-2">
          <Textarea
            aria-label="Worktree copy set"
            defaultValue={".env*\n.claude/settings.local.json"}
            className="min-h-24 font-mono"
          />
          <p className="mt-2 text-ui text-muted-foreground">
            Saved to{" "}
            <code className="rounded-sm bg-muted px-1 py-1 font-mono">.worktreeinclude</code> at the
            repo root.
          </p>
        </div>
      </PrefSection>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Six categories in two groups.
 *
 * The group labels are load-bearing: "Agent" is what the brief asked for and
 * did not exist, and "Project" is the small amount of genuine per-project
 * automation that was already here. Between them they answer the question
 * today's two surfaces cannot — Settings is you, Configure is this repo's
 * agent.
 */
export const CONFIGURE_GROUPS: readonly PrefGroup[] = [
  {
    key: "agent",
    label: "Agent",
    categories: [
      {
        key: "skills",
        label: "Skills",
        icon: BookOpenIcon,
        description: "What the agent knows how to do in this project.",
        keywords: ["skill", "agents", "SKILL.md", "capability"],
        trailing: <Badge variant="secondary">7</Badge>,
        content: <SkillsPane />,
      },
      {
        key: "commands",
        label: "Commands",
        icon: CommandIcon,
        description: "Slash commands available in every composer here.",
        keywords: ["command", "slash", "prompt", "template"],
        trailing: <Badge variant="secondary">4</Badge>,
        content: <CommandsPane />,
      },
      {
        key: "mcp",
        label: "MCP Servers",
        icon: PlugsConnectedIcon,
        description: "Tools and data the agent can reach beyond this repo.",
        keywords: ["mcp", "server", "tool", "integration", "context protocol"],
        // aria-hidden — see the note on Settings' Updates category. A count
        // Badge beside it reads fine as part of the name ("Skills 7"); a
        // labelled dot does not ("MCP Servers 1 failing").
        trailing: <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />,
        content: <McpPane />,
      },
      {
        key: "plugins",
        label: "Plugins",
        icon: PuzzlePieceIcon,
        description: "Bundles that install skills, commands and servers together.",
        keywords: ["plugin", "bundle", "marketplace", "extension"],
        trailing: <Badge variant="secondary">2</Badge>,
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
        description: "What a new session in this project starts with.",
        keywords: ["harness", "model", "claude code", "codex", "agents.md", "instructions"],
        content: <SessionsPane />,
      },
      {
        key: "worktrees",
        label: "Worktrees",
        icon: TreeStructureIcon,
        description: "How a ticket's checkout gets built.",
        keywords: ["worktree", "branch", "base", "setup", "copy", "worktreeinclude", "env"],
        content: <WorktreesPane />,
      },
    ],
  },
];
