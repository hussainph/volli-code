/**
 * VC-111 — the **Configure** surface. Third pass.
 *
 * Configure is this project, always. Divergence from the app-wide value is
 * marked once per row by `OverrideControl` plus `PrefRow`'s gutter bar.
 *
 * WHAT THE COMPONENT PASS CHANGED HERE:
 *  - **Skills, Commands, MCP and Plugins are tables.** They are homogeneous
 *    collections with shared attributes, which is the definition of tabular,
 *    and they were unbounded stacks of two-line rows. A skills folder can hold
 *    two hundred entries; that was a page with no bottom.
 *  - **The `Tier` pill is gone.** Provenance is a `Source` column, and one
 *    filter in the toolbar replaces N repeated pills. This is the single
 *    biggest reduction in visual noise on the surface.
 *  - **`InheritControl`'s two pills per row became `OverrideControl`** — a
 *    revert button that exists only when there is something to revert.
 *  - **Every `ResolutionNote` paragraph became an `(i)`.**
 *  - **The new features got designed rather than gestured at**: New command and
 *    Add MCP server are real dialogs with real fields, and the skill switch now
 *    says what it writes.
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Segmented } from "@renderer/components/ui/segmented";
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";

import {
  AsyncSection,
  Cell,
  CommitField,
  CONTROL_W,
  DataTable,
  Health,
  ItemRow,
  OverrideControl,
  PrefRow,
  PrefSection,
  SectionAction,
  type AsyncState,
  type PrefGroup,
} from "./kit";

function ready<T>(data: T): AsyncState<T> {
  return { status: "ready", data };
}

/** The Source column's value. A quiet word, aligned — never a pill. */
function Source({ scope }: { scope: "project" | "personal" }) {
  return <Cell muted>{scope === "project" ? "This project" : "Personal"}</Cell>;
}

/** The filter that replaces a pill on every row. */
function sourceFilter(value: string, onChange: (next: string) => void) {
  return {
    label: "Filter by source",
    value,
    onChange,
    options: [
      { value: "all", label: "All sources" },
      { value: "project", label: "This project" },
      { value: "personal", label: "Personal" },
    ],
  };
}

function bySource<T extends { scope: "project" | "personal" }>(
  items: readonly T[],
  filter: string,
) {
  return filter === "all" ? items : items.filter((item) => item.scope === filter);
}

/* -------------------------------- Skills ---------------------------------- */

interface Skill {
  slug: string;
  description: string;
  scope: "project" | "personal";
  enabled: boolean;
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
  {
    slug: "handoff",
    description: "Compact a conversation for another agent",
    scope: "personal",
    enabled: true,
  },
  {
    slug: "domain-modeling",
    description: "Sharpen a project's domain model",
    scope: "personal",
    enabled: false,
  },
  {
    slug: "prototype",
    description: "Throwaway prototype to answer a design question",
    scope: "personal",
    enabled: true,
  },
];

function SkillsPane() {
  const [filter, setFilter] = React.useState("all");
  const shown = bySource(SKILLS, filter);

  return (
    <AsyncSection
      title="Skills"
      icon={BookOpenIcon}
      hint={<>Project skills override personal ones. Switches apply here only.</>}
      action={<SectionAction label="Reveal folder" icon={FolderOpenIcon} />}
      state={ready(shown)}
      isEmpty={() => SKILLS.length === 0}
      empty="No skills yet. Add one to .agents/skills."
    >
      {(list) => (
        <DataTable
          label="Skills available to this project"
          items={list}
          keyOf={(skill) => `${skill.scope}/${skill.slug}`}
          rows={8}
          search={(skill) => `${skill.slug} ${skill.description}`}
          placeholder="Search skills"
          filter={sourceFilter(filter, setFilter)}
          empty="No skills yet. Add one to .agents/skills."
          noResults="No skills match."
          columns={[
            {
              key: "name",
              header: "Skill",
              width: "minmax(0, 1fr)",
              cell: (skill) => <Cell>{skill.slug}</Cell>,
            },
            {
              key: "description",
              header: "Description",
              width: "minmax(0, 1.4fr)",
              cell: (skill) => (
                <Cell muted>
                  {skill.shadowed ? "Shadowed by this project's own copy" : skill.description}
                </Cell>
              ),
            },
            {
              key: "source",
              header: "Source",
              width: "7rem",
              cell: (skill) => <Source scope={skill.scope} />,
            },
            {
              key: "open",
              header: "Open",
              width: "2.5rem",
              align: "end",
              headerHidden: true,
              cell: (skill) => (
                <Button size="icon-xs" variant="ghost" aria-label={`Open ${skill.slug}`}>
                  <ArrowSquareOutIcon />
                </Button>
              ),
            },
            {
              key: "enabled",
              header: "Enabled",
              width: "3.5rem",
              align: "end",
              headerHidden: true,
              cell: (skill) => (
                <Switch
                  defaultChecked={skill.enabled}
                  disabled={skill.shadowed}
                  // The switch names its own scope, because a personal skill
                  // toggled from a project page is otherwise ambiguous: off
                  // here, or off everywhere? This one writes to the project.
                  aria-label={`Enable ${skill.slug} in this project`}
                  data-testid={`skill-${skill.slug}`}
                />
              ),
            },
          ]}
        />
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

/**
 * New command — one of the features this redesign *adds*, so it owes a real
 * design rather than a button that goes nowhere.
 *
 * A command is a markdown file: frontmatter with a description, then a prompt
 * body. So the dialog is three fields and it writes the file. The name field
 * enforces the one rule the loader has (a slug, because the filename becomes
 * the invocation), and the Source select is what decides which of the two
 * folders it lands in — the same choice the table's Source column reports.
 */
function NewCommandDialog() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [body, setBody] = React.useState("");
  const [scope, setScope] = React.useState("project");

  const slug = name.trim().replace(/^\//, "");
  const invalid = slug.length > 0 && !/^[a-z0-9-]+$/.test(slug);
  const canSave = slug.length > 0 && !invalid && body.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="xs" variant="ghost">
          <PlusIcon />
          New command
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New command</DialogTitle>
          <DialogDescription>
            Commands are markdown files. Typing the name in a composer runs the prompt below.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="cmd-name" className="text-ui">
              Name
            </label>
            <div className="flex items-center gap-2">
              <span className="text-ui text-muted-foreground">/</span>
              <Input
                id="cmd-name"
                value={name}
                placeholder="ship"
                aria-invalid={invalid}
                aria-describedby={invalid ? "cmd-name-error" : undefined}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {invalid ? (
              <p id="cmd-name-error" role="alert" className="text-ui text-destructive">
                Lowercase letters, numbers and dashes only — it becomes the filename.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="cmd-desc" className="text-ui">
              Description
            </label>
            <Input
              id="cmd-desc"
              value={description}
              placeholder="Open a PR with the ticket body as description"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="cmd-body" className="text-ui">
              Prompt
            </label>
            <Textarea
              id="cmd-body"
              value={body}
              rows={6}
              placeholder="Read the ticket, open a PR against main, and paste the ticket body as the description."
              onChange={(event) => setBody(event.target.value)}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <label htmlFor="cmd-scope" className="text-ui">
              Save to
            </label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger id="cmd-scope" className={CONTROL_W.lg}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">This project — .volli/commands</SelectItem>
                <SelectItem value="personal">Personal — available everywhere</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => setOpen(false)}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CommandsPane() {
  const [filter, setFilter] = React.useState("all");
  const shown = bySource(COMMANDS, filter);

  return (
    <AsyncSection
      title="Commands"
      icon={CommandIcon}
      hint={<>Type the name in any composer. Project overrides personal.</>}
      action={<NewCommandDialog />}
      state={ready(shown)}
      isEmpty={() => COMMANDS.length === 0}
      empty="No commands yet."
    >
      {(list) => (
        <DataTable
          label="Commands available to this project"
          items={list}
          keyOf={(command) => `${command.scope}${command.name}`}
          rows={8}
          search={(command) => `${command.name} ${command.description}`}
          placeholder="Search commands"
          filter={sourceFilter(filter, setFilter)}
          empty="No commands yet."
          noResults="No commands match."
          columns={[
            {
              key: "name",
              header: "Command",
              width: "10rem",
              cell: (command) => <Cell>{command.name}</Cell>,
            },
            {
              key: "description",
              header: "Description",
              width: "minmax(0, 1fr)",
              cell: (command) => <Cell muted>{command.description}</Cell>,
            },
            {
              key: "source",
              header: "Source",
              width: "7rem",
              cell: (command) => <Source scope={command.scope} />,
            },
            {
              key: "edit",
              header: "Edit",
              width: "2.5rem",
              align: "end",
              headerHidden: true,
              cell: (command) => (
                <Button size="icon-xs" variant="ghost" aria-label={`Edit ${command.name}`}>
                  <ArrowSquareOutIcon />
                </Button>
              ),
            },
          ]}
        />
      )}
    </AsyncSection>
  );
}

/* --------------------------------- MCP ------------------------------------ */

interface Server {
  name: string;
  transport: string;
  tools: string;
  scope: "project" | "personal";
  state: "ready" | "error" | "idle";
  status: string;
}

const SERVERS: readonly Server[] = [
  {
    name: "linear",
    transport: "stdio",
    tools: "12 tools",
    scope: "project",
    state: "ready",
    status: "Connected",
  },
  {
    name: "sentry",
    transport: "http",
    tools: "6 tools",
    scope: "project",
    state: "ready",
    status: "Connected",
  },
  {
    name: "postgres",
    transport: "stdio",
    tools: "—",
    scope: "personal",
    state: "error",
    status: "Failed",
  },
  {
    name: "figma",
    transport: "http",
    tools: "4 tools",
    scope: "personal",
    state: "idle",
    status: "Off",
  },
];

/**
 * Add MCP server — the other genuinely new feature, and the one with the most
 * plumbing behind it.
 *
 * The transport choice is the fork everything else hangs off: a stdio server is
 * a command plus args, an http one is a URL. So the form switches on it rather
 * than showing every field and letting four of them be irrelevant.
 */
function AddServerDialog() {
  const [open, setOpen] = React.useState(false);
  const [transport, setTransport] = React.useState("stdio");
  const [name, setName] = React.useState("");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="xs" variant="ghost">
          <PlusIcon />
          Add server
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription>
            Volli starts the server and offers its tools to agents in this project.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="mcp-name" className="text-ui">
              Name
            </label>
            <Input
              id="mcp-name"
              value={name}
              placeholder="linear"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <label htmlFor="mcp-transport" className="text-ui">
              Transport
            </label>
            <Select value={transport} onValueChange={setTransport}>
              <SelectTrigger id="mcp-transport" className={CONTROL_W.md}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">Local command</SelectItem>
                <SelectItem value="http">Remote URL</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {transport === "stdio" ? (
            <>
              <div className="flex flex-col gap-1">
                <label htmlFor="mcp-command" className="text-ui">
                  Command
                </label>
                <Input id="mcp-command" placeholder="npx -y @linear/mcp-server" />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="mcp-env" className="text-ui">
                  Environment
                </label>
                <Textarea id="mcp-env" rows={3} placeholder={"LINEAR_API_KEY=…\nLOG_LEVEL=info"} />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1">
              <label htmlFor="mcp-url" className="text-ui">
                URL
              </label>
              <Input id="mcp-url" placeholder="https://mcp.example.com/sse" />
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          {/* Adding a server means starting a process. Connecting first and
              reporting the result is the difference between this and a config
              file — otherwise a typo shows up as a silent absence later. */}
          <Button size="sm" disabled={name.trim().length === 0} onClick={() => setOpen(false)}>
            Connect &amp; add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function McpPane() {
  const [filter, setFilter] = React.useState("all");
  const shown = bySource(SERVERS, filter);

  return (
    <AsyncSection
      title="Servers"
      icon={PlugsConnectedIcon}
      hint={<>Web search is separate — set it in Settings.</>}
      action={<AddServerDialog />}
      state={ready(shown)}
      isEmpty={() => SERVERS.length === 0}
      empty="No MCP servers yet."
    >
      {(list) => (
        <DataTable
          label="MCP servers"
          items={list}
          keyOf={(server) => `${server.scope}/${server.name}`}
          rows={8}
          search={(server) => `${server.name} ${server.transport}`}
          placeholder="Search servers"
          filter={sourceFilter(filter, setFilter)}
          empty="No MCP servers yet."
          noResults="No servers match."
          columns={[
            {
              key: "name",
              header: "Server",
              width: "minmax(0, 1fr)",
              cell: (server) => <Cell>{server.name}</Cell>,
            },
            {
              key: "tools",
              header: "Tools",
              width: "6rem",
              cell: (server) => <Cell muted>{server.tools}</Cell>,
            },
            {
              key: "source",
              header: "Source",
              width: "7rem",
              cell: (server) => <Source scope={server.scope} />,
            },
            {
              key: "status",
              header: "Status",
              width: "8rem",
              cell: (server) => <Health state={server.state}>{server.status}</Health>,
            },
            {
              key: "enabled",
              header: "Enabled",
              width: "4.5rem",
              align: "end",
              headerHidden: true,
              cell: (server) =>
                server.state === "error" ? (
                  <Button size="xs" variant="outline">
                    Fix
                  </Button>
                ) : (
                  <Switch
                    defaultChecked={server.state === "ready"}
                    aria-label={`Enable ${server.name} in this project`}
                  />
                ),
            },
          ]}
        />
      )}
    </AsyncSection>
  );
}

/* ------------------------------- Plugins ---------------------------------- */

interface Plugin {
  name: string;
  contents: string;
  scope: "project" | "personal";
}

const PLUGINS: readonly Plugin[] = [
  { name: "matt-pocock-engineering", contents: "9 skills · 3 commands", scope: "project" },
  { name: "emil-design-eng", contents: "4 skills · 1 command", scope: "personal" },
];

function PluginsPane() {
  const [filter, setFilter] = React.useState("all");
  const shown = bySource(PLUGINS, filter);

  return (
    <AsyncSection
      title="Installed"
      icon={PuzzlePieceIcon}
      hint={<>A bundle of skills and commands, updated together.</>}
      action={<SectionAction label="Browse…" icon={PlusIcon} />}
      state={ready(shown)}
      isEmpty={() => PLUGINS.length === 0}
      empty="No plugins installed."
    >
      {(list) => (
        <DataTable
          label="Installed plugins"
          items={list}
          keyOf={(plugin) => `${plugin.scope}/${plugin.name}`}
          rows={6}
          search={(plugin) => plugin.name}
          placeholder="Search plugins"
          filter={sourceFilter(filter, setFilter)}
          empty="No plugins installed."
          noResults="No plugins match."
          columns={[
            {
              key: "name",
              header: "Plugin",
              width: "minmax(0, 1fr)",
              cell: (plugin) => <Cell>{plugin.name}</Cell>,
            },
            {
              key: "contents",
              header: "Contents",
              width: "11rem",
              cell: (plugin) => <Cell muted>{plugin.contents}</Cell>,
            },
            {
              key: "source",
              header: "Source",
              width: "7rem",
              cell: (plugin) => <Source scope={plugin.scope} />,
            },
            {
              key: "enabled",
              header: "Enabled",
              width: "3.5rem",
              align: "end",
              headerHidden: true,
              cell: (plugin) => (
                <Switch defaultChecked aria-label={`Enable ${plugin.name} in this project`} />
              ),
            },
          ]}
        />
      )}
    </AsyncSection>
  );
}

/* ------------------------------- Sessions --------------------------------- */

function SessionsPane() {
  // `null` means inherit. The override IS the presence of a value — there is no
  // separate mode flag, which is what let the last pass's two pills disappear.
  const [harness, setHarness] = React.useState<string | null>(null);
  const [model, setModel] = React.useState<string | null>("sonnet");

  return (
    <>
      <PrefSection
        title="New sessions"
        icon={CpuIcon}
        // The precedence table, as one hint instead of a paragraph under the
        // header. Available to whoever wants it, invisible to everyone else.
        hint={<>Composer choice wins, then this project, then Settings.</>}
      >
        <PrefRow label="Harness" htmlFor="harness" overridden={harness !== null}>
          <OverrideControl
            label="Harness"
            inheritedValue="Claude Code"
            overridden={harness !== null}
            onRevert={() => setHarness(null)}
          >
            <Select value={harness ?? "claude-code"} onValueChange={setHarness}>
              <SelectTrigger id="harness" className={CONTROL_W.md}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude-code">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>
          </OverrideControl>
        </PrefRow>

        <PrefRow label="Model" htmlFor="model" overridden={model !== null}>
          <OverrideControl
            label="Model"
            inheritedValue="claude-opus-4.6"
            overridden={model !== null}
            onRevert={() => setModel(null)}
          >
            <Select value={model ?? "opus"} onValueChange={setModel}>
              <SelectTrigger id="model" className={CONTROL_W.lg}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="opus">claude-opus-4.6 · Anthropic</SelectItem>
                <SelectItem value="sonnet">claude-sonnet-4.6 · Anthropic</SelectItem>
                <SelectItem value="codex">gpt-5.6-luna · OpenAI Codex</SelectItem>
              </SelectContent>
            </Select>
          </OverrideControl>
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Instructions"
        icon={BookOpenIcon}
        hint={<>Read before every session&rsquo;s first turn.</>}
        action={<SectionAction label="Open AGENTS.md" icon={ArrowSquareOutIcon} />}
      >
        <ItemRow name="AGENTS.md" meta="12 KB · repo root" />
        <ItemRow name="CLAUDE.md" meta="15 KB · repo root" />
      </PrefSection>
    </>
  );
}

/* ------------------------------ Appearance -------------------------------- */

function AppearancePane() {
  const [mode, setMode] = React.useState<string | null>("light");
  const [canvas, setCanvas] = React.useState<string | null>(null);
  const [terminal, setTerminal] = React.useState<string | null>(null);

  return (
    <PrefSection title="Overrides" icon={PaletteIcon} hint={<>Unset rows follow Settings.</>}>
      <PrefRow label="Mode" testId="project-appearance-mode" overridden={mode !== null}>
        <OverrideControl
          label="Mode"
          inheritedValue="Dark"
          overridden={mode !== null}
          onRevert={() => setMode(null)}
        >
          {/* The second and last Segmented in the prototype, and the same
              three-way as Settings — the point of an override is that it is
              the same control, not a different one. */}
          <Segmented
            ariaLabel="Appearance mode"
            value={mode ?? "dark"}
            options={[
              { key: "light", label: "Light" },
              { key: "dark", label: "Dark" },
              { key: "auto", label: "Auto" },
            ]}
            onChange={setMode}
          />
        </OverrideControl>
      </PrefRow>

      <PrefRow label="Canvas" testId="project-appearance-canvas" overridden={canvas !== null}>
        <OverrideControl
          label="Canvas"
          inheritedValue="Ember"
          overridden={canvas !== null}
          onRevert={() => setCanvas(null)}
        >
          <Button size="sm" variant="outline" onClick={() => setCanvas("custom")}>
            {canvas === null ? "Ember" : "Custom"}
          </Button>
        </OverrideControl>
      </PrefRow>

      <PrefRow
        label="Terminal theme"
        testId="project-appearance-terminal"
        overridden={terminal !== null}
      >
        <OverrideControl
          label="Terminal theme"
          inheritedValue="Rosé Pine"
          overridden={terminal !== null}
          onRevert={() => setTerminal(null)}
        >
          <Button size="sm" variant="outline" onClick={() => setTerminal("tokyo")}>
            {terminal === null ? "Rosé Pine" : "Tokyo Night"}
          </Button>
        </OverrideControl>
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

      <PrefSection
        title="Copied files"
        icon={TerminalWindowIcon}
        hint={<>Creating .worktreeinclude replaces these defaults entirely.</>}
        action={<SectionAction label="Create .worktreeinclude" icon={PlusIcon} />}
      >
        <ItemRow name=".env*" badges={<Badge variant="outline">Default</Badge>} />
        <ItemRow
          name=".claude/settings.local.json"
          badges={<Badge variant="outline">Default</Badge>}
        />
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
        count: SKILLS.length,
        content: <SkillsPane />,
      },
      {
        key: "commands",
        label: "Commands",
        icon: CommandIcon,
        keywords: ["command", "slash", "prompt", "template"],
        count: COMMANDS.length,
        content: <CommandsPane />,
      },
      {
        key: "mcp",
        label: "MCP Servers",
        icon: PlugsConnectedIcon,
        keywords: ["mcp", "server", "tool", "context protocol"],
        attention: { state: "error", label: "1 failing" },
        content: <McpPane />,
      },
      {
        key: "plugins",
        label: "Plugins",
        icon: PuzzlePieceIcon,
        keywords: ["plugin", "bundle", "marketplace"],
        count: PLUGINS.length,
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
