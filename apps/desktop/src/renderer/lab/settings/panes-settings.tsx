/**
 * VC-111 — the **Settings** surface. Third pass.
 *
 * Settings is app-wide, always. Where a value can diverge per project, the row
 * carries an `OverrideNote` naming the projects that diverged.
 *
 * WHAT THE COMPONENT PASS CHANGED HERE:
 *  - **The model catalogue is a table**, capped at eight rows and scrolling
 *    inside its own box. It was an unbounded stack of two-line rows, which for
 *    a hundred models meant a page you could not get past — Accounts sat below
 *    it and effectively did not exist.
 *  - **Reserve and Provider are columns**, not things crammed into a row's
 *    trailing slot. That is what makes them scannable and alignable.
 *  - **Fewer pills.** `Segmented` now appears exactly once on this surface
 *    (Light/Dark/Auto). Web-search provider, diff layout and update channel are
 *    `Select`s — they are one-of-N choices, not a closed set worth four pills.
 *  - **Prose became `(i)`.** Background jobs, compaction reserve, the canary
 *    warning and the retention rule are hints now, opened on hover or focus.
 *  - **Rows come from `ui/list-row.tsx`** and dots from `ui/status-dot.tsx`.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
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

import { useFixture } from "./fixtures";
import {
  AsyncSection,
  Cell,
  CommitField,
  CONTROL_W,
  DataTable,
  DetailLine,
  Health,
  HealthPanel,
  ItemRow,
  OverrideNote,
  PrefRow,
  PrefSection,
  Provenance,
  SectionAction,
  SectionIconAction,
  type Fault,
  type PrefGroup,
} from "./kit";

/* ------------------------------- General ---------------------------------- */

function GeneralPane() {
  return (
    <PrefSection title="Language & region" icon={GearSixIcon}>
      <PrefRow label="Week starts on" htmlFor="week-start">
        <Select value="monday">
          <SelectTrigger id="week-start" className={CONTROL_W.md}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sunday">Sunday</SelectItem>
            <SelectItem value="monday">Monday</SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>
    </PrefSection>
  );
}

/* ------------------------------- Storage ---------------------------------- */

/** The empty list every collection here falls back to in the lab's empty mode. */
const EMPTY: readonly never[] = [];

interface Orphan {
  path: string;
  reason: string;
}

function StoragePane() {
  const [orphans] = React.useState<readonly Orphan[]>([
    { path: "~/.volli/worktrees/volli-code-9f2/VC-88-flaky-auth", reason: "3 uncommitted files" },
    { path: "~/.volli/worktrees/volli-code-9f2/VC-91-rail-port", reason: "1 uncommitted file" },
  ] as const);

  return (
    <>
      <PrefSection title="Retention" icon={TreeStructureIcon}>
        <PrefRow
          label="Keep Done worktrees for"
          htmlFor="ttl"
          // The sanctioned trust-boundary exception, and the reason it stays
          // prose rather than becoming a hint: this governs an automatic
          // deletion, and what gets deleted must not be behind a disclosure.
          description="Volli removes the folder and keeps the branch, its commits, and the ticket."
        >
          <CommitField
            id="ttl"
            type="number"
            width="sm"
            value="14"
            validate={(next) => {
              const parsed = Number.parseInt(next.trim(), 10);
              if (!Number.isFinite(parsed) || parsed < 1) {
                return "Enter a whole number of days, at least 1.";
              }
              return null;
            }}
            confirm={(next) =>
              Number.parseInt(next, 10) >= 7 ||
              window.confirm(
                `Keep Done worktrees for only ${next} day(s)? Folders will be removed sooner.`,
              )
            }
            onCommit={(next) => ({ ok: true, value: String(Number.parseInt(next, 10)) })}
          />
          <span className="text-ui text-muted-foreground">days</span>
        </PrefRow>
      </PrefSection>

      <AsyncSection
        title="Orphaned worktrees"
        icon={TreeStructureIcon}
        hint={<>Never swept automatically while they hold uncommitted work.</>}
        action={<SectionIconAction label="Rescan orphaned worktrees" />}
        state={useFixture(orphans, EMPTY)}
        isEmpty={(list) => list.length === 0}
        empty="No orphaned worktrees."
      >
        {(list) => (
          <>
            {list.map((orphan) => (
              <ItemRow key={orphan.path} name={orphan.path} meta={orphan.reason}>
                <Button size="icon-xs" variant="ghost" aria-label={`Reveal ${orphan.path}`}>
                  <FolderOpenIcon />
                </Button>
                <Button size="icon-xs" variant="ghost" aria-label={`Delete ${orphan.path}`}>
                  <TrashIcon />
                </Button>
              </ItemRow>
            ))}
          </>
        )}
      </AsyncSection>

      <PrefSection
        title="Database"
        icon={DatabaseIcon}
        action={<SectionAction label="Reveal" icon={FolderOpenIcon} />}
      >
        <PrefRow label="Size">
          <span className="text-ui text-muted-foreground">12.4 MB</span>
        </PrefRow>
        <PrefRow label="Backup">
          <Button size="sm" variant="outline">
            Export as JSON…
          </Button>
        </PrefRow>
      </PrefSection>
    </>
  );
}

/* ----------------------------- Appearance --------------------------------- */

function AppearancePane() {
  const [mode, setMode] = React.useState("dark");

  return (
    <>
      <PrefSection title="Theme" icon={PaletteIcon}>
        {/*
         * THE ONE SEGMENTED CONTROL ON THIS SURFACE. It earns the shape: a
         * closed three-way, all of it on screen, each member with an icon, and
         * the thing being chosen is visible behind the control as you choose.
         * Everything else that was a pill is now a Select.
         */}
        <PrefRow label="Mode" testId="appearance-mode">
          <Segmented
            ariaLabel="Appearance mode"
            value={mode}
            options={[
              { key: "light", label: "Light", icon: SunIcon },
              { key: "dark", label: "Dark", icon: MoonIcon },
              { key: "auto", label: "Auto", icon: MonitorIcon },
            ]}
            onChange={setMode}
          />
        </PrefRow>

        {/*
         * The canvas editor keeps its own block — rule 4's one recorded
         * exception. It is an authoring surface, not a setting: a pad, a stop
         * row, a picker, vibrancy, grain and the contrast guardrail. Collapsing
         * it behind a modal would also scrim the window it is judged against.
         */}
        <div className="border-t border-border/50 py-4">
          <p className="pb-2 text-sm font-medium">Canvas</p>
          <div className="flex h-24 items-center justify-center rounded-md bg-primary/20 text-ui text-muted-foreground">
            gradient pad · stops · picker
          </div>
        </div>
        <PrefRow label="Vibrancy" htmlFor="vibrancy">
          <span className="text-ui text-muted-foreground">slider</span>
        </PrefRow>
        <PrefRow label="Grain">
          <span className="text-ui text-muted-foreground">dial</span>
        </PrefRow>
        <PrefRow label="Per-project themes">
          <OverrideNote projects={["acme-api", "dashboard"]} onOpen={() => {}} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Display" icon={MonitorIcon}>
        <PrefRow label="Zoom" htmlFor="zoom">
          <Select value="100">
            <SelectTrigger id="zoom" className={CONTROL_W.sm}>
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
        {/* Was a Segmented. Two options that are not a mode and have no icons
            do not need two pills; a Select says the same thing quieter. */}
        <PrefRow label="Diff layout" htmlFor="diff">
          <Select value="inline">
            <SelectTrigger id="diff" className={CONTROL_W.md}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inline">Inline</SelectItem>
              <SelectItem value="split">Side by side</SelectItem>
            </SelectContent>
          </Select>
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Terminal"
        icon={TerminalWindowIcon}
        hint={<>Volli overrides only what you set here.</>}
      >
        <PrefRow label="Theme">
          <Provenance>From Ghostty</Provenance>
          <Button size="sm" variant="outline">
            Rosé Pine
          </Button>
        </PrefRow>
        <PrefRow label="Font">
          <Provenance mine>Set by Volli</Provenance>
          <Button size="icon-xs" variant="ghost" aria-label="Revert font-family to Ghostty">
            <ArrowSquareOutIcon />
          </Button>
          <Button size="sm" variant="outline">
            Geist Mono
          </Button>
        </PrefRow>
        <PrefRow label="Size">
          <Provenance mine>Set by Volli</Provenance>
          <Button size="icon-xs" variant="ghost" aria-label="Revert font-size to Ghostty">
            <ArrowSquareOutIcon />
          </Button>
          <span className="text-ui tabular-nums">13 pt</span>
        </PrefRow>
        <PrefRow label="Config files">
          <Button size="sm" variant="outline">
            <FileTextIcon />
            Ghostty config
          </Button>
          <Button size="sm" variant="outline">
            <FileTextIcon />
            Volli overlay
          </Button>
        </PrefRow>
      </PrefSection>
    </>
  );
}

/* --------------------------- Notifications -------------------------------- */

function NotificationsPane() {
  const [on, setOn] = React.useState(true);
  const [events, setEvents] = React.useState<Record<string, boolean>>({
    needsYou: true,
    finished: true,
    failed: true,
    moved: false,
  });
  const set = (key: string) => (value: boolean) =>
    setEvents((current) => ({ ...current, [key]: value }));

  return (
    <PrefSection title="Notifications" icon={BellIcon}>
      <PrefRow label="Notify me">
        <Switch checked={on} onCheckedChange={setOn} />
      </PrefRow>
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
    </PrefSection>
  );
}

/* ------------------------------- Models ----------------------------------- */

interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  context: string;
  reserve: string;
  reservable: boolean;
  shown: boolean;
}

const CATALOG: readonly CatalogModel[] = [
  {
    id: "a/opus",
    name: "claude-opus-4.6",
    provider: "Anthropic",
    context: "200K",
    reserve: "32K",
    reservable: true,
    shown: true,
  },
  {
    id: "a/sonnet",
    name: "claude-sonnet-4.6",
    provider: "Anthropic",
    context: "200K",
    reserve: "Default",
    reservable: true,
    shown: true,
  },
  {
    id: "a/haiku",
    name: "claude-haiku-4.5",
    provider: "Anthropic",
    context: "200K",
    reserve: "Default",
    reservable: true,
    shown: true,
  },
  {
    id: "o/luna",
    name: "gpt-5.6-luna",
    provider: "OpenAI Codex",
    context: "400K",
    reserve: "64K",
    reservable: true,
    shown: true,
  },
  {
    id: "o/mini",
    name: "gpt-5.6-mini",
    provider: "OpenAI Codex",
    context: "400K",
    reserve: "Default",
    reservable: true,
    shown: false,
  },
  {
    id: "x/luna",
    name: "gpt-5.6-luna",
    provider: "xAI",
    context: "256K",
    reserve: "Default",
    reservable: true,
    shown: false,
  },
  {
    id: "g/gemini",
    name: "gemini-3-pro",
    provider: "Google",
    context: "1M",
    reserve: "Default",
    reservable: false,
    shown: true,
  },
  {
    id: "g/flash",
    name: "gemini-3-flash",
    provider: "Google",
    context: "1M",
    reserve: "Default",
    reservable: true,
    shown: true,
  },
  {
    id: "m/large",
    name: "mistral-large-3",
    provider: "Mistral",
    context: "128K",
    reserve: "Default",
    reservable: true,
    shown: false,
  },
  {
    id: "d/v4",
    name: "deepseek-v4",
    provider: "DeepSeek",
    context: "128K",
    reserve: "Default",
    reservable: true,
    shown: false,
  },
];

function ModelsPane() {
  const [visibility, setVisibility] = React.useState("all");

  const filtered = React.useMemo(() => {
    if (visibility === "shown") return CATALOG.filter((model) => model.shown);
    if (visibility === "hidden") return CATALOG.filter((model) => !model.shown);
    return CATALOG;
  }, [visibility]);

  return (
    <>
      <PrefSection
        title="Defaults"
        icon={CpuIcon}
        action={<SectionIconAction label="Refresh models" />}
      >
        <PrefRow label="Project chats" testId="default-model-global">
          <ModelSelect value="a/sonnet" />
          <ReasoningSelect value="high" />
        </PrefRow>
        <PrefRow label="Ticket Sessions" testId="default-model-ticket">
          <ModelSelect value="a/opus" />
          <ReasoningSelect value="max" />
        </PrefRow>
        {/* Was a three-line `description`. Now a hint you can open. */}
        <PrefRow
          label="Background jobs"
          testId="default-model-utility"
          hint={<>Naming chats and summarizing. Unset, they use the chat&rsquo;s own model.</>}
        >
          <ModelSelect value="a/haiku" />
          <ReasoningSelect value="off" />
        </PrefRow>
        <PrefRow label="Per-project defaults">
          <OverrideNote projects={["acme-api"]} onOpen={() => {}} />
        </PrefRow>
      </PrefSection>

      <PrefSection title="Compaction" icon={ArrowsInLineVerticalIcon}>
        <PrefRow
          label="Compact automatically"
          testId="auto-compaction"
          hint={<>Summarizes earlier turns near the context limit. Reserve is per model, below.</>}
        >
          <Switch defaultChecked />
        </PrefRow>
      </PrefSection>

      {/*
       * THE CATALOGUE, AS A TABLE.
       *
       * This is the change the whole component pass was for. Ten models here,
       * a hundred in the real app — as a stack of two-line rows that was a
       * section with no bottom, and Accounts below it was unreachable. Capped
       * at eight rows, it scrolls inside its own frame and the page stays
       * navigable.
       *
       * Provider becomes a COLUMN, which does two things a badge could not: it
       * aligns, so a reader scanning for "who makes this" reads down a strip
       * instead of hunting mid-row; and it distinguishes the two models both
       * called `gpt-5.6-luna` without either row having to shout.
       */}
      <PrefSection title="Catalog" icon={CpuIcon}>
        <DataTable
          label="Model catalog"
          items={filtered}
          keyOf={(model) => model.id}
          rows={8}
          search={(model) => `${model.name} ${model.provider}`}
          placeholder="Search models"
          filter={{
            label: "Filter by visibility",
            value: visibility,
            onChange: setVisibility,
            options: [
              { value: "all", label: "All models" },
              { value: "shown", label: "Shown in pickers" },
              { value: "hidden", label: "Hidden" },
            ],
          }}
          empty="No models. Sign in to a provider below."
          noResults="No models match."
          columns={[
            {
              key: "name",
              header: "Model",
              cell: (model) => <Cell>{model.name}</Cell>,
            },
            {
              key: "provider",
              header: "Provider",
              width: "9rem",
              cell: (model) => <Cell muted>{model.provider}</Cell>,
            },
            {
              key: "context",
              header: "Context",
              width: "5rem",
              align: "end",
              cell: (model) => <Cell muted>{model.context}</Cell>,
            },
            {
              key: "reserve",
              header: "Reserve",
              width: "8rem",
              align: "end",
              cell: (model) =>
                model.reservable ? (
                  <Select value={model.reserve}>
                    <SelectTrigger
                      size="sm"
                      className="w-full"
                      aria-label={`Compaction reserve for ${model.name}`}
                      data-testid={`compaction-reserve-${model.id}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Default">Default</SelectItem>
                      <SelectItem value="32K">32K</SelectItem>
                      <SelectItem value="64K">64K</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  // No usable window, so no control — and the column holds
                  // its width so the switch beside it stays aligned.
                  <Cell muted>—</Cell>
                ),
            },
            {
              key: "shown",
              header: "Shown",
              width: "3.5rem",
              align: "end",
              headerHidden: true,
              cell: (model) => (
                <Switch
                  defaultChecked={model.shown}
                  aria-label={`Show ${model.name} by ${model.provider} in pickers`}
                  data-testid={`visibility-${model.id}`}
                />
              ),
            },
          ]}
        />
      </PrefSection>

      <PrefSection title="Accounts" icon={UserCircleIcon}>
        <ItemRow
          name="Anthropic"
          meta="Claude Pro"
          badges={<Health state="ready">Signed in</Health>}
        >
          <Button size="sm" variant="outline">
            Sign out
          </Button>
        </ItemRow>
        <ItemRow
          name="OpenAI Codex"
          meta="API key"
          badges={<Health state="ready">Signed in</Health>}
        >
          <Button size="sm" variant="outline">
            Sign out
          </Button>
        </ItemRow>
        <ItemRow
          name="Google Vertex"
          meta="Not signed in"
          badges={<Health state="idle">Off</Health>}
        >
          <Button size="sm">Sign in</Button>
        </ItemRow>
      </PrefSection>
    </>
  );
}

function ModelSelect({ value }: { value: string }) {
  const [selected, setSelected] = React.useState(value);
  return (
    <Select value={selected} onValueChange={setSelected}>
      <SelectTrigger className={CONTROL_W.lg}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CATALOG.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.name} · {model.provider}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ReasoningSelect({ value }: { value: string }) {
  const [selected, setSelected] = React.useState(value);
  return (
    <Select value={selected} onValueChange={setSelected}>
      <SelectTrigger className={CONTROL_W.sm} aria-label="Reasoning level">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {["off", "low", "medium", "high", "max"].map((level) => (
          <SelectItem key={level} value={level}>
            {level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ------------------------------ Web search -------------------------------- */

function WebPane() {
  const [provider, setProvider] = React.useState("brave");
  const [keyState, setKeyState] = React.useState<"absent" | "present" | "unreadable">("present");

  const KEY_LABEL = {
    absent: "Not set",
    present: "Stored in your keychain",
    unreadable: "Stored, but unreadable here",
  } as const;

  return (
    <PrefSection title="Web search" icon={GlobeIcon} hint={<>One provider, every project.</>}>
      {/* Was four pills. A Select is the right shape for one-of-N where the
          options aren't a mode and choosing one changes what's below. */}
      <PrefRow label="Provider" htmlFor="provider">
        <Health state={provider === "off" ? "idle" : "ready"}>
          {provider === "off" ? "Off" : "On"}
        </Health>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger id="provider" className={CONTROL_W.md}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="brave">Brave</SelectItem>
            <SelectItem value="exa">Exa</SelectItem>
            <SelectItem value="searxng">SearXNG</SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>
      {provider === "brave" || provider === "exa" ? (
        <PrefRow label="API key" htmlFor="key" align="start">
          <span className="text-ui text-muted-foreground">{KEY_LABEL[keyState]}</span>
          {keyState === "absent" ? null : (
            <Button size="sm" variant="outline" onClick={() => setKeyState("absent")}>
              Remove
            </Button>
          )}
          <CommitField
            id="key"
            type="password"
            value=""
            placeholder={keyState === "absent" ? "Paste your key" : "Replace stored key"}
            onCommit={() => {
              setKeyState("present");
              return { ok: true, value: "" };
            }}
          />
        </PrefRow>
      ) : null}
      {provider === "searxng" ? (
        <PrefRow label="Instance" htmlFor="instance" align="start">
          <CommitField
            id="instance"
            value=""
            placeholder="http://localhost:8888"
            onCommit={(next) =>
              next.startsWith("http")
                ? { ok: true }
                : { ok: false, error: "Must be an http or https URL." }
            }
          />
        </PrefRow>
      ) : null}
    </PrefSection>
  );
}

/* ----------------------------- Integrations ------------------------------- */

/**
 * `external-apps.ts` probes Launch Services, so this list is already what is
 * installed — which is why the empty state below is reachable and not decorative.
 */
const EDITORS: readonly { id: string; label: string }[] = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "xcode", label: "Xcode" },
];

function IntegrationsPane() {
  return (
    <AsyncSection
      title="Open in…"
      icon={PlugsIcon}
      hint={<>Only installed editors appear.</>}
      state={useFixture(EDITORS, EMPTY)}
      isEmpty={(apps) => apps.length === 0}
      empty="None of the editors Volli knows are installed."
    >
      {(apps) => (
        <PrefRow label="Editor" htmlFor="editor">
          <Select value="cursor">
            <SelectTrigger id="editor" className={CONTROL_W.md}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">Ask every time</SelectItem>
              {apps.map((app) => (
                <SelectItem key={app.id} value={app.id}>
                  {app.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PrefRow>
      )}
    </AsyncSection>
  );
}

/* ------------------------------- Updates ---------------------------------- */

function UpdatesPane() {
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
          <Switch defaultChecked />
        </PrefRow>
        {/*
         * ← The `sqlite3` command from `auto-update.ts`, retired.
         *
         * A Select rather than two pills, and a confirm on the way in: a build
         * line that ships broken work and will not downgrade itself is not a
         * one-click toggle.
         */}
        <PrefRow
          label="Channel"
          htmlFor="channel"
          hint={<>Canary breaks more often, and won&rsquo;t downgrade itself.</>}
        >
          <Select
            value={channel}
            onValueChange={(next) => {
              if (
                next === "canary" &&
                !window.confirm(
                  "Canary builds ship the newest work first and break more often. You can switch back, but an installed canary won't downgrade itself. Continue?",
                )
              ) {
                return;
              }
              setChannel(next);
            }}
          >
            <SelectTrigger id="channel" className={CONTROL_W.md}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stable">Stable</SelectItem>
              <SelectItem value="canary">Canary</SelectItem>
            </SelectContent>
          </Select>
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

/* -------------------------------- About ----------------------------------- */

function AboutPane() {
  const [faults, setFaults] = React.useState<readonly Fault[]>([
    {
      id: "legacy",
      headline: "Another volli is shadowing this one",
      detail: "/usr/local/bin/volli — admin-owned, harmless, and safe to delete yourself.",
      remedy: { label: "Reveal", onAct: () => {} },
    },
    {
      id: "path",
      headline: "The volli command isn't on your PATH",
      detail: "Sessions still run. You just can't start one from your own terminal.",
      remedy: { label: "Fix", onAct: () => setFaults((f) => f.filter((x) => x.id !== "path")) },
    },
  ]);

  return (
    <>
      <HealthPanel
        healthy={faults.length === 0}
        headline={
          faults.length === 0
            ? "Everything's working"
            : `${faults.length} thing${faults.length === 1 ? "" : "s"} need attention`
        }
        faults={faults}
        actions={
          <>
            <Button size="sm" variant="outline">
              Copy report…
            </Button>
            <Button size="sm" variant="outline">
              Re-check
            </Button>
          </>
        }
      >
        <DetailLine label="Version" value="0.1.0-canary.9" />
        <DetailLine label="Command line" value="volli — installed" />
        <DetailLine label="Model providers" value="Anthropic, OpenAI Codex" />
        <DetailLine label="Session PATH" value="Matches your login shell" />
        <DetailLine label="Database" value="12.4 MB" />
      </HealthPanel>

      {/*
       * Harness INVENTORY. Small enough to stay a list — three or four entries,
       * not a collection — so a table would be ceremony. The rule is that a
       * table is for a collection that grows; this one doesn't.
       */}
      <PrefSection title="Harnesses" icon={CpuIcon} hint={<>Agent binaries Volli can launch.</>}>
        <ItemRow name="Claude Code" meta="claude" badges={<Provenance>Built-in</Provenance>} />
        <ItemRow name="Codex" meta="codex" badges={<Provenance>Built-in</Provenance>} />
        <ItemRow
          name="my-harness"
          meta="~/bin/my-harness"
          badges={<Provenance mine>Registered</Provenance>}
        />
      </PrefSection>
    </>
  );
}

/* -------------------------------------------------------------------------- */

export const SETTINGS_GROUPS: readonly PrefGroup[] = [
  {
    key: "you",
    label: "Preferences",
    categories: [
      {
        key: "general",
        label: "General",
        icon: GearSixIcon,
        keywords: ["language", "region", "week"],
        content: <GeneralPane />,
      },
      {
        key: "appearance",
        label: "Appearance",
        icon: PaletteIcon,
        keywords: [
          "theme",
          "dark",
          "light",
          "canvas",
          "vibrancy",
          "grain",
          "zoom",
          "font",
          "terminal",
          "diff",
          "ghostty",
          "overlay",
        ],
        content: <AppearancePane />,
      },
      {
        key: "notifications",
        label: "Notifications",
        icon: BellIcon,
        keywords: ["notify", "alert", "background"],
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
        keywords: [
          "model",
          "provider",
          "anthropic",
          "openai",
          "compaction",
          "reserve",
          "reasoning",
          "sign in",
          "account",
        ],
        count: CATALOG.length,
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
        keywords: ["editor", "vscode", "cursor", "zed", "open in"],
        content: <IntegrationsPane />,
      },
    ],
  },
  {
    key: "system",
    label: "System",
    categories: [
      {
        key: "storage",
        label: "Storage",
        icon: TreeStructureIcon,
        keywords: ["retention", "worktree", "orphan", "cleanup", "database", "export", "backup"],
        content: <StoragePane />,
      },
      {
        key: "updates",
        label: "Updates",
        icon: DownloadSimpleIcon,
        keywords: ["update", "version", "canary", "prerelease", "channel"],
        attention: { state: "ready", label: "update ready" },
        content: <UpdatesPane />,
      },
      {
        key: "about",
        label: "About",
        icon: InfoIcon,
        keywords: ["version", "diagnostics", "doctor", "cli", "harness", "health", "support"],
        attention: { state: "waiting", label: "2 problems" },
        content: <AboutPane />,
      },
    ],
  },
];
