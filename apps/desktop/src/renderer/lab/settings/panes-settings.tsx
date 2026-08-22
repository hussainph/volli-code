/**
 * VC-111 — the proposed **Settings** surface (app-wide preferences).
 *
 * The split this prototype argues for:
 *
 *   Settings  = preferences about the APP. Things you set once, for you.
 *   Configure = this project's AGENT setup. Skills, plugins, MCP, commands.
 *
 * That is a real boundary a person can hold, and it is the reason the two
 * surfaces stop mirroring each other. Today they share three category names
 * ("General", "Appearance", "Worktrees") that mean different things in each,
 * and neither page mentions the other exists.
 *
 * Per-project THEMING does not move to Configure under this split — theming is
 * not agent configuration. It stays here and gains a scope control instead
 * (`ScopeBar`), which is the single change that resolves the ticket's headline
 * "desync between global settings and project configuration" complaint: one
 * pane, one control, both answers.
 *
 * Every number and name below is a fixture. The point is the shape.
 */
import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";

import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
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
  CommitField,
  DetailLine,
  Health,
  HealthSummary,
  InheritToggle,
  ItemList,
  ItemRow,
  Origin,
  PrefRow,
  PrefSection,
  ScopeBar,
  SectionAction,
  type PrefGroup,
  type Scope,
} from "./kit";

/* -------------------------------------------------------------------------- */

const PROJECT_NAME = "volli-code";

/** General — startup, retention, and where the data lives. */
function GeneralPane() {
  const [ttl, setTtl] = React.useState("14");
  const [reopen, setReopen] = React.useState(true);
  const [confirmQuit, setConfirmQuit] = React.useState(false);

  return (
    <>
      <PrefSection title="Startup" icon={GearSixIcon}>
        <PrefRow label="Reopen the last project on launch">
          <Switch checked={reopen} onCheckedChange={setReopen} />
        </PrefRow>
        <PrefRow label="Confirm before quitting with live sessions">
          <Switch checked={confirmQuit} onCheckedChange={setConfirmQuit} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Retention" icon={TreeStructureIcon}>
        {/*
         * The one description that survives the copy rule, unchanged from
         * today's app: this setting governs an automatic deletion, so the row
         * states what is taken and what survives. It also loses its Save
         * button — rule 5.
         */}
        <PrefRow
          label="Keep Done worktrees for"
          htmlFor="ttl"
          description="Volli removes the folder and keeps the branch, its commits, and the ticket."
        >
          <CommitField id="ttl" type="number" width="w-20" value={ttl} onCommit={setTtl} />
          <span className="text-ui text-muted-foreground">days</span>
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Data"
        icon={DatabaseIcon}
        description="Everything Volli knows lives in one local database."
        action={<SectionAction label="Reveal" icon={ArrowSquareOutIcon} />}
      >
        <PrefRow label="Export a copy">
          <Button size="sm" variant="outline">
            Export as JSON…
          </Button>
        </PrefRow>
        {/*
         * Today this is File → "Export Database as JSON…" and nowhere else.
         * A backup you can only find in a menu bar is a backup nobody takes.
         */}
      </PrefSection>
    </>
  );
}

/**
 * Appearance — and the demonstration of `ScopeBar`.
 *
 * Flip the scope control at the top. At **All projects** you are editing the
 * app-wide values and the bar tells you how many of them this project has
 * overridden. At **volli-code** every scopeable row grows an Inherit/Custom
 * switch in the SAME position, and Inherit names the value it is inheriting
 * rather than showing a blank.
 *
 * That is the whole of today's Configure → Appearance page, absorbed, with the
 * duplication and the three-different-heights problem gone.
 */
function AppearancePane() {
  const [scope, setScope] = React.useState<Scope>("app");
  const [mode, setMode] = React.useState("dark");
  const [modeInherited, setModeInherited] = React.useState(false);
  const [canvasInherited, setCanvasInherited] = React.useState(true);
  const [terminalInherited, setTerminalInherited] = React.useState(true);
  const [zoom, setZoom] = React.useState("100");
  const [diff, setDiff] = React.useState("inline");
  const project = scope === "project";

  return (
    <>
      <ScopeBar
        scope={scope}
        projectName={PROJECT_NAME}
        overrides={1}
        onChange={(next) => setScope(next)}
      />

      <PrefSection title="Theme" icon={PaletteIcon}>
        <PrefRow label="Mode">
          {project ? (
            <InheritToggle
              inherited={modeInherited}
              inheritedValue="Dark"
              onChange={setModeInherited}
            />
          ) : null}
          {!project || !modeInherited ? (
            <Segmented
              ariaLabel="Appearance mode"
              value={mode}
              options={[
                { key: "light", label: "Light" },
                { key: "dark", label: "Dark" },
                { key: "auto", label: "Auto" },
              ]}
              onChange={setMode}
            />
          ) : null}
        </PrefRow>

        {/*
         * The canvas editor is the audit's item 7: today it drops a raw
         * freeform gradient pad straight into a card between hairline rows, so
         * one section contains a tall unlabelled visual object AND label/control
         * rows. Here it is a row like everything else, and the pad opens from
         * it — rule 4. The swatch is the value; "Edit…" is the affordance.
         */}
        <PrefRow label="Canvas">
          {project ? (
            <InheritToggle
              inherited={canvasInherited}
              inheritedValue="Ember"
              onChange={setCanvasInherited}
            />
          ) : null}
          {!project || !canvasInherited ? (
            <>
              <span
                aria-hidden
                className="size-6 rounded-md bg-primary/70 ring-1 ring-border"
                title="Current canvas"
              />
              <Button size="sm" variant="outline">
                Edit…
              </Button>
            </>
          ) : null}
        </PrefRow>
      </PrefSection>

      <PrefSection title="Display" icon={MonitorIcon}>
        {/*
         * Zoom is persisted app-wide today and reachable ONLY from the View
         * menu (⌘+ / ⌘− / ⌘0). Audit item 23.
         */}
        <PrefRow label="Zoom" htmlFor="zoom">
          <Select value={zoom} onValueChange={setZoom}>
            <SelectTrigger id="zoom" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["80", "90", "100", "110", "125", "150"].map((step) => (
                <SelectItem key={step} value={step}>
                  {step}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PrefRow>
        {/* Audit item 25: an app-wide preference that today can only be set from inside a diff. */}
        <PrefRow label="Diff layout">
          <Segmented
            ariaLabel="Diff layout"
            value={diff}
            options={[
              { key: "inline", label: "Inline" },
              { key: "split", label: "Side by side" },
            ]}
            onChange={setDiff}
          />
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Terminal"
        icon={TerminalWindowIcon}
        description="Volli never edits your Ghostty config."
        action={<SectionAction label="Open overlay" icon={ArrowSquareOutIcon} />}
      >
        {project ? (
          <PrefRow label="Terminal theme">
            <InheritToggle
              inherited={terminalInherited}
              inheritedValue="Rosé Pine"
              onChange={setTerminalInherited}
            />
          </PrefRow>
        ) : (
          <>
            <PrefRow label="Theme">
              <Origin>From Ghostty</Origin>
              <Button size="sm" variant="outline">
                Rosé Pine
              </Button>
            </PrefRow>
            <PrefRow label="Font">
              <Origin mine>Set by Volli</Origin>
              <Button size="sm" variant="outline">
                Geist Mono
              </Button>
            </PrefRow>
            <PrefRow label="Size">
              <Origin mine>Set by Volli</Origin>
              <Button size="sm" variant="outline">
                13 pt
              </Button>
            </PrefRow>
          </>
        )}
      </PrefSection>
    </>
  );
}

/**
 * Notifications — audit item 22, entirely new.
 *
 * Native notifications already fire for ticket moves, agent `notify` calls,
 * retention sweeps and updates. None of it is configurable today, which for a
 * long-running desktop app that watches agents is a conspicuous hole.
 */
function NotificationsPane() {
  const [on, setOn] = React.useState(true);
  const [events, setEvents] = React.useState<Record<string, boolean>>({
    needsYou: true,
    finished: true,
    failed: true,
    moved: false,
    cleanup: false,
  });
  const set = (key: string) => (value: boolean) =>
    setEvents((current) => ({ ...current, [key]: value }));

  return (
    <>
      <PrefSection title="Notifications" icon={BellIcon}>
        <PrefRow label="Notify me">
          <Switch checked={on} onCheckedChange={setOn} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Tell me when" description="Only while Volli is in the background.">
        <PrefRow label="An agent needs my input">
          <Switch checked={events.needsYou} disabled={!on} onCheckedChange={set("needsYou")} />
        </PrefRow>
        <PrefRow label="A session finishes">
          <Switch checked={events.finished} disabled={!on} onCheckedChange={set("finished")} />
        </PrefRow>
        <PrefRow label="A session fails">
          <Switch checked={events.failed} disabled={!on} onCheckedChange={set("failed")} />
        </PrefRow>
        <PrefRow label="A ticket moves column">
          <Switch checked={events.moved} disabled={!on} onCheckedChange={set("moved")} />
        </PrefRow>
        <PrefRow label="Volli cleans up old worktrees">
          <Switch checked={events.cleanup} disabled={!on} onCheckedChange={set("cleanup")} />
        </PrefRow>
      </PrefSection>
    </>
  );
}

/**
 * Models — audit items 15–20.
 *
 * Today this is one pane doing four jobs, and the model list is one settings
 * ROW per model with two unlabelled controls beside it. Here the four jobs are
 * four sections, the catalog is an `ItemList` of `ItemRow`s (identity, not
 * settings) and the two per-model controls get a header so you can tell which
 * column is which.
 *
 * The renaming matters as much as the layout. Today the Ticket and Utility
 * pickers offer an option called **"Project default"** on a pane that has no
 * project scope at all, and the value it actually inherits is the row labelled
 * "Project chats". So the option names a different row's label. Here the rows
 * say what resolves them, and the inherit option says "Same as Project chats".
 */
function ModelsPane() {
  const [autoCompact, setAutoCompact] = React.useState(true);

  return (
    <>
      <PrefSection
        title="Defaults"
        icon={CpuIcon}
        description="Which model runs each kind of work."
        action={<SectionAction label="Refresh" icon={ArrowClockwiseIcon} />}
      >
        <PrefRow label="Project chats">
          <ModelSelect value="sonnet" />
        </PrefRow>
        <PrefRow label="Ticket Sessions">
          <ModelSelect value="inherit" inherit />
        </PrefRow>
        <PrefRow
          label="Background jobs"
          help="Naming new chats and summarizing long conversations. Left unset, these run on the model the chat itself is using — an inexpensive model here keeps them cheap."
        >
          <ModelSelect value="haiku" inherit />
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Compaction"
        icon={ArrowsInLineVerticalIcon}
        description="What happens as a session approaches its context limit."
      >
        <PrefRow label="Compact automatically">
          <Switch checked={autoCompact} onCheckedChange={setAutoCompact} />
        </PrefRow>
        {/*
         * Audit item 19: today the switch is here and the per-model reserve
         * that implements it is a dropdown on a model row two sections down,
         * with nothing connecting them. One line of copy does it.
         */}
        <PrefRow label="Reserve per model">
          <span className="text-ui text-muted-foreground">Set in Catalog, below</span>
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Catalog"
        icon={EyeIcon}
        description="Hide a model to keep it out of every picker."
      >
        {/*
         * The column header today's pane has no equivalent of — audit item 17.
         * The widths MATCH the controls below (`w-40` select, `w-10` switch
         * cell) rather than being eyeballed, so the header stays over its
         * column when a model name gets long enough to reflow the row.
         */}
        <div className="flex items-center justify-end gap-2 pb-1 text-label uppercase text-muted-foreground">
          <span className="w-40">Compaction reserve</span>
          <span className="w-10 text-right">Show</span>
        </div>
        <ItemList placeholder="Search models" empty="No models match.">
          {[
            { name: "claude-opus-4.6", meta: "Anthropic · 200K context", reserve: "32K" },
            { name: "claude-sonnet-4.6", meta: "Anthropic · 200K context", reserve: "Default" },
            { name: "claude-haiku-4.5", meta: "Anthropic · 200K context", reserve: "Default" },
            { name: "gpt-5.6-codex", meta: "OpenAI · 400K context", reserve: "64K" },
            { name: "gpt-5.6-mini", meta: "OpenAI · 400K context", reserve: "Default" },
            { name: "gemini-3-pro", meta: "Google · 1M context", reserve: "Default" },
            { name: "grok-5", meta: "xAI · 256K context", reserve: "Default" },
          ].map((model) => (
            <ItemRow key={model.name} name={model.name} meta={model.meta}>
              <Select value={model.reserve}>
                <SelectTrigger className="w-40" aria-label={`Compaction reserve for ${model.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Default">Default</SelectItem>
                  <SelectItem value="32K">32K reserve</SelectItem>
                  <SelectItem value="64K">64K reserve</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex w-10 justify-end">
                <Switch defaultChecked aria-label={`Show ${model.name} in pickers`} />
              </div>
            </ItemRow>
          ))}
        </ItemList>
      </PrefSection>

      <PrefSection title="Accounts" icon={UserCircleIcon}>
        <ItemRow
          name="Anthropic"
          meta="Signed in · Claude Pro"
          badges={<Health state="ready">Connected</Health>}
        >
          <Button size="sm" variant="outline">
            Sign out
          </Button>
        </ItemRow>
        <ItemRow name="OpenAI" meta="Signed in · API key">
          <Button size="sm" variant="outline">
            Sign out
          </Button>
        </ItemRow>
        <ItemRow name="Google Vertex" meta="Not signed in">
          <Button size="sm">Sign in</Button>
        </ItemRow>
      </PrefSection>
    </>
  );
}

/**
 * One purpose's model choice.
 *
 * The inherit option is named **"Same as Project chats"**, which is the whole
 * point of showing this row at all. Today it reads "Project default" on a pane
 * with no project scope, and the value it actually resolves to is the row
 * labelled "Project chats" — so the option names a DIFFERENT ROW'S LABEL and
 * invents a scope the pane does not have. Naming the row it defers to is both
 * accurate and shorter.
 *
 * (The first draft of this component gave the inherit option and the current
 * value the same `value` string, so Radix matched both and the trigger rendered
 * "Same as Project chatsSame as Projec". Distinct keys, one label each.)
 */
function ModelSelect({ value, inherit }: { value: string; inherit?: boolean }) {
  const [selected, setSelected] = React.useState(value);
  return (
    <Select value={selected} onValueChange={setSelected}>
      <SelectTrigger className="w-72">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inherit ? <SelectItem value="inherit">Same as Project chats</SelectItem> : null}
        <SelectItem value="opus">claude-opus-4.6 · Anthropic</SelectItem>
        <SelectItem value="sonnet">claude-sonnet-4.6 · Anthropic</SelectItem>
        <SelectItem value="haiku">claude-haiku-4.5 · Anthropic</SelectItem>
        <SelectItem value="codex">gpt-5.6-codex · OpenAI</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** Web search — same content as today, in the shared grammar and with no Save buttons. */
function WebPane() {
  const [provider, setProvider] = React.useState("brave");
  const [key, setKey] = React.useState("");

  return (
    <PrefSection title="Web search" icon={GlobeIcon}>
      <PrefRow label="Provider">
        <Health state={provider === "off" ? "idle" : "ready"}>
          {provider === "off" ? "Off" : "On"}
        </Health>
        <Segmented
          ariaLabel="Web search provider"
          value={provider}
          options={[
            { key: "off", label: "Off" },
            { key: "brave", label: "Brave" },
            { key: "exa", label: "Exa" },
            { key: "searxng", label: "SearXNG" },
          ]}
          onChange={setProvider}
        />
      </PrefRow>
      {provider === "brave" || provider === "exa" ? (
        <PrefRow label="API key" htmlFor="key">
          <Origin mine>In your keychain</Origin>
          <CommitField
            id="key"
            type="password"
            value={key}
            placeholder="Replace stored key"
            onCommit={setKey}
          />
        </PrefRow>
      ) : null}
      {provider === "searxng" ? (
        <PrefRow label="Instance" htmlFor="instance">
          <CommitField
            id="instance"
            value=""
            placeholder="http://localhost:8888"
            onCommit={() => {}}
          />
        </PrefRow>
      ) : null}
    </PrefSection>
  );
}

/** Integrations — audit item 24. Nine apps are allowlisted today and none of them can be yours. */
function IntegrationsPane() {
  return (
    <PrefSection
      title="Open in…"
      icon={PlugsIcon}
      description="Which app Volli hands a file or a folder to."
    >
      <PrefRow label="Editor" htmlFor="editor">
        <Select value="cursor">
          <SelectTrigger id="editor" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["VS Code", "Cursor", "Zed", "Xcode", "Android Studio"].map((app) => (
              <SelectItem key={app} value={app.toLowerCase().replace(/ /g, "-")}>
                {app}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PrefRow>
      <PrefRow label="Terminal" htmlFor="terminal">
        <Select value="ghostty">
          <SelectTrigger id="terminal" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["Terminal", "iTerm2", "Ghostty", "Warp"].map((app) => (
              <SelectItem key={app} value={app.toLowerCase()}>
                {app}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PrefRow>
    </PrefSection>
  );
}

/**
 * Updates — audit item 21, and the thing to kill first.
 *
 * The canary toggle exists in `main/auto-update.ts` today and its own doc
 * comment says *"No Settings UI yet"*, then hands the reader a `sqlite3`
 * command to run against the live database by hand. That is the single worst
 * thing in the settings surface and it is replaced by exactly one row below.
 */
function UpdatesPane() {
  const [auto, setAuto] = React.useState(true);
  const [channel, setChannel] = React.useState("stable");

  return (
    <>
      <Notice
        tone="positive"
        icon={DownloadSimpleIcon}
        title="Volli 0.1.0-canary.10 is ready"
        detail="It installs the next time you quit."
        actions={
          <Button size="xs" variant="outline">
            Restart now
          </Button>
        }
      />
      <PrefSection title="Updates" icon={DownloadSimpleIcon}>
        <PrefRow label="Install updates automatically">
          <Switch checked={auto} onCheckedChange={setAuto} />
        </PrefRow>
        {/* ← the sqlite command, retired. */}
        <PrefRow
          label="Channel"
          help="Canary builds ship the newest work first and break more often. Stable is the public release line."
        >
          <Segmented
            ariaLabel="Update channel"
            value={channel}
            options={[
              { key: "stable", label: "Stable" },
              { key: "canary", label: "Canary" },
            ]}
            onChange={setChannel}
          />
        </PrefRow>
        <PrefRow label="Current version">
          <span className="text-ui text-muted-foreground">0.1.0-canary.9</span>
          <Button size="sm" variant="outline">
            Check now
          </Button>
        </PrefRow>
      </PrefSection>
    </>
  );
}

/**
 * About — the whole of diagnostics, per the brief: "extremely concise, don't
 * expose the user to internals".
 *
 * Today this content is two full categories (CLI and Harness Runtimes) plus a
 * Doctor report, and it renders `binDir`, a socket path, a shell-chain boolean,
 * a legacy-path tri-state, a wrapper-command list and a PATH comparison table.
 * All of that is a fact about our plumbing. Here the default state is one
 * sentence; `Details` is six plain-language lines; and the escape hatch for a
 * bug report is "Copy report", which puts the internals on the clipboard
 * instead of on the screen.
 */
function AboutPane() {
  return (
    <>
      <HealthSummary
        state="ready"
        headline="Everything's working"
        detail="Command line tools installed. 2 harnesses and 3 model providers available."
        actions={
          <>
            <Button size="sm" variant="outline">
              Copy report
            </Button>
            <Button size="sm" variant="outline">
              Re-check
            </Button>
          </>
        }
      >
        <DetailLine label="Version" value="0.1.0-canary.9" />
        <DetailLine label="Command line" value="volli — installed" />
        <DetailLine label="Harnesses" value="Claude Code, Codex" />
        <DetailLine label="Model providers" value="Anthropic, OpenAI, Google" />
        <DetailLine label="Web search" value="Brave" />
        <DetailLine label="Database" value="12.4 MB" />
      </HealthSummary>

      {/*
       * The failure state, shown here so the concise version can be judged
       * against the case it has to survive. One sentence, one fix button, and
       * still no paths.
       */}
      <HealthSummary
        state="waiting"
        headline="The volli command isn't on your PATH"
        detail="Sessions still run. You just can't start one from your own terminal."
        actions={<Button size="sm">Fix this</Button>}
      >
        <DetailLine label="What Volli tried" value="Adding a line to ~/.zshrc" />
        <DetailLine label="What happened" value="The file is read-only" />
      </HealthSummary>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The rail: eight categories in three groups.
 *
 * Grouping is not decoration. Today's flat seven give no answer to "why is
 * Harness Runtimes next to Appearance"; three named groups make the pane you
 * want findable by elimination, and — critically — the group label is where the
 * relationship between the two surfaces finally gets written down.
 */
export const SETTINGS_GROUPS: readonly PrefGroup[] = [
  {
    key: "you",
    label: "Preferences",
    categories: [
      {
        key: "general",
        label: "General",
        icon: GearSixIcon,
        keywords: ["startup", "retention", "worktree", "export", "database", "backup", "quit"],
        content: <GeneralPane />,
      },
      {
        key: "appearance",
        label: "Appearance",
        icon: PaletteIcon,
        description: "Theme, display, and the terminal. Scoped app-wide or to one project.",
        keywords: [
          "theme",
          "dark",
          "light",
          "canvas",
          "zoom",
          "font",
          "terminal",
          "diff",
          "ghostty",
        ],
        content: <AppearancePane />,
      },
      {
        key: "notifications",
        label: "Notifications",
        icon: BellIcon,
        keywords: ["notify", "alert", "sound", "background", "badge"],
        content: <NotificationsPane />,
      },
    ],
  },
  {
    key: "services",
    label: "Services",
    categories: [
      {
        key: "models",
        label: "Models",
        icon: CpuIcon,
        description: "Which model runs what, and the accounts behind them.",
        keywords: [
          "model",
          "provider",
          "anthropic",
          "openai",
          "compaction",
          "reasoning",
          "sign in",
        ],
        content: <ModelsPane />,
      },
      {
        key: "web",
        label: "Web Search",
        icon: GlobeIcon,
        keywords: ["search", "brave", "exa", "searxng", "api key"],
        content: <WebPane />,
      },
      {
        key: "integrations",
        label: "Integrations",
        icon: PlugsIcon,
        keywords: ["editor", "vscode", "cursor", "zed", "terminal", "open in"],
        content: <IntegrationsPane />,
      },
    ],
  },
  {
    key: "app",
    label: "Application",
    categories: [
      {
        key: "updates",
        label: "Updates",
        icon: DownloadSimpleIcon,
        keywords: ["update", "version", "canary", "prerelease", "channel", "upgrade"],
        // `aria-hidden`: a trailing mark inside the rail button becomes part of
        // that button's ACCESSIBLE NAME, so a labelled dot turns "Updates" into
        // "Updates Update ready" for a screen reader and for every name-based
        // query. The dot is a duplicate of what the pane says on arrival, so it
        // is decoration; the pane's own Notice is the announcement.
        trailing: <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />,
        content: <UpdatesPane />,
      },
      {
        key: "about",
        label: "About",
        icon: InfoIcon,
        description: "Version, health, and what to send us when something breaks.",
        keywords: ["version", "diagnostics", "doctor", "cli", "harness", "health", "support"],
        content: <AboutPane />,
      },
    ],
  },
];
