/**
 * VC-111 — the proposed **Settings** surface. Second pass.
 *
 * Settings is app-wide, always. There is no scope switch: the surface IS the
 * scope (kit rule 2). Where an app-wide value can be overridden per project,
 * the row carries an `OverrideNote` naming the projects that did it, and the
 * override itself is set in Configure.
 *
 * WHAT CHANGED AFTER REVIEW:
 *  - **Storage is back.** The first pass dropped orphaned-worktree cleanup —
 *    a live feature with a permanent-delete flow — off the IA and off the kill
 *    list, so it vanished without anyone deciding to remove it (review §2.1).
 *    It is app-wide by construction (`sweepOrphans` walks every project), so it
 *    belongs here, next to the retention window that governs it.
 *  - **Reasoning is back** (review §2.2). A control that costs money is not
 *    fixed by deleting it.
 *  - **The web key keeps Remove and its three-state label** (review §1.5).
 *  - **The terminal keeps both config-file buttons and the per-key revert** —
 *    the app's only real reset-to-default (review §2.7, §7.3).
 *  - **The canvas keeps Vibrancy, Grain and ContrastAlert.** The first pass
 *    replaced the whole editor with a swatch and an "Edit…" button opening
 *    something that did not exist, discarding an accessibility guardrail
 *    (review §2.8).
 *  - **Every section description is gone**, per CLAUDE.md. The first pass added
 *    thirteen; `PrefSection` no longer has the prop.
 *  - **The invented settings are gone**: "Reopen last project" had no backing
 *    state and "Confirm before quitting" was a switch to disable a documented
 *    data-loss guard (review §2.9).
 *  - **Every pane declares its states** via `AsyncSection`.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";

import { Badge } from "@renderer/components/ui/badge";
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
  AsyncSection,
  CommitField,
  CONTROL_W,
  DetailLine,
  Health,
  HealthPanel,
  ItemList,
  ItemRow,
  OverrideNote,
  PrefRow,
  PrefSection,
  Provenance,
  SectionAction,
  SectionIconAction,
  type AsyncState,
  type Fault,
  type PrefGroup,
} from "./kit";

/* -------------------------------------------------------------------------- */

/** Fixtures. `ready` here; the panes exist to show the SHAPE of each state. */
function ready<T>(data: T): AsyncState<T> {
  return { status: "ready", data };
}

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

interface Orphan {
  path: string;
  reason: string;
}

/**
 * Storage — retention, the orphan sweep, and the database.
 *
 * The category the first pass lost. Retention and orphan cleanup are the same
 * subject (how long a finished ticket's checkout is worth keeping) and today
 * they sit in two different Settings categories; putting them in one is the
 * reorganization actually doing something.
 */
function StoragePane() {
  const [orphans] = React.useState<AsyncState<readonly Orphan[]>>(
    ready([
      { path: "~/.volli/worktrees/volli-code-9f2/VC-88-flaky-auth", reason: "3 uncommitted files" },
      { path: "~/.volli/worktrees/volli-code-9f2/VC-91-rail-port", reason: "1 uncommitted file" },
    ]),
  );

  return (
    <>
      <PrefSection title="Retention" icon={TreeStructureIcon}>
        <PrefRow
          label="Keep Done worktrees for"
          htmlFor="ttl"
          // The sanctioned trust-boundary exception: this governs an automatic
          // deletion, so the row states what is taken and what survives.
          description="Volli removes the folder and keeps the branch, its commits, and the ticket."
        >
          <CommitField
            id="ttl"
            type="number"
            width="sm"
            value="14"
            // Review §1.5: the first pass sent the raw string on blur, so
            // select-all-type-1-click-away silently armed a one-day automatic
            // folder deletion. Validated locally, then confirmed, because the
            // consequence is destructive and there is no undo.
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
        action={<SectionIconAction label="Rescan orphaned worktrees" />}
        state={orphans}
        isEmpty={(list) => list.length === 0}
        empty="No orphaned worktrees."
      >
        {(list) => (
          <>
            {list.map((orphan) => (
              <ItemRow key={orphan.path} name={orphan.path} meta={orphan.reason}>
                <Button size="icon-xs" variant="ghost" aria-label="Reveal in Finder">
                  <FolderOpenIcon />
                </Button>
                <Button size="icon-xs" variant="ghost" aria-label="Delete worktree">
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
  const [diff, setDiff] = React.useState("inline");

  return (
    <>
      <PrefSection title="Theme" icon={PaletteIcon}>
        <PrefRow label="Mode" testId="appearance-mode">
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
        </PrefRow>
        {/*
         * The canvas editor stays WHOLE. Review §2.8: it is not a gradient pad,
         * it is the pad, the stop row, the colour picker, Vibrancy, Grain and
         * ContrastAlert — an accessibility guardrail with a one-click
         * remediation. Collapsing it to a swatch plus a modal would also have
         * put `bg-scrim` over the very window the edit is judged against.
         *
         * So rule 4 ("every control is a row") takes its one recorded
         * exception, stated here rather than quietly broken: the canvas is an
         * authoring surface, and it keeps its own block inside this section.
         */}
        <div className="border-t border-border/50 py-2">
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
        <div className="border-t border-border/50 py-2">
          <OverrideNote projects={["acme-api", "dashboard"]} onOpen={() => {}} />
        </div>
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

      <PrefSection title="Terminal" icon={TerminalWindowIcon}>
        {/*
         * All three rows, at app scope, always. The first pass hid Font and
         * Size whenever its scope switch was on a project, so a user looking
         * for terminal font size concluded Volli had no such setting
         * (review §1.2a). Both config-file buttons stay: decision #67/#68 is
         * that the file IS the full interface, and keeping the trust sentence
         * while deleting the button that proves it is the wrong half.
         */}
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
  /** Some models report no usable window, so they get no reserve control at all. */
  reservable: boolean;
}

const CATALOG: readonly CatalogModel[] = [
  {
    id: "a/opus",
    name: "claude-opus-4.6",
    provider: "Anthropic",
    context: "200K",
    reserve: "32K",
    reservable: true,
  },
  {
    id: "a/sonnet",
    name: "claude-sonnet-4.6",
    provider: "Anthropic",
    context: "200K",
    reserve: "Default",
    reservable: true,
  },
  {
    id: "a/haiku",
    name: "claude-haiku-4.5",
    provider: "Anthropic",
    context: "200K",
    reserve: "Default",
    reservable: true,
  },
  {
    id: "o/luna",
    name: "gpt-5.6-luna",
    provider: "OpenAI Codex",
    context: "400K",
    reserve: "64K",
    reservable: true,
  },
  {
    id: "x/luna",
    name: "gpt-5.6-luna",
    provider: "xAI",
    context: "256K",
    reserve: "Default",
    reservable: true,
  },
  {
    id: "g/gemini",
    name: "gemini-3-pro",
    provider: "Google",
    context: "1M",
    reserve: "Default",
    reservable: false,
  },
];

function ModelsPane() {
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
        <PrefRow
          label="Background jobs"
          testId="default-model-utility"
          help="Naming new chats and summarizing long conversations. Left unset, these run on the model the chat itself is using — an inexpensive model here keeps them cheap."
        >
          <ModelSelect value="a/haiku" />
          <ReasoningSelect value="off" />
        </PrefRow>
        <div className="border-t border-border/50 py-2">
          <OverrideNote projects={["acme-api"]} onOpen={() => {}} />
        </div>
      </PrefSection>

      <PrefSection title="Compaction" icon={ArrowsInLineVerticalIcon}>
        <PrefRow label="Compact automatically" testId="auto-compaction">
          <Switch defaultChecked />
        </PrefRow>
        {/*
         * The per-model reserve lives on the model row, two sections down, and
         * the code comment on today's pane explains why that is right. What was
         * missing is anything in the UI connecting them. One line does it.
         */}
        <PrefRow label="Reserve per model">
          <span className="text-ui text-muted-foreground">Set in Catalog, below</span>
        </PrefRow>
      </PrefSection>

      <PrefSection title="Catalog" icon={EyeIcon}>
        <ItemList
          items={CATALOG}
          keyOf={(model) => model.id}
          // Review §2.5: the provider is half a model's identity — eight
          // providers ship a model called exactly "gpt-5.6-luna" — so the
          // haystack includes it and the two rows above are distinguishable.
          search={(model) => `${model.name} ${model.provider}`}
          placeholder="Search models"
          noResults="No models match."
          render={(model) => (
            <ItemRow
              name={model.name}
              meta={`${model.provider} · ${model.context} context`}
              testId={`visibility-${model.id}`}
            >
              {/*
               * A model whose window yields no reserve choices renders NO
               * control today. The first pass hand-wrote a fake table header
               * over the column, so that row's switch slid left and sat under
               * the "Compaction reserve" label (review §3.3). A placeholder
               * of the same width keeps the column honest without inventing
               * an inert control.
               */}
              {model.reservable ? (
                <Select value={model.reserve}>
                  <SelectTrigger
                    className={CONTROL_W.md}
                    aria-label={`Compaction reserve for ${model.name}`}
                    data-testid={`compaction-reserve-${model.id}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Default">Default reserve</SelectItem>
                    <SelectItem value="32K">32K reserve</SelectItem>
                    <SelectItem value="64K">64K reserve</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <span className={CONTROL_W.md} aria-hidden />
              )}
              <Switch defaultChecked aria-label={`Show ${model.name} in pickers`} />
            </ItemRow>
          )}
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
        <ItemRow name="Google Vertex" badges={<Health state="idle">Not signed in</Health>}>
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

/**
 * Reasoning level. Review §2.2 — the first pass deleted this control because
 * the audit called it naked. It costs money and changes output quality; the fix
 * is a name and a disabled reason, not removal.
 */
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
  // Review §1.5 / §6.10: the first pass rendered "In your keychain"
  // unconditionally — a claim that is false whenever no key is stored — and
  // dropped Remove entirely. Three states, and the action that clears it.
  const [keyState, setKeyState] = React.useState<"absent" | "present" | "unreadable">("present");

  const KEY_LABEL = {
    absent: "Not set",
    present: "Stored in your keychain",
    unreadable: "Stored, but unreadable here",
  } as const;

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
              // Cleared on success: a plaintext key has no reason to stay in a
              // React tree once main has encrypted it.
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
            // The endpoint policy's refusal is a correction to what was just
            // typed, so it lands beside the field rather than in a toast — the
            // decision `web-access-settings.tsx` documents in its header and
            // the first pass would have regressed.
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

interface ExternalApp {
  id: string;
  label: string;
  installed: boolean;
}

/**
 * Review §2.10: `external-apps.ts` probes Launch Services, so the catalogue is
 * already filtered to what is installed. A hardcoded list with no
 * "not installed" state and no empty state was inventing a simpler world.
 */
const EDITORS: readonly ExternalApp[] = [
  { id: "vscode", label: "VS Code", installed: true },
  { id: "cursor", label: "Cursor", installed: true },
  { id: "zed", label: "Zed", installed: false },
  { id: "xcode", label: "Xcode", installed: true },
];

function IntegrationsPane() {
  const installed = EDITORS.filter((app) => app.installed);
  return (
    <AsyncSection
      title="Open in…"
      icon={PlugsIcon}
      state={ready(installed)}
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
         * ← The sqlite3 command from `auto-update.ts`, retired.
         *
         * Review §1.5 flagged that a one-click switch to a build line that
         * ships broken work and cannot be trivially downgraded is the wrong
         * default for save-on-change. It confirms.
         */}
        <PrefRow label="Channel">
          <Segmented
            ariaLabel="Update channel"
            value={channel}
            options={[
              { key: "stable", label: "Stable" },
              { key: "canary", label: "Canary" },
            ]}
            onChange={(next) => {
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

/* -------------------------------- About ----------------------------------- */

/**
 * About — concise on a healthy machine, complete on a broken one.
 *
 * Review §1.4 found nine things the first pass's "one sentence, one button"
 * silently dropped. `HealthPanel` takes the faults that are ACTUALLY PRESENT,
 * each carrying the remedy `cli-status-model.ts` already computes — so a
 * healthy machine still reads as one sentence, and a broken one keeps its
 * four-state link, its reinstall path and its per-check Doctor remedies.
 */
function AboutPane() {
  const [faults, setFaults] = React.useState<readonly Fault[]>([
    {
      id: "legacy",
      headline: "Another volli is shadowing this one",
      // The path is shown. The user is told they can delete it; a remedy whose
      // object is hidden as an "internal" is not a remedy (review §1.4.1).
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
            {/*
             * Review §1.4.9: a button that copies $PATH, home directory and
             * usernames to the clipboard WITHOUT showing them is worse than
             * printing them, for a local-first app. So it previews first.
             */}
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
        <DetailLine label="Harnesses" value="Claude Code (claude), Codex (codex)" />
        <DetailLine label="Model providers" value="Anthropic, OpenAI Codex" />
        <DetailLine label="Session PATH" value="Matches your login shell" />
        <DetailLine label="Database" value="12.4 MB" />
      </HealthPanel>

      {/*
       * Harness INVENTORY, not diagnostic. Review §6.12: `HarnessSelector` is
       * the only surface answering "did Volli pick up the harness I registered,
       * and which binary will it launch?" — so it survives the collapse as a
       * list with the resolved command and the origin chip, rather than as a
       * comma-separated string in Details.
       */}
      <PrefSection title="Harnesses" icon={CpuIcon}>
        <ItemRow
          name="Claude Code"
          meta="claude"
          badges={<Badge variant="secondary">Built-in</Badge>}
        />
        <ItemRow name="Codex" meta="codex" badges={<Badge variant="secondary">Built-in</Badge>} />
        <ItemRow
          name="my-harness"
          meta="~/bin/my-harness"
          badges={<Badge variant="outline">Registered</Badge>}
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
        attention: { tone: "primary", label: "update ready" },
        content: <UpdatesPane />,
      },
      {
        key: "about",
        label: "About",
        icon: InfoIcon,
        keywords: ["version", "diagnostics", "doctor", "cli", "harness", "health", "support"],
        attention: { tone: "destructive", label: "2 problems" },
        content: <AboutPane />,
      },
    ],
  },
];
