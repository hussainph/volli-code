/**
 * VC-111 — the proposed **Configure** surface. Second pass.
 *
 * Configure is this project, always. Every row here is scoped to the selected
 * project, and any row that can defer to the app-wide value carries the one
 * `InheritControl` idiom naming what it would inherit (kit rule 2).
 *
 * WHAT CHANGED AFTER REVIEW:
 *  - **Three inheritance vocabularies became one.** The first pass had a
 *    `Segmented` in Appearance, a "Same as Project chats" option inside a
 *    Select in Models and a "Same as Settings — …" option inside another Select
 *    in Sessions — while its own rule said scope lives in one place
 *    (review §1.1, §1.3). All of it is `InheritControl` now.
 *  - **Precedence is published.** Review §1.1's sharpest finding was that the
 *    proposal put models on both surfaces and stated no precedence — rebuilding
 *    the desync in the commit claiming to fix it. `ResolutionNote` says the
 *    order out loud, on every pane where two tiers meet.
 *  - **The skill switch got a scope.** Toggling a personal skill from inside
 *    one project could not say whether it was off here or off everywhere. Now
 *    a personal skill can only be disabled FOR THIS PROJECT from here, and the
 *    row says so.
 *  - **Appearance came back** under a Project group. It is only three rows, and
 *    sending someone to Settings to theme one project is the confusion the
 *    ticket was about. Settings' `OverrideNote` is the other half.
 *  - **The `.worktreeinclude` trap is gone.** A `Textarea` seeded with the
 *    built-in defaults and blur-saved would have MATERIALIZED a tracked file
 *    that did not exist, freezing today's defaults into the repo (review §2.6).
 *  - **No section descriptions**, per CLAUDE.md.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
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
import { Segmented } from "@renderer/components/ui/segmented";
import { Switch } from "@renderer/components/ui/switch";

import {
  AsyncSection,
  CommitField,
  CONTROL_W,
  Health,
  InheritControl,
  ItemList,
  ItemRow,
  PrefRow,
  PrefSection,
  SectionAction,
  Tier,
  type AsyncState,
  type PrefGroup,
} from "./kit";

function ready<T>(data: T): AsyncState<T> {
  return { status: "ready", data };
}

/**
 * The precedence sentence.
 *
 * Review §1.1: the audit praised Claude Code for publishing a precedence table
 * and then the proposal shipped none, while putting the same setting on two
 * surfaces. This is the smallest honest version — the resolution order, stated
 * where the two tiers actually meet, rather than in a doc nobody opens.
 *
 * It is the one sanctioned prose exception on this surface, and it earns it on
 * the same grounds CLAUDE.md grants a trust boundary: a value that resolves
 * through layers is not self-describing, and getting it wrong costs money.
 */
function ResolutionNote({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-border/50 py-2 text-ui text-muted-foreground">{children}</p>;
}

/* -------------------------------- Skills ---------------------------------- */

interface Skill {
  slug: string;
  description: string;
  scope: "project" | "personal";
  enabled: boolean;
  /** A personal skill a same-named project skill shadows. */
  shadowed?: boolean;
}

const SKILLS: readonly Skill[] = [
  { slug: "tdd", description: "Test-driven development", scope: "project", enabled: true },
  {
    slug: "code-review",
    description: "Review a branch against standards",
    scope: "project",
    enabled: true,
  },
  {
    slug: "diagnose",
    description: "Disciplined loop for hard bugs",
    scope: "personal",
    enabled: true,
  },
  {
    slug: "writing-for-agents",
    description: "Writing skills and AGENTS.md",
    scope: "personal",
    enabled: true,
  },
  {
    slug: "svelte-code-writer",
    description: "Svelte 5 components",
    scope: "personal",
    enabled: false,
    shadowed: true,
  },
  { slug: "mintlify", description: "Build Mintlify docs sites", scope: "personal", enabled: false },
  {
    slug: "research",
    description: "Investigate against primary sources",
    scope: "personal",
    enabled: true,
  },
];

function SkillsPane() {
  return (
    <AsyncSection
      title="Skills"
      icon={BookOpenIcon}
      action={<SectionAction label="Reveal folder" icon={FolderOpenIcon} />}
      state={ready(SKILLS)}
      isEmpty={(list) => list.length === 0}
      // Review §2.4: a project with no skills is not a search that matched
      // nothing, and the first pass rendered the same string for both.
      empty="No skills yet. Add one to .agents/skills."
    >
      {(list) => (
        <>
          <ItemList
            items={list}
            keyOf={(skill) => `${skill.scope}/${skill.slug}`}
            search={(skill) => `${skill.slug} ${skill.description}`}
            placeholder="Search skills"
            noResults="No skills match."
            render={(skill) => (
              <ItemRow
                name={skill.slug}
                meta={skill.shadowed ? "Shadowed by this project's own copy" : skill.description}
                badges={<Tier scope={skill.scope} />}
              >
                <Button size="icon-xs" variant="ghost" aria-label={`Open ${skill.slug}`}>
                  <ArrowSquareOutIcon />
                </Button>
                {/*
                 * Review §1.1: a bare switch on a personal skill could not say
                 * whether it was off HERE or off EVERYWHERE. The switch on this
                 * per-project page always means "in this project", and the
                 * label says so — a personal skill's global state is its own
                 * frontmatter (`isUserInvokeOnly`), reachable via the row's
                 * open button.
                 */}
                <Switch
                  defaultChecked={skill.enabled}
                  disabled={skill.shadowed}
                  aria-label={`Enable ${skill.slug} in this project`}
                />
              </ItemRow>
            )}
          />
          <ResolutionNote>
            A project skill wins over a personal one with the same name. Switches here apply to this
            project only.
          </ResolutionNote>
        </>
      )}
    </AsyncSection>
  );
}

/* ------------------------------- Commands --------------------------------- */

interface Command {
  name: string;
  description: string;
  scope: "project" | "personal";
}

const COMMANDS: readonly Command[] = [
  { name: "/ship", description: "Open a PR with the ticket body as description", scope: "project" },
  { name: "/audit", description: "Read a surface and list what's wrong", scope: "project" },
  {
    name: "/handoff",
    description: "Compact this conversation for another agent",
    scope: "personal",
  },
  { name: "/grill", description: "Stress-test a plan", scope: "personal" },
];

function CommandsPane() {
  return (
    <AsyncSection
      title="Commands"
      icon={CommandIcon}
      action={<SectionAction label="New command" icon={PlusIcon} />}
      state={ready(COMMANDS)}
      isEmpty={(list) => list.length === 0}
      empty="No commands yet. Add a .md file to .volli/commands."
    >
      {(list) => (
        <>
          <ItemList
            items={list}
            keyOf={(command) => `${command.scope}${command.name}`}
            search={(command) => `${command.name} ${command.description}`}
            placeholder="Search commands"
            noResults="No commands match."
            render={(command) => (
              <ItemRow
                name={command.name}
                meta={command.description}
                badges={<Tier scope={command.scope} />}
              >
                <Button size="icon-xs" variant="ghost" aria-label={`Edit ${command.name}`}>
                  <ArrowSquareOutIcon />
                </Button>
              </ItemRow>
            )}
          />
          <ResolutionNote>
            A project command wins over a personal one with the same name.
          </ResolutionNote>
        </>
      )}
    </AsyncSection>
  );
}

/* --------------------------------- MCP ------------------------------------ */

interface Server {
  name: string;
  meta: string;
  scope: "project" | "personal";
  state: "ready" | "error" | "idle";
  status: string;
}

const SERVERS: readonly Server[] = [
  {
    name: "linear",
    meta: "12 tools · issues, projects, cycles",
    scope: "project",
    state: "ready",
    status: "Connected",
  },
  {
    name: "sentry",
    meta: "6 tools · issues, releases",
    scope: "project",
    state: "ready",
    status: "Connected",
  },
  {
    name: "postgres",
    meta: "Couldn't start — check the connection string",
    scope: "personal",
    state: "error",
    status: "Failed",
  },
  {
    name: "figma",
    meta: "4 tools · files, comments",
    scope: "personal",
    state: "idle",
    status: "Off",
  },
];

function McpPane() {
  return (
    <AsyncSection
      title="Servers"
      icon={PlugsConnectedIcon}
      action={<SectionAction label="Add server" icon={PlusIcon} />}
      state={ready(SERVERS)}
      isEmpty={(list) => list.length === 0}
      empty="No MCP servers yet."
    >
      {(list) => (
        <>
          {list.map((server) => (
            <ItemRow
              key={server.name}
              name={server.name}
              meta={server.meta}
              badges={<Tier scope={server.scope} />}
            >
              <Health state={server.state}>{server.status}</Health>
              {server.state === "error" ? (
                <Button size="sm" variant="outline">
                  Fix
                </Button>
              ) : (
                <Switch
                  defaultChecked={server.state === "ready"}
                  aria-label={`Enable ${server.name} in this project`}
                />
              )}
            </ItemRow>
          ))}
          {/*
           * Review §1.1: web search is agent tooling filed under Settings while
           * MCP — also "tools the agent can reach" — is filed here, and the
           * split gave a user no way to guess which page holds what. Under the
           * scope rule the answer is consistent (web search is one account, so
           * it is app-wide; servers are per-project), but consistent is not the
           * same as discoverable. So this pane says where the other one is.
           */}
          <ResolutionNote>
            Web search is configured once for every project, in Settings.
          </ResolutionNote>
        </>
      )}
    </AsyncSection>
  );
}

/* ------------------------------- Plugins ---------------------------------- */

function PluginsPane() {
  return (
    <AsyncSection
      title="Installed"
      icon={PuzzlePieceIcon}
      action={<SectionAction label="Browse…" icon={PlusIcon} />}
      state={ready([
        {
          name: "matt-pocock-engineering",
          meta: "9 skills · 3 commands",
          scope: "project" as const,
        },
        { name: "emil-design-eng", meta: "4 skills · 1 command", scope: "personal" as const },
      ])}
      isEmpty={(list) => list.length === 0}
      empty="No plugins installed."
    >
      {(list) => (
        <>
          {list.map((plugin) => (
            <ItemRow
              key={plugin.name}
              name={plugin.name}
              meta={plugin.meta}
              badges={<Tier scope={plugin.scope} />}
            >
              <Button size="sm" variant="outline">
                Manage
              </Button>
              <Switch defaultChecked aria-label={`Enable ${plugin.name} in this project`} />
            </ItemRow>
          ))}
        </>
      )}
    </AsyncSection>
  );
}

/* ------------------------------- Sessions --------------------------------- */

function SessionsPane() {
  const [harnessInherited, setHarnessInherited] = React.useState(true);
  const [modelInherited, setModelInherited] = React.useState(false);

  return (
    <>
      <PrefSection title="New sessions" icon={CpuIcon}>
        <PrefRow label="Harness">
          <InheritControl
            ariaLabel="Harness scope"
            inherited={harnessInherited}
            inheritedValue="Claude Code"
            onChange={setHarnessInherited}
          >
            <Select value="codex">
              <SelectTrigger className={CONTROL_W.md} aria-label="Harness">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude-code">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>
          </InheritControl>
        </PrefRow>
        <PrefRow label="Model">
          <InheritControl
            ariaLabel="Model scope"
            inherited={modelInherited}
            inheritedValue="claude-opus-4.6"
            onChange={setModelInherited}
          >
            <Select value="sonnet">
              <SelectTrigger className={CONTROL_W.lg} aria-label="Model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="opus">claude-opus-4.6 · Anthropic</SelectItem>
                <SelectItem value="sonnet">claude-sonnet-4.6 · Anthropic</SelectItem>
              </SelectContent>
            </Select>
          </InheritControl>
        </PrefRow>
        {/*
         * THE PRECEDENCE TABLE, as one sentence. This is the thing whose
         * absence made the first pass's models-on-both-surfaces a rebuild of
         * the very desync the ticket is about.
         */}
        <ResolutionNote>
          A session uses the model picked in its own composer, then this project&rsquo;s, then the
          default in Settings.
        </ResolutionNote>
      </PrefSection>

      <PrefSection
        title="Instructions"
        icon={BookOpenIcon}
        action={<SectionAction label="Open AGENTS.md" icon={ArrowSquareOutIcon} />}
      >
        <ItemRow name="AGENTS.md" meta="12 KB · repo root" badges={<Tier scope="project" />} />
        <ItemRow name="CLAUDE.md" meta="15 KB · repo root" badges={<Tier scope="project" />} />
      </PrefSection>
    </>
  );
}

/* ------------------------------ Appearance -------------------------------- */

/**
 * This project's theming overrides.
 *
 * Back on Configure, against the first pass, which moved it wholesale to
 * Settings behind a scope switch. Two reasons: sending someone to the app-wide
 * page to theme one project is the confusion the ticket opened with, and the
 * pane-level scope switch that made it possible was itself the thing review
 * §1.2 took apart. Three rows, one idiom, and Settings carries the
 * `OverrideNote` that points here.
 */
function AppearancePane() {
  const [modeInherited, setModeInherited] = React.useState(false);
  const [canvasInherited, setCanvasInherited] = React.useState(true);
  const [terminalInherited, setTerminalInherited] = React.useState(true);

  return (
    <PrefSection title="Overrides" icon={PaletteIcon}>
      <PrefRow label="Mode" testId="project-appearance-mode">
        <InheritControl
          ariaLabel="Appearance scope"
          inherited={modeInherited}
          inheritedValue="Dark"
          onChange={setModeInherited}
        >
          <Segmented
            ariaLabel="Appearance mode"
            value="light"
            options={[
              { key: "light", label: "Light" },
              { key: "dark", label: "Dark" },
              { key: "auto", label: "Auto" },
            ]}
            onChange={() => {}}
          />
        </InheritControl>
      </PrefRow>
      <PrefRow label="Canvas" testId="project-appearance-canvas">
        <InheritControl
          ariaLabel="Canvas scope"
          inherited={canvasInherited}
          inheritedValue="Ember"
          onChange={setCanvasInherited}
        >
          <Button size="sm" variant="outline">
            Edit canvas…
          </Button>
        </InheritControl>
      </PrefRow>
      <PrefRow label="Terminal theme" testId="project-appearance-terminal">
        <InheritControl
          ariaLabel="Terminal theme scope"
          inherited={terminalInherited}
          inheritedValue="Rosé Pine"
          onChange={setTerminalInherited}
        >
          <Button size="sm" variant="outline">
            Tokyo Night
          </Button>
        </InheritControl>
      </PrefRow>
      <PrefRow label="Config file">
        <Button size="sm" variant="outline">
          This project&rsquo;s overlay
        </Button>
      </PrefRow>
    </PrefSection>
  );
}

/* ------------------------------ Worktrees --------------------------------- */

function WorktreesPane() {
  return (
    <>
      <PrefSection title="New worktrees" icon={TreeStructureIcon}>
        <PrefRow label="Branch from" htmlFor="base">
          <CommitField
            id="base"
            value="main"
            placeholder="main"
            // Review §1.5: neither version verifies the ref exists, so a typo
            // surfaces later, at worktree creation, far from the field. A
            // blur-commit is fine IF the field can refuse — so it does.
            onCommit={(next) =>
              ["main", "master", "develop"].includes(next.trim())
                ? { ok: true, value: next.trim() }
                : { ok: false, error: `No branch named "${next.trim()}" in this repo.` }
            }
          />
        </PrefRow>
        <PrefRow label="Then run" htmlFor="setup">
          <CommitField id="setup" value="pnpm install" onCommit={() => ({ ok: true })} />
        </PrefRow>
      </PrefSection>

      {/*
       * Review §2.6: the first pass shipped a Textarea seeded with the BUILT-IN
       * DEFAULTS and blur-saved. Since `.worktreeinclude` is a tracked repo file
       * that usually does not exist, that would have materialized it — freezing
       * today's defaults into the repo so future default changes stopped
       * applying — and produced an uncommitted working-tree change from a
       * settings page. So: read-only until someone opts in, the defaults are
       * labelled as defaults, and creating the file is an explicit act.
       */}
      <PrefSection
        title="Copied files"
        icon={TerminalWindowIcon}
        action={<SectionAction label="Create .worktreeinclude" icon={PlusIcon} />}
      >
        <ItemRow name=".env*" badges={<Badge variant="outline">Default</Badge>} />
        <ItemRow
          name=".claude/settings.local.json"
          badges={<Badge variant="outline">Default</Badge>}
        />
        <ResolutionNote>
          This repo has no{" "}
          <code className="rounded-sm bg-muted px-1 py-1 font-mono">.worktreeinclude</code>, so
          Volli&rsquo;s defaults apply. Creating one replaces them.
        </ResolutionNote>
      </PrefSection>
    </>
  );
}

/* -------------------------------------------------------------------------- */

export const CONFIGURE_GROUPS: readonly PrefGroup[] = [
  {
    key: "agent",
    label: "Agent",
    categories: [
      {
        key: "skills",
        label: "Skills",
        icon: BookOpenIcon,
        keywords: ["skill", "agents", "capability", "shadow"],
        trailing: <Badge variant="secondary">7</Badge>,
        content: <SkillsPane />,
      },
      {
        key: "commands",
        label: "Commands",
        icon: CommandIcon,
        keywords: ["command", "slash", "prompt", "template"],
        trailing: <Badge variant="secondary">4</Badge>,
        content: <CommandsPane />,
      },
      {
        key: "mcp",
        label: "MCP Servers",
        icon: PlugsConnectedIcon,
        keywords: ["mcp", "server", "tool", "context protocol"],
        attention: { tone: "destructive", label: "1 failing" },
        content: <McpPane />,
      },
      {
        key: "plugins",
        label: "Plugins",
        icon: PuzzlePieceIcon,
        keywords: ["plugin", "bundle", "marketplace"],
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
        keywords: ["harness", "model", "claude code", "codex", "agents.md", "instructions"],
        content: <SessionsPane />,
      },
      {
        key: "appearance",
        label: "Appearance",
        icon: PaletteIcon,
        keywords: ["theme", "dark", "light", "canvas", "terminal", "override"],
        content: <AppearancePane />,
      },
      {
        key: "worktrees",
        label: "Worktrees",
        icon: TreeStructureIcon,
        keywords: ["worktree", "branch", "base", "setup", "copy", "worktreeinclude", "env"],
        content: <WorktreesPane />,
      },
    ],
  },
];
