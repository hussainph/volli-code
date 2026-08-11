/**
 * The design-system audit, rendered as an interactive Lab reference.
 *
 * This page deliberately puts two kinds of evidence beside one another:
 *
 *   1. Current primitives imported from the app, so the mismatched control
 *      rhythm is the real one rather than a redrawn approximation.
 *   2. Proposed surface, density, radius, and motion rules rendered locally,
 *      so the system can be judged before production code adopts it.
 *
 * The proposal borrows the mechanics of Fluid Functionalism (relative surface
 * depth and region-owned size context), not its product styling wholesale.
 * Volli keeps its generated canvas, ember accent, Mona/Geist typography, and
 * excellent shell seam. This scratch exists to make those strengths systemic.
 */
import * as React from "react";
import type { ReactNode } from "react";

import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";

import { project, ticketById } from "../fixtures";
import { appApi, seedBoard } from "../seed";

export const title = "Design system · audit";
export const note = "Surfaces, density, radius, components, motion, and a migration path";
export const seed = seedBoard;
export const api = appApi;

const PAGES = [
  { id: "thesis", label: "System thesis" },
  { id: "surfaces", label: "Surfaces" },
  { id: "sizes", label: "Sizes" },
  { id: "radius", label: "Radius" },
  { id: "components", label: "Components" },
  { id: "motion", label: "Motion & states" },
  { id: "roadmap", label: "Roadmap" },
] as const;

type PageId = (typeof PAGES)[number]["id"];
type Density = "normal" | "compact";
type OperationState = "rest" | "pending" | "success" | "failure";

const SURFACE_LEVELS = [
  { level: 1, role: "Canvas", use: "Window frame and project rail", token: "--canvas" },
  { level: 2, role: "Shell", use: "Primary sidebar and principal workspace", token: "--lift-2" },
  { level: 3, role: "Plane", use: "Reading and workbench substrate", token: "--background" },
  { level: 4, role: "Section", use: "Grouped settings and quiet regions", token: "--card" },
  { level: 5, role: "Raised", use: "Cards, composer, active objects", token: "--secondary" },
  { level: 6, role: "Popover", use: "Menus, selects, contextual inspectors", token: "--popover" },
  { level: 7, role: "Dialog", use: "Blocking task surface", token: "relative + shadow" },
  {
    level: 8,
    role: "Nested",
    use: "Picker or menu opened inside level 7",
    token: "relative + shadow",
  },
] as const;

const AUDIT_ROWS = [
  {
    severity: "High",
    before: "Button defaults to 28px; Input and Select default to 36px",
    after: "One inherited control token: 36px normal, 28px compact",
    why: "Adjacent controls stop looking like unrelated kits.",
    source: "ui/button.tsx:32 · ui/input.tsx:11 · ui/select.tsx:34",
  },
  {
    severity: "High",
    before: "Popover, select, dropdown, and nested menus always use bg-popover",
    after: "Each overlay lifts one step from the substrate that opened it",
    why: "Nested overlays remain visible without caller-specific color props.",
    source: "ui/popover.tsx:33 · ui/select.tsx:59 · ui/dropdown-menu.tsx:37",
  },
  {
    severity: "High",
    before: "CSS zoom is the only app-wide answer to a small screen",
    after: "Density changes rhythm; zoom remains a separate accessibility tool",
    why: "Compact mode preserves crisp type and known hit areas.",
    source: "stores/ui.ts:89-130 · components/app-shell.tsx:133",
  },
  {
    severity: "Medium",
    before:
      "Overlay classes advertise shadow-md/lg, while global CSS overrides most—but not Select or Hover Card",
    after: "One contextual, size-aware shadow contract covers the whole overlay family",
    why: "Source intent and runtime depth agree; a tooltip no longer casts a dialog-sized shadow.",
    source: "globals.css:774-785 · ui/select.tsx:59 · ui/hover-card.tsx:27",
  },
  {
    severity: "Medium",
    before: "Pill Button is repeatedly overridden to rounded-md in chrome",
    after: "Shape follows role: pill action, squircle navigation, shell container",
    why: "Exceptions become named semantics instead of local class patches.",
    source: "ui/button.tsx:8 · ticket/ticket-rail.tsx:78",
  },
  {
    severity: "Medium",
    before: "SettingsSection and TicketCard are both rounded-lg bordered cards",
    after: "Sections recede; actionable entities lift and react",
    why: "Hierarchy comes from surface behavior, not more framing.",
    source: "pages/settings-shell.tsx:124 · board/ticket-card.tsx:59",
  },
  {
    severity: "Medium",
    before: "Primitive icons mix Lucide Select glyphs with Phosphor product chrome",
    after: "Phosphor owns product controls; vendor icons stay inside vendor surfaces",
    why: "Stroke, silhouette, and optical weight stop shifting between neighbors.",
    source: "ui/select.tsx:3 · ui/dialog.tsx:4",
  },
  {
    severity: "High",
    before:
      "Streaming reasoning stacks pulse and a repainting 1.6s shimmer with no reduced-motion branch",
    after: "One quiet working-state cue with a non-moving reduced-motion equivalent",
    why: "The primary chat surface stops spending motion and paint on duplicate status signals.",
    source: "ai-elements/reasoning.tsx:76-84 · ai-elements/shimmer.tsx:42-83",
  },
  {
    severity: "High",
    before: "Chat disclosure animates grid rows for 400ms inside a busy transcript",
    after: "A faster disclosure preset with measured large-body behavior",
    why: "Frequent inspection stays responsive and spends less time in layout.",
    source: "chat/activity-ui.tsx:61-71 · chat/activity-ui.tsx:165-185",
  },
  {
    severity: "High",
    before:
      "Equivalent overlays disagree on reduced motion: Dialog opts out; AlertDialog and Select do not",
    after: "One overlay accessibility contract preserves a short fade and removes movement",
    why: "Reduced motion is predictable across every path into an overlay.",
    source: "ui/dialog.tsx:25-60 · ui/alert-dialog.tsx:24-55 · ui/select.tsx:48-67",
  },
  {
    severity: "Medium",
    before:
      "Files retains stale content under failure; Change Set replaces it with error-only content",
    after: "One async frame contract: rest, pending, stale refresh, success, recoverable failure",
    why: "Failures preserve context and recovery behaves consistently.",
    source: "ticket-files-panel.tsx:164 · ticket-changes-panel.tsx:38",
  },
  {
    severity: "Low",
    before: "Motion values mix ease-out, ease-swift, 100/120/150/180/200/240/300/400ms",
    after: "Frequency-based presets: instant, press, overlay, structural, gesture",
    why: "Motion gets a product voice without animating high-frequency work.",
    source: "globals.css:254-256 · chat/activity-ui.tsx:63-71",
  },
] as const;

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center rounded-full border border-border bg-background/70 p-0.5 shadow-[var(--shadow-raised)]"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="rounded-full px-3 py-1 text-xs text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none aria-pressed:bg-foreground aria-pressed:text-background"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-label uppercase tracking-normal text-primary-text">{children}</p>
  );
}

function Section({
  eyebrow,
  title: sectionTitle,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-5 border-t border-border/70 pt-7 first:border-t-0 first:pt-0">
      <div className="max-w-3xl space-y-1.5">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="text-heading font-semibold tracking-tight text-foreground">
          {sectionTitle}
        </h2>
        {description ? (
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Evidence({ children }: { children: ReactNode }) {
  return <p className="font-mono text-label leading-5 text-muted-foreground/80">{children}</p>;
}

function Metric({ value, label, detail }: { value: string; label: string; detail: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/70 p-4 shadow-[var(--shadow-raised)]">
      <p className="text-title font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-ui font-medium text-foreground">{label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function ThesisPage() {
  return (
    <div className="space-y-10">
      <Section
        eyebrow="Diagnosis"
        title="A strong visual language without a governing component system"
        description="Volli already has exceptional ingredients: a generated warm canvas, a deliberate shell seam, a compact type scale, and thoughtful interaction details. The scattershot feeling comes from primitives consuming absolute sizes and surface colors while feature components patch shape, spacing, and elevation locally."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Metric
            value="8"
            label="Surface roles proposed"
            detail="Relative depth replaces absolute bg-* choices."
          />
          <Metric
            value="2"
            label="Density steps"
            detail="Normal 36px and compact 28px, inherited by region."
          />
          <Metric
            value="3"
            label="Shape families"
            detail="Pill, squircle, and shell—selected by purpose."
          />
        </div>
      </Section>

      <Section
        eyebrow="System thesis"
        title="Keep the character. Replace accidental choices with context."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <SystemCard
            tone="keep"
            title="Preserve"
            items={[
              "Generated canvas and two-appearance token pipeline",
              "Mona Sans + Geist Mono role split",
              "Ember accent and semantic contrast solving",
              "Shell seam, lift tokens, and three shadow recipes",
              "Immediate press feedback and origin-aware overlays",
            ]}
          />
          <SystemCard
            tone="adopt"
            title="Integrate"
            items={[
              "Substrate-aware elevation context",
              "Normal / compact region context",
              "Role-based radius taxonomy",
              "Control metrics that scale as one unit",
              "Explicit async state galleries and motion presets",
            ]}
          />
          <SystemCard
            tone="remove"
            title="Eliminate"
            items={[
              "Per-feature height and padding literals",
              "Absolute overlay surface assumptions",
              "Local shadow classes that disagree with runtime elevation",
              "Radius overrides used as component identity",
              "CSS zoom as a substitute for information density",
            ]}
          />
        </div>
      </Section>

      <Section eyebrow="Decision rules" title="Four constraints should govern every component">
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            [
              "Hierarchy before decoration",
              "A surface must name what it contains and what it sits on.",
            ],
            [
              "Density belongs to a region",
              "Neighboring controls inherit one rhythm; overrides are exceptional.",
            ],
            ["Shape predicts behavior", "Pills act, squircles navigate or edit, shells contain."],
            [
              "Motion carries information",
              "Frequent keyboard work is instant; physical gestures stay interruptible.",
            ],
          ].map(([heading, copy], index) => (
            <div
              key={heading}
              className="flex gap-3 rounded-xl border border-border/70 bg-background p-4"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-xs text-primary-text">
                {index + 1}
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">{heading}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function SystemCard({
  tone,
  title: cardTitle,
  items,
}: {
  tone: "keep" | "adopt" | "remove";
  title: string;
  items: readonly string[];
}) {
  return (
    <article
      className={cn(
        "rounded-xl border p-4 shadow-[var(--shadow-raised)]",
        tone === "keep" && "border-border bg-card",
        tone === "adopt" && "border-primary/35 bg-primary/8",
        tone === "remove" && "border-destructive/25 bg-destructive/5",
      )}
    >
      <h3 className="text-sm font-semibold text-foreground">{cardTitle}</h3>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-xs leading-5 text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "mt-2 size-1.5 shrink-0 rounded-full",
                tone === "keep" && "bg-foreground/45",
                tone === "adopt" && "bg-primary",
                tone === "remove" && "bg-destructive",
              )}
            />
            {item}
          </li>
        ))}
      </ul>
    </article>
  );
}

function SurfacesPage() {
  const ticket = ticketById("tkt-14");
  return (
    <div className="space-y-10">
      <Section
        eyebrow="Current system"
        title="The tokens are richer than the component contract"
        description="The theme generator already emits rail, background, card, popover, secondary, muted, accent, two lift values, and raised/card/overlay shadows. But components choose those values directly, so the same popover cannot lift differently when it opens inside a dialog."
      >
        <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Background", "bg-background"],
              ["Card", "bg-card"],
              ["Secondary", "bg-secondary"],
              ["Popover", "bg-popover"],
            ].map(([label, className]) => (
              <div
                key={label}
                className={cn("min-h-24 rounded-xl border border-border p-3", className)}
              >
                <p className="text-ui font-medium text-foreground">{label}</p>
                <p className="mt-1 font-mono text-label text-muted-foreground">{className}</p>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-raised)]">
            <p className="text-ui font-semibold text-foreground">What already works</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Color is derived as a coherent family, light and dark are solved together, the shell
              uses substrate-specific ink, and the shadows already combine contact and ambient
              layers. The fix is a consumption model—not another palette.
            </p>
            <Evidence>globals.css:34-212 · globals.css:540-663</Evidence>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="Strongest reproduction"
        title="Board substrate, card, and inline composer collapse into one material"
        description="With the shipped tokens, bg-muted/40 on the column composites to within roughly 1–2 RGB steps of bg-card in both appearances. Border changes are carrying almost the entire hierarchy."
      >
        <div className="rounded-xl border border-border bg-background p-4">
          <div className="w-80 max-w-full rounded-lg bg-muted/40 p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-ui font-semibold text-foreground">Doing</span>
              <span className="font-mono text-label text-muted-foreground">2</span>
            </div>
            <TicketCardContent ticket={ticket} ticketPrefix={project.ticketPrefix} />
            <div className="mt-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
              Add a ticket…
            </div>
          </div>
        </div>
        <Evidence>board/board-column.tsx:58,90-102 · board/ticket-card.tsx:57-63</Evidence>
      </Section>

      <Section
        eyebrow="Proposed model"
        title="Eight levels, exposed as roles and consumed relatively"
        description="Most feature code should ask for a role such as raised, popover, or dialog. The primitive resolves the actual level from its substrate. Numeric levels remain an implementation and debugging vocabulary."
      >
        <div className="overflow-hidden rounded-xl border border-border bg-background">
          <div className="grid grid-cols-[3rem_7rem_1fr_9rem] gap-3 border-b border-border px-3 py-2 font-mono text-label uppercase text-muted-foreground max-md:grid-cols-[3rem_6rem_1fr]">
            <span>Level</span>
            <span>Role</span>
            <span>Use</span>
            <span className="max-md:hidden">Source</span>
          </div>
          {SURFACE_LEVELS.map((surface) => (
            <div
              key={surface.level}
              className="grid grid-cols-[3rem_7rem_1fr_9rem] items-center gap-3 border-b border-border/60 px-3 py-2.5 text-xs last:border-b-0 max-md:grid-cols-[3rem_6rem_1fr]"
            >
              <span className="flex size-6 items-center justify-center rounded-full border border-border bg-card font-mono text-label text-foreground">
                {surface.level}
              </span>
              <span className="font-medium text-foreground">{surface.role}</span>
              <span className="text-muted-foreground">{surface.use}</span>
              <span className="font-mono text-label text-muted-foreground max-md:hidden">
                {surface.token}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section eyebrow="Context demo" title="The same overlay must lift from where it opens">
        <div className="grid gap-5 lg:grid-cols-2">
          <SurfaceDemo current />
          <SurfaceDemo />
        </div>
      </Section>
    </div>
  );
}

function SurfaceDemo({ current = false }: { current?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-ui font-semibold text-foreground">
          {current ? "Current: absolute" : "Proposed: relative"}
        </p>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-label",
            current ? "bg-destructive/10 text-destructive" : "bg-primary/15 text-primary-text",
          )}
        >
          {current ? "collapses" : "reads"}
        </span>
      </div>
      <div className="rounded-xl border border-border bg-background p-4">
        <p className="text-xs text-muted-foreground">Page substrate</p>
        <div className="mt-4 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
          <p className="text-ui font-medium text-foreground">Dialog task</p>
          <p className="mt-1 text-xs text-muted-foreground">Choose a model for the next run.</p>
          <div
            className={cn(
              "mt-3 rounded-lg border p-3",
              current
                ? "border-border bg-card shadow-md"
                : "border-border-strong bg-popover shadow-[var(--shadow-overlay)]",
            )}
          >
            <p className="text-xs font-medium text-foreground">Nested model picker</p>
            <div className="mt-2 rounded-md bg-accent px-2 py-1.5 text-xs text-foreground">
              GPT-5.6 Sol · high
            </div>
          </div>
        </div>
      </div>
      <Evidence>
        {current
          ? "Absolute bg-card / bg-popover choices are blind to nesting."
          : "Surface context advances the picker from its dialog substrate."}
      </Evidence>
    </div>
  );
}

function SizesPage({
  density,
  onDensityChange,
}: {
  density: Density;
  onDensityChange(value: Density): void;
}) {
  const metrics =
    density === "normal"
      ? { control: 36, text: 13, icon: 16, px: 12, itemPx: 8, gap: 8 }
      : { control: 28, text: 12, icon: 14, px: 10, itemPx: 6, gap: 4 };

  return (
    <div className="space-y-10">
      <Section
        eyebrow="Live control"
        title="Normal and compact are coherent steps, not zoom factors"
        description="Every metric below changes as one unit. The content hierarchy and meaning remain identical. Compact is for a dense 13-inch workspace; normal restores air on larger displays."
      >
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-raised)]">
          <div>
            <p className="text-sm font-semibold text-foreground">Interface density</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This prototype changes only the examples below.
            </p>
          </div>
          <Segmented
            label="Interface density"
            value={density}
            options={[
              { value: "normal", label: "Normal" },
              { value: "compact", label: "Compact" },
            ]}
            onChange={onDensityChange}
          />
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {Object.entries(metrics).map(([label, value]) => (
            <div
              key={label}
              className="rounded-lg border border-border bg-background p-3 text-center"
            >
              <p className="text-heading font-semibold tabular-nums text-foreground">{value}</p>
              <p className="mt-1 font-mono text-label text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        eyebrow="Current evidence"
        title="Today’s default row visibly mixes two size systems"
        description="These are the real primitives. The Button is 28px; Input and Select are 36px; the Switch is 16px tall. Each is internally polished, but the row has no shared rhythm."
      >
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Search current controls" className="w-48" placeholder="Search…" />
            <Select defaultValue="updated">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated">Last updated</SelectItem>
                <SelectItem value="created">Created</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline">Filter</Button>
            <Button>New</Button>
            <label className="ml-1 flex items-center gap-2 text-ui text-muted-foreground">
              <Switch defaultChecked /> Live
            </label>
          </div>
          <Evidence>Button h-7 · Input h-9 · Select h-9 · Switch h-4</Evidence>
        </div>
      </Section>

      <Section
        eyebrow="Proposed evidence"
        title={`One ${density} region; every control lands at ${metrics.control}px`}
      >
        <PrototypeControlRow density={density} />
        <div className="grid gap-4 lg:grid-cols-2">
          <TypeLadder density="normal" active={density === "normal"} />
          <TypeLadder density="compact" active={density === "compact"} />
        </div>
      </Section>

      <Section
        eyebrow="Architecture"
        title="Density, zoom, and responsive layout solve different problems"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <PolicyCard
            title="Density"
            value="Normal / Compact"
            copy="Changes control, row, icon, gap, and UI type tokens. Persisted user preference."
          />
          <PolicyCard
            title="Zoom"
            value="80–150%"
            copy="Accessibility magnification. Preserve the existing command ladder and keep it independent."
          />
          <PolicyCard
            title="Responsive"
            value="Adaptive chrome"
            copy="Collapses or relocates rails when width is scarce; never silently rewrites density."
          />
        </div>
        <div className="rounded-xl border border-primary/30 bg-primary/8 p-4 text-xs leading-5 text-muted-foreground">
          <strong className="text-foreground">Provider seam:</strong> persist{" "}
          <code className="font-mono text-primary-text">uiDensity</code> in the UI store, mount one
          DensityProvider inside the native chrome band, and let region providers override it for
          board/list/rail/editor areas. Every portaled primitive consumes the context when it
          renders its content.
        </div>
      </Section>

      <Section
        eyebrow="13-inch target"
        title="Recover workspace width before shrinking readable content"
        description="A prior 940px minimum-window probe with the same current rail constants left about 313px for Chat and 263px for its textarea. Compact layout tokens can recover roughly 100px while keeping transcript prose readable."
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            ["Sidebar", "318 → 280"],
            ["Ticket rail", "300 → 240"],
            ["Project rail", "60 → 52"],
            ["Tabs", "32 → 28"],
            ["Title inset", "32 → 16–20"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-card p-3">
              <p className="text-sm font-semibold tabular-nums text-foreground">{value}</p>
              <p className="mt-1 font-mono text-label text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          These are candidate compact tokens for prototype validation, not approved production
          constants. Store independent normal and compact resize preferences so toggling density
          never corrupts a user’s chosen rail widths.
        </p>
      </Section>
    </div>
  );
}

function PrototypeControlRow({ density }: { density: Density }) {
  const compact = density === "compact";
  const style = {
    height: compact ? 28 : 36,
    fontSize: compact ? 12 : 13,
    paddingInline: compact ? 10 : 12,
    gap: compact ? 4 : 8,
  } satisfies React.CSSProperties;
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-raised)]">
      <div className="flex flex-wrap items-center" style={{ gap: compact ? 4 : 8 }}>
        <div
          className="flex min-w-44 flex-1 items-center rounded-lg border border-input bg-background text-muted-foreground shadow-xs"
          style={style}
        >
          Search…
        </div>
        <button
          type="button"
          className="inline-flex items-center rounded-lg border border-input bg-background text-foreground shadow-xs"
          style={style}
        >
          Last updated <span aria-hidden>⌄</span>
        </button>
        <button
          type="button"
          className="inline-flex items-center rounded-full border border-border bg-background text-foreground shadow-xs transition-transform duration-150 ease-out active:scale-[0.97]"
          style={style}
        >
          Filter
        </button>
        <button
          type="button"
          className="inline-flex items-center rounded-full bg-primary text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.97]"
          style={style}
        >
          New
        </button>
      </div>
      <Evidence>
        {density}: control {compact ? 28 : 36} · type {compact ? 12 : 13} · icon {compact ? 14 : 16}{" "}
        · gap {compact ? 4 : 8}
      </Evidence>
    </div>
  );
}

function TypeLadder({ density, active }: { density: Density; active: boolean }) {
  const rows =
    density === "normal"
      ? [
          ["Display", "28"],
          ["Title", "16"],
          ["Subtitle", "14"],
          ["UI body", "13"],
          ["Caption", "12"],
        ]
      : [
          ["Display", "24"],
          ["Title", "15"],
          ["Subtitle", "13"],
          ["UI body", "12"],
          ["Caption", "11"],
        ];
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        active ? "border-primary/40 bg-primary/8" : "border-border bg-background opacity-70",
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-ui font-semibold capitalize text-foreground">{density}</p>
        {active ? (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-label text-primary-text">
            Active
          </span>
        ) : null}
      </div>
      <div className="mt-3 space-y-2">
        {rows.map(([role, size]) => (
          <div
            key={role}
            className="flex items-baseline justify-between border-b border-border/60 pb-2 last:border-0 last:pb-0"
          >
            <span className="text-xs text-muted-foreground">{role}</span>
            <span className="font-mono text-label tabular-nums text-foreground">{size}px</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-label leading-4 text-muted-foreground">
        Ticket prose and editor text remain independently readable; this ladder governs UI chrome.
      </p>
    </div>
  );
}

function PolicyCard({
  title: cardTitle,
  value,
  copy,
}: {
  title: string;
  value: string;
  copy: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="font-mono text-label uppercase text-muted-foreground">{cardTitle}</p>
      <p className="mt-2 text-sm font-semibold text-foreground">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy}</p>
    </div>
  );
}

function RadiusPage() {
  return (
    <div className="space-y-10">
      <Section
        eyebrow="Finding"
        title="The app needs shape grammar, not one universal radius"
        description="Pills are a real Volli strength, but they currently act as a primitive default while tabs, rail modes, close buttons, inputs, menus, cards, and project tiles override their way toward different identities. A radius toggle would only move the inconsistency."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <ShapeCard
            shape="pill"
            title="Pill"
            rule="Acts or labels"
            uses="Primary actions, filters, badges, switches, compact selectors"
          />
          <ShapeCard
            shape="squircle"
            title="Squircle"
            rule="Navigates or edits"
            uses="Inputs, menu rows, tabs, icon-mode rails, project tiles"
          />
          <ShapeCard
            shape="shell"
            title="Shell"
            rule="Contains a region"
            uses="Cards, panels, popovers, dialogs, app inset"
          />
        </div>
      </Section>

      <Section
        eyebrow="Current map"
        title="Current classes reveal good instincts and unnamed exceptions"
      >
        <div className="grid gap-3 md:grid-cols-2">
          {[
            [
              "Button",
              "rounded-full",
              "Correct for actions; over-broad as a base identity.",
              "ui/button.tsx:8",
            ],
            [
              "Input / Select",
              "rounded-md",
              "Correct field family, but its height rhythm differs.",
              "ui/input.tsx:11 · ui/select.tsx:34",
            ],
            [
              "Menu item",
              "rounded-sm",
              "Good parent-minus-inset relationship.",
              "ui/select.tsx:103",
            ],
            [
              "Ticket card",
              "rounded-lg",
              "Entity card shares the same treatment as quiet settings groups.",
              "board/ticket-card.tsx:59",
            ],
            [
              "Project tile",
              "rounded-[10px]",
              "Visually strong, but literal and outside the radius scale.",
              "rail/project-tile.tsx:68",
            ],
            [
              "App inset",
              "--radius-xl",
              "Excellent shell-level role and paired-corner logic.",
              "globals.css:622-663",
            ],
          ].map(([component, token, judgment, source]) => (
            <div key={component} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-ui font-semibold text-foreground">{component}</p>
                <code className="rounded-md bg-background px-2 py-1 font-mono text-label text-primary-text">
                  {token}
                </code>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{judgment}</p>
              <Evidence>{source}</Evidence>
            </div>
          ))}
        </div>
      </Section>

      <Section
        eyebrow="Relationship rule"
        title="Inner radius follows the container it lives inside"
      >
        <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)]">
          <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="text-sm font-semibold text-foreground">
                Settings section · shell radius
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                A grouped region uses 14px; its inset row selection uses 8px; its inline chip uses a
                pill.
              </p>
            </div>
            <span className="rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground">
              Inherited
            </span>
          </div>
          <div className="mt-4 rounded-lg bg-secondary p-3">
            <div className="flex items-center justify-between gap-3 rounded-md bg-accent px-3 py-2">
              <span className="text-xs font-medium text-foreground">Appearance</span>
              <span className="rounded-full bg-background px-2 py-0.5 text-label text-muted-foreground">
                System
              </span>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-primary/30 bg-primary/8 p-4 text-xs leading-5 text-muted-foreground">
          <strong className="text-foreground">Recommended tokens:</strong>{" "}
          <code className="font-mono text-primary-text">radius-action: 9999px</code>,{" "}
          <code className="font-mono text-primary-text">radius-control: 8px</code>,{" "}
          <code className="font-mono text-primary-text">radius-surface: 12px</code>,{" "}
          <code className="font-mono text-primary-text">radius-shell: 14px</code>. Preserve
          parent-minus-inset relationships instead of letting each component choose a Tailwind step.
        </div>
      </Section>
    </div>
  );
}

function ShapeCard({
  shape,
  title: cardTitle,
  rule,
  uses,
}: {
  shape: "pill" | "squircle" | "shell";
  title: string;
  rule: string;
  uses: string;
}) {
  return (
    <article className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-raised)]">
      <div
        className={cn(
          "flex h-20 items-center justify-center border border-primary/35 bg-primary/10",
          shape === "pill" && "rounded-full",
          shape === "squircle" && "rounded-lg",
          shape === "shell" && "rounded-xl",
        )}
      >
        <span className="text-ui font-semibold text-primary-text">{cardTitle}</span>
      </div>
      <p className="mt-3 text-sm font-semibold text-foreground">{rule}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{uses}</p>
    </article>
  );
}

function ComponentsPage() {
  const ticket = ticketById("tkt-14");
  return (
    <div className="space-y-10">
      <Section
        eyebrow="Visual evidence"
        title="Two beautiful components can still compete for the same depth"
        description="The real TicketCard and a faithful SettingsSection treatment use nearly identical border, radius, and fill. One is an actionable entity; the other is passive grouping. The system should make that distinction before hover."
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-ui font-semibold text-foreground">Actionable entity</p>
            <div className="w-72 max-w-full">
              <TicketCardContent ticket={ticket} ticketPrefix={project.ticketPrefix} />
            </div>
            <Evidence>rounded-lg · border · bg-card · px-3 py-2.5</Evidence>
          </div>
          <div className="space-y-2">
            <p className="text-ui font-semibold text-foreground">Passive grouping</p>
            <div className="rounded-lg border border-border bg-card/50 p-5">
              <p className="text-sm font-semibold text-foreground">App theme</p>
              <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-4">
                <span className="text-sm font-medium text-foreground">Appearance</span>
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-foreground">
                  System
                </span>
              </div>
            </div>
            <Evidence>rounded-lg · border · bg-card/50 · p-5</Evidence>
          </div>
        </div>
      </Section>

      <Section eyebrow="Audit table" title="Before / after decisions, ordered by leverage">
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[900px] border-collapse text-left text-xs">
            <thead className="bg-secondary/70 font-mono text-label uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5">Severity</th>
                <th className="px-3 py-2.5">Before</th>
                <th className="px-3 py-2.5">After</th>
                <th className="px-3 py-2.5">Why</th>
              </tr>
            </thead>
            <tbody>
              {AUDIT_ROWS.map((row) => (
                <tr key={row.before} className="border-t border-border align-top">
                  <td className="px-3 py-3">
                    <Severity value={row.severity} />
                  </td>
                  <td className="max-w-64 px-3 py-3 leading-5 text-foreground">
                    <p>{row.before}</p>
                    <Evidence>{row.source}</Evidence>
                  </td>
                  <td className="max-w-64 px-3 py-3 leading-5 text-foreground">{row.after}</td>
                  <td className="max-w-56 px-3 py-3 leading-5 text-muted-foreground">{row.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section eyebrow="Unification seams" title="Start where one primitive fixes many features">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <PolicyCard
            title="Surface"
            value="Surface / Elevated"
            copy="Dialog, popover, dropdown, select, card, composer."
          />
          <PolicyCard
            title="Size"
            value="DensityProvider"
            copy="Button, input, select, rows, tabs, menus, rails."
          />
          <PolicyCard
            title="Shape"
            value="Role variants"
            copy="Action, control, navigation, entity, container."
          />
          <PolicyCard
            title="Motion"
            value="Interaction presets"
            copy="Press, overlay, structural, gesture, instant."
          />
        </div>
      </Section>
    </div>
  );
}

function Severity({ value }: { value: "High" | "Medium" | "Low" }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 font-mono text-label",
        value === "High" && "bg-destructive/12 text-destructive",
        value === "Medium" && "bg-primary/15 text-primary-text",
        value === "Low" && "bg-secondary text-muted-foreground",
      )}
    >
      {value}
    </span>
  );
}

function MotionPage({
  state,
  onStateChange,
}: {
  state: OperationState;
  onStateChange(value: OperationState): void;
}) {
  return (
    <div className="space-y-10">
      <Section
        eyebrow="Motion posture"
        title="Crisp productivity motion, physical only where the user is physical"
        description="Volli already has unusually good press feedback, strong drag sorting, origin-aware overlays, and reduced-motion handling. The opportunity is consolidation and frequency discipline—not adding animation everywhere."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["Instant", "0ms", "Keyboard palette, tab focus, repeated navigation"],
            ["Press", "100–160ms", "Pointer-down feedback and tiny state response"],
            ["Overlay", "150–250ms", "Popover, select, menu, dialog"],
            ["Structural", "180–250ms", "Sidebar and rail geometry"],
            ["Gesture", "Spring", "Drag, sheet, reorder, momentum"],
          ].map(([name, value, use]) => (
            <div key={name} className="rounded-xl border border-border bg-card p-3">
              <p className="font-mono text-label uppercase text-muted-foreground">{name}</p>
              <p className="mt-2 text-sm font-semibold text-foreground">{value}</p>
              <p className="mt-1 text-label leading-4 text-muted-foreground">{use}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        eyebrow="State gallery"
        title="Async components need explicit rest, pending, success, and recoverable failure"
        description="This gallery is deliberately manual: it makes missing affordance combinations visible before implementation. Only the affected action is blocked; the surrounding context remains available."
      >
        <Segmented
          label="Operation state"
          value={state}
          options={[
            { value: "rest", label: "Rest" },
            { value: "pending", label: "Pending" },
            { value: "success", label: "Success" },
            { value: "failure", label: "Failure" },
          ]}
          onChange={onStateChange}
        />
        <OperationCard state={state} onStateChange={onStateChange} />
      </Section>

      <Section eyebrow="Vetted direction" title="Corrective work before additive motion">
        <div className="grid gap-3 md:grid-cols-2">
          <SystemCard
            tone="keep"
            title="Keep"
            items={[
              "Button active scale 0.97 with reduced-motion fallback",
              "Popover transform origins supplied by Radix",
              "180ms board sort curve and reduced-motion gate",
              "Shell instant escape hatch during terminal geometry changes",
            ]}
          />
          <SystemCard
            tone="adopt"
            title="Tighten"
            items={[
              "Replace the streaming pulse + repainting shimmer with one reduced-motion-safe cue",
              "Split the 400ms layout disclosure into a faster, measured high-frequency preset",
              "Make AlertDialog, Select, swatch hover, and every overlay honor the same accessibility contract",
              "Name shared duration/easing presets instead of local combinations",
            ]}
          />
        </div>
        <div className="rounded-xl border border-border bg-background p-4 text-xs leading-5 text-muted-foreground">
          <strong className="text-foreground">Missed opportunities:</strong> animate only spatially
          meaningful, occasional transitions—the right-rail mode content swap, recoverable
          completion feedback, and rare first-session success. Do not animate keyboard-open command
          palette or routine tab selection.
        </div>
      </Section>
    </div>
  );
}

function OperationCard({
  state,
  onStateChange,
}: {
  state: OperationState;
  onStateChange(value: OperationState): void;
}) {
  const content = {
    rest: {
      title: "Ready to create worktree",
      detail: "The ticket and branch plan are unchanged.",
      action: "Create",
      tone: "border-border",
    },
    pending: {
      title: "Creating worktree…",
      detail: "Ticket editing and navigation remain available.",
      action: "Working",
      tone: "border-primary/35",
    },
    success: {
      title: "Worktree ready",
      detail: "Branch volli/VLT-14-inline-diff-gutter is available.",
      action: "Open",
      tone: "border-primary/50",
    },
    failure: {
      title: "Worktree wasn’t created",
      detail: "The ticket is safe. Check the branch conflict and try again.",
      action: "Retry",
      tone: "border-destructive/40",
    },
  }[state];
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4 shadow-[var(--shadow-raised)] transition-[border-color,background-color] duration-200 ease-out",
        content.tone,
      )}
    >
      <div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 rounded-full",
              state === "pending" && "animate-pulse bg-primary motion-reduce:animate-none",
              state === "success" && "bg-primary",
              state === "failure" && "bg-destructive",
              state === "rest" && "bg-muted-foreground/50",
            )}
          />
          <p className="text-sm font-semibold text-foreground">{content.title}</p>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{content.detail}</p>
      </div>
      <Button
        type="button"
        disabled={state === "pending"}
        variant={state === "failure" ? "destructive" : "default"}
        onClick={() =>
          onStateChange(state === "failure" ? "pending" : state === "success" ? "rest" : "pending")
        }
      >
        {content.action}
      </Button>
    </div>
  );
}

function RoadmapPage() {
  const phases = [
    {
      phase: "0",
      title: "Protect the current strengths",
      scope:
        "Characterization tests for generated colors, shell seam, public primitive classes, reduced motion, and current screenshot baselines.",
      proof: "No visual regression before the system changes.",
    },
    {
      phase: "1",
      title: "Introduce contexts and tokens",
      scope:
        "Surface substrate + Elevated primitive; DensityProvider + uiDensity persistence; role-based radius and motion tokens.",
      proof: "A nested overlay and a mixed control row pass public-seam tests.",
    },
    {
      phase: "2",
      title: "Unify primitives",
      scope:
        "Button, Input, Select, Dropdown, Popover, Dialog, Badge, Switch, tabs, and menu rows consume the new contexts.",
      proof: "Normal and compact galleries stay semantically identical.",
    },
    {
      phase: "3",
      title: "Migrate high-leverage regions",
      scope:
        "Board/list, ticket rail/workbench, Settings, chat composer/activity, and session chrome—in that order.",
      proof: "Wide, 13-inch-like, light, dark, and long-content screenshots.",
    },
    {
      phase: "4",
      title: "Motion and performance pass",
      scope:
        "Remove layout-property animation, consolidate presets, add only selected spatial transitions, and measure under transcript load.",
      proof: "Reduced-motion and frame-budget checks on real app surfaces.",
    },
  ] as const;
  return (
    <div className="space-y-10">
      <Section
        eyebrow="Migration"
        title="A preservation-first sequence, not a reskin"
        description="Each phase is independently useful and reviewable. Production theming, runtime semantics, IA, and terminal ownership remain untouched unless a later slice explicitly needs them."
      >
        <div className="space-y-3">
          {phases.map((phase) => (
            <article
              key={phase.phase}
              className="grid gap-3 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-raised)] md:grid-cols-[3rem_12rem_1fr]"
            >
              <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 font-mono text-xs text-primary-text">
                {phase.phase}
              </span>
              <h3 className="text-sm font-semibold text-foreground">{phase.title}</h3>
              <div>
                <p className="text-xs leading-5 text-muted-foreground">{phase.scope}</p>
                <p className="mt-2 text-label leading-4 text-foreground">
                  <strong>Proof:</strong> {phase.proof}
                </p>
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section eyebrow="Discrete work packages" title="The first implementation should stay narrow">
        <div className="grid gap-3 md:grid-cols-2">
          {[
            [
              "DS-1 · Density contract",
              "Add preference, provider, token maps, and a primitive gallery. No feature migration.",
            ],
            [
              "DS-2 · Contextual elevation",
              "Add substrate context and migrate Popover + Dialog as the proof pair.",
            ],
            [
              "DS-3 · Control family",
              "Unify Button, Input, Select, menu rows, icons, and radius roles.",
            ],
            [
              "DS-4 · Board + ticket rail",
              "First product migration at normal/compact and 940/1280 widths.",
            ],
            [
              "DS-5 · Settings + chat",
              "Remove redundant framing/copy and apply async state gallery rules.",
            ],
            [
              "DS-6 · Motion corrections",
              "Execute only vetted high-leverage motion plans after feel checks.",
            ],
          ].map(([name, copy]) => (
            <div key={name} className="rounded-xl border border-border bg-background p-4">
              <p className="text-ui font-semibold text-foreground">{name}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section eyebrow="Boundaries" title="What this proposal intentionally does not change">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              "Theme canvas authoring or generated color ownership",
              "Ticket / Session information architecture",
              "Mona Sans, Geist Mono, or ember identity",
              "Terminal mounting, scaling, or editor-specific zoom",
              "Automatic density changes based on window width",
              "Decorative motion on frequent keyboard interactions",
            ].map((item) => (
              <div key={item} className="flex gap-2 text-xs leading-5 text-muted-foreground">
                <span
                  aria-hidden
                  className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
                />
                {item}
              </div>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}

export default function DesignSystemAuditScratch() {
  const [page, setPage] = React.useState<PageId>("thesis");
  const [density, setDensity] = React.useState<Density>("compact");
  const [operationState, setOperationState] = React.useState<OperationState>("rest");

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background shadow-[var(--shadow-card)]">
      <header className="border-b border-border bg-card/80 px-5 py-5 backdrop-blur-xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <Eyebrow>Volli interface system · audit 01</Eyebrow>
            <h1 className="mt-2 text-title font-semibold tracking-tight text-foreground">
              Cohesion through context
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              A critical codebase audit and an interactive proposal for relative surfaces,
              region-owned density, semantic shape, and restrained physical motion.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 shadow-[var(--shadow-raised)]">
            <span className="size-2 rounded-full bg-primary" />
            <span className="font-mono text-label uppercase text-muted-foreground">
              Lab proposal · production untouched
            </span>
          </div>
        </div>
        <nav
          aria-label="Design system audit pages"
          className="mt-5 flex gap-1 overflow-x-auto pb-1"
        >
          {PAGES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => setPage(item.id)}
              className="shrink-0 rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none hover:text-foreground aria-[current=page]:bg-foreground aria-[current=page]:text-background"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="p-5 sm:p-7">
        {page === "thesis" ? <ThesisPage /> : null}
        {page === "surfaces" ? <SurfacesPage /> : null}
        {page === "sizes" ? <SizesPage density={density} onDensityChange={setDensity} /> : null}
        {page === "radius" ? <RadiusPage /> : null}
        {page === "components" ? <ComponentsPage /> : null}
        {page === "motion" ? (
          <MotionPage state={operationState} onStateChange={setOperationState} />
        ) : null}
        {page === "roadmap" ? <RoadmapPage /> : null}
      </main>
    </div>
  );
}
