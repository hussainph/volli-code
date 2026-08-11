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
 * depth and coherent size contracts), not its product styling wholesale.
 * Volli keeps its generated canvas, ember accent, Mona/Geist typography, and
 * excellent shell seam. This scratch exists to make those strengths systemic.
 */
import * as React from "react";
import type { ReactNode } from "react";

import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
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
export const note = "Surfaces, density, radius, components, motion, and the next proof";
export const seed = seedBoard;
export const api = appApi;

const PAGES = [
  { id: "thesis", label: "System thesis" },
  { id: "surfaces", label: "Surfaces" },
  { id: "sizes", label: "Sizes" },
  { id: "radius", label: "Radius" },
  { id: "components", label: "Components" },
  { id: "motion", label: "Motion & states" },
  { id: "proof", label: "Next proof" },
] as const;

type PageId = (typeof PAGES)[number]["id"];
type Density = "normal" | "compact";
type SizeContract = "roomy" | "compact-first";
type OperationState = "rest" | "pending" | "success" | "failure";

const SURFACE_ROLES = [
  {
    role: "Base",
    use: "Canvas, shell, workbench, and reading substrates",
    fill: "owned fill",
    shadow: "none",
  },
  {
    role: "Raised",
    use: "Cards, composers, active objects, and local inspectors",
    fill: "one relative lift",
    shadow: "raised",
  },
  {
    role: "Overlay",
    use: "Popover, dropdown, select, context menu, and hover card",
    fill: "one relative lift, clamped",
    shadow: "overlay · stable",
  },
  {
    role: "Blocking",
    use: "Dialog, alert dialog, command palette, and sheet",
    fill: "stable paper + scrim",
    shadow: "blocking · stable",
  },
] as const;

const AUDIT_ROWS = [
  {
    severity: "High",
    before: "Button defaults to 28px; Input and Select default to 36px",
    after: "Compare 36/28 and 28/24 on the real primitives before choosing a contract",
    why: "The Lab tests the fork instead of presenting one taste judgment as settled.",
    source:
      "apps/desktop/src/renderer/src/components/ui/button.tsx:32 · apps/desktop/src/renderer/src/components/ui/input.tsx:11 · apps/desktop/src/renderer/src/components/ui/select.tsx:34",
  },
  {
    severity: "High",
    before: "Popover, select, dropdown, and nested menus always use bg-popover",
    after: "Each overlay lifts one step from the substrate that opened it",
    why: "Nested overlays remain visible without caller-specific color props.",
    source:
      "apps/desktop/src/renderer/src/components/ui/popover.tsx:33 · apps/desktop/src/renderer/src/components/ui/select.tsx:59 · apps/desktop/src/renderer/src/components/ui/dropdown-menu.tsx:37",
  },
  {
    severity: "High",
    before: "CSS zoom is the only app-wide answer to a small screen",
    after: "Density changes rhythm; zoom remains a separate accessibility tool",
    why: "Compact mode preserves crisp type and known hit areas.",
    source:
      "apps/desktop/src/renderer/src/stores/ui.ts:89 · apps/desktop/src/renderer/src/components/app-shell.tsx:133",
  },
  {
    severity: "Medium",
    before:
      "Overlay classes advertise shadow-md/lg, while global CSS overrides most—but not Select or Hover Card",
    after: "Relative fill changes with substrate; role-sized shadow stays stable through nesting",
    why: "Depth cues do not compound, and a popover remains recognizably a popover at every depth.",
    source:
      "apps/desktop/src/renderer/src/globals.css:774 · apps/desktop/src/renderer/src/components/ui/select.tsx:59 · apps/desktop/src/renderer/src/components/ui/hover-card.tsx:27",
  },
  {
    severity: "Medium",
    before: "Pill Button is repeatedly overridden to rounded-md in chrome",
    after: "Shape follows role: pill action, squircle navigation, shell container",
    why: "Exceptions become named semantics instead of local class patches.",
    source:
      "apps/desktop/src/renderer/src/components/ui/button.tsx:8 · apps/desktop/src/renderer/src/components/ticket/ticket-rail.tsx:78",
  },
  {
    severity: "Medium",
    before: "SettingsSection and TicketCard are both rounded-lg bordered cards",
    after: "Sections recede; actionable entities lift and react",
    why: "Hierarchy comes from surface behavior, not more framing.",
    source:
      "apps/desktop/src/renderer/src/components/pages/settings-shell.tsx:124 · apps/desktop/src/renderer/src/components/board/ticket-card.tsx:59",
  },
  {
    severity: "Medium",
    before: "Lucide leaks through three shared primitives: Command, Select, and Spinner",
    after: "Phosphor owns product controls; vendor icons stay inside vendor surfaces",
    why: "Stroke, silhouette, and optical weight stop shifting between neighbors.",
    source:
      "apps/desktop/src/renderer/src/components/ui/command.tsx:3 · apps/desktop/src/renderer/src/components/ui/select.tsx:4 · apps/desktop/src/renderer/src/components/ui/spinner.tsx:1",
  },
  {
    severity: "High",
    before:
      "Streaming reasoning stacks pulse and a repainting 1.6s shimmer with no reduced-motion branch",
    after: "One quiet working-state cue with a non-moving reduced-motion equivalent",
    why: "The primary chat surface stops spending motion and paint on duplicate status signals.",
    source:
      "apps/desktop/src/components/ai-elements/reasoning.tsx:76 · apps/desktop/src/components/ai-elements/shimmer.tsx:42",
  },
  {
    severity: "High",
    before: "Chat disclosure animates grid rows for 400ms inside a busy transcript",
    after:
      "Instant body disclosure; consider opacity only if a real feel-check proves it necessary",
    why: "Repeated inspection does not earn paced layout motion, and grid-template-rows is not compositor-safe.",
    source:
      "apps/desktop/src/renderer/src/components/chat/activity-ui.tsx:61 · apps/desktop/src/renderer/src/components/chat/activity-ui.tsx:165",
  },
  {
    severity: "High",
    before:
      "Equivalent overlays disagree on reduced motion: Dialog opts out; AlertDialog and Select do not",
    after: "One overlay accessibility contract preserves a short fade and removes movement",
    why: "Reduced motion is predictable across every path into an overlay.",
    source:
      "apps/desktop/src/renderer/src/components/ui/dialog.tsx:25 · apps/desktop/src/renderer/src/components/ui/alert-dialog.tsx:24 · apps/desktop/src/renderer/src/components/ui/select.tsx:48",
  },
  {
    severity: "Medium",
    before:
      "Files retains stale content under failure; Change Set replaces it with error-only content",
    after: "One async frame contract: rest, pending, stale refresh, success, recoverable failure",
    why: "Failures preserve context and recovery behaves consistently.",
    source:
      "apps/desktop/src/renderer/src/components/ticket/ticket-files-panel.tsx:164 · apps/desktop/src/renderer/src/components/ticket/ticket-changes-panel.tsx:38",
  },
  {
    severity: "Low",
    before: "Motion values mix ease-out, ease-swift, 100/120/150/180/200/240/300/400ms",
    after: "Frequency-based presets: instant, press, overlay, structural, gesture",
    why: "Motion gets a product voice without animating high-frequency work.",
    source:
      "apps/desktop/src/renderer/src/globals.css:254 · apps/desktop/src/renderer/src/components/chat/activity-ui.tsx:63",
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
            value="4"
            label="Surface roles proposed"
            detail="Base, raised, overlay, and blocking—with a fill clamp."
          />
          <Metric
            value="2×2"
            label="Size fork to test"
            detail="36/28 and 28/24, shown on the same real primitives."
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
              "CSS-first global density contract",
              "Role-based radius taxonomy",
              "Control metrics that scale without owning content type",
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
              "Density is global first",
              "CSS variables carry the preference; regional overrides wait for evidence.",
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
            <Evidence>
              apps/desktop/src/renderer/src/globals.css:34 ·
              apps/desktop/src/renderer/src/globals.css:540
            </Evidence>
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
        <Evidence>
          apps/desktop/src/renderer/src/components/board/board-column.tsx:58 ·
          apps/desktop/src/renderer/src/components/board/ticket-card.tsx:57
        </Evidence>
      </Section>

      <Section
        eyebrow="Proposed model"
        title="Four roles, relative fills, stable shadows, and a clamp"
        description="Feature code asks for a semantic role. The surface resolves its fill relative to the nearest substrate, stops lifting when the appearance reaches its useful ceiling, and keeps the role's shadow stable through nesting. Numeric levels are diagnostic output, never component API."
      >
        <div className="overflow-hidden rounded-xl border border-border bg-background">
          <div className="grid grid-cols-[7rem_1fr_10rem_9rem] gap-3 border-b border-border px-3 py-2 font-mono text-label uppercase text-muted-foreground max-md:grid-cols-[6rem_1fr_8rem]">
            <span>Role</span>
            <span>Use</span>
            <span>Fill</span>
            <span className="max-md:hidden">Shadow</span>
          </div>
          {SURFACE_ROLES.map((surface) => (
            <div
              key={surface.role}
              className="grid grid-cols-[7rem_1fr_10rem_9rem] items-center gap-3 border-b border-border/60 px-3 py-2.5 text-xs last:border-b-0 max-md:grid-cols-[6rem_1fr_8rem]"
            >
              <span className="font-medium text-foreground">{surface.role}</span>
              <span className="text-muted-foreground">{surface.use}</span>
              <span className="font-mono text-label text-muted-foreground">{surface.fill}</span>
              <span className="font-mono text-label text-muted-foreground max-md:hidden">
                {surface.shadow}
              </span>
            </div>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <PolicyCard
            title="Light appearance"
            value="Lift once, then clamp"
            copy="A warm base and one stable paper fill prevent washout; contact edge, ambient shadow, and scrim carry the remaining elevation."
          />
          <PolicyCard
            title="Dark appearance"
            value="Fill can keep lifting"
            copy="Low-opacity light layers help where shadows disappear, but the ladder still clamps before nested overlays begin to glow."
          />
        </div>
      </Section>

      <Section
        eyebrow="Mechanic diagram"
        title="The same overlay must lift from where it opens"
        description="This diagram explains the relationship; it is not implementation proof. The real dropdown sub-menu experiment on Next proof is the acceptance test."
      >
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
          <p className="text-ui font-medium text-foreground">Raised task panel</p>
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
          : "The picker advances its fill; its overlay shadow does not grow with nesting."}
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
  return (
    <div className="space-y-10">
      <Section
        eyebrow="Decision control"
        title="Compare both size contracts at the same density"
        description="Normal and compact remain user-facing modes, but their actual measurements are unresolved. The switch below changes both candidate families together so content and state stay identical while the geometry changes."
      >
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-raised)]">
          <div>
            <p className="text-sm font-semibold text-foreground">Interface density</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Compare the two candidates here, then judge them in the real App Shell.
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
        <div className="grid gap-4 xl:grid-cols-2">
          <SizeContractCard contract="roomy" density={density} />
          <SizeContractCard contract="compact-first" density={density} />
        </div>
      </Section>

      <Section
        eyebrow="Current evidence"
        title="Today’s default row visibly mixes two size systems"
        description="These are the real primitives. The Button is 28px; Input and Select are 36px; the Switch is 16px tall. Each is internally polished, but the row has no shared rhythm."
      >
        <div className="rounded-xl border border-border bg-card p-4">
          <RealControlRow label="Current" />
          <Evidence>Button h-7 · Input h-9 · Select h-9 · Switch h-4</Evidence>
        </div>
      </Section>

      <Section
        eyebrow="Typography boundary"
        title="Density may tune UI type; it does not own typography"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <PolicyCard
            title="Content type"
            value="Fixed"
            copy="Transcript prose, editor text, ticket bodies, and the six-step hierarchy do not shrink with density."
          />
          <PolicyCard
            title="UI chrome"
            value="13px, optionally 12px"
            copy="Compact labels may step down only when the real-component comparison stays legible."
          />
          <PolicyCard
            title="Constraint"
            value="No global font scale"
            copy="Typography remains independently tunable instead of becoming a side effect of compact mode."
          />
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
            copy="Changes control, row, icon, padding, and gap tokens. UI type remains an optional optical adjustment."
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
          <strong className="text-foreground">CSS-first seam:</strong> persist{" "}
          <code className="font-mono text-primary-text">uiDensity</code>, stamp{" "}
          <code className="font-mono text-primary-text">data-density</code> on{" "}
          <code className="font-mono text-primary-text">html</code>, and let ordinary components
          consume inherited variables. A small JavaScript bridge owns persistence and the first
          frame. React context waits until a real per-region or portal-boundary requirement exists.
        </div>
      </Section>

      <Section
        eyebrow="Separate claim"
        title="Chrome geometry recovers width; control density changes rhythm"
        description="The earlier ~100px recovery came from rails and insets. It does not validate either control-height contract. Judge geometry independently in the App Shell, especially at the 940px minimum."
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
          These remain candidate layout defaults, not density-system proof. Store independent resize
          preferences if they are eventually coupled to a user mode, and never let a toggle
          overwrite a manually chosen rail width.
        </p>
        <Button asChild>
          <a href="#app-shell">Open the real App Shell comparison</a>
        </Button>
      </Section>
    </div>
  );
}

function metricsFor(contract: SizeContract, density: Density) {
  if (contract === "roomy") {
    return density === "normal"
      ? { control: 36, text: 13, icon: 16, px: 12, gap: 8 }
      : { control: 28, text: 12, icon: 14, px: 10, gap: 4 };
  }
  return density === "normal"
    ? { control: 28, text: 13, icon: 14, px: 10, gap: 6 }
    : { control: 24, text: 12, icon: 12, px: 8, gap: 4 };
}

function SizeContractCard({ contract, density }: { contract: SizeContract; density: Density }) {
  const metrics = metricsFor(contract, density);
  const label = contract === "roomy" ? "36 normal / 28 compact" : "28 normal / 24 compact";
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-raised)]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">{label}</p>
          <p className="mt-1 text-xs text-muted-foreground">Showing {density}</p>
        </div>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-label text-muted-foreground">
          {metrics.control}px
        </span>
      </div>
      <RealControlRow label={label} metrics={metrics} />
      <Evidence>
        Real Input · Select · Button · Switch · control {metrics.control} · UI type {metrics.text} ·
        icon {metrics.icon} · gap {metrics.gap}
      </Evidence>
    </div>
  );
}

type ControlMetrics = ReturnType<typeof metricsFor>;

function RealControlRow({ label, metrics }: { label: string; metrics?: ControlMetrics }) {
  const controlStyle = metrics
    ? ({
        height: metrics.control,
        minHeight: metrics.control,
        fontSize: metrics.text,
        paddingInline: metrics.px,
        gap: metrics.gap,
      } satisfies React.CSSProperties)
    : undefined;
  const rowStyle = metrics
    ? ({
        gap: metrics.gap,
        "--lab-example-icon": `${metrics.icon}px`,
      } as React.CSSProperties)
    : undefined;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        metrics && "[&_svg]:size-(--lab-example-icon)",
      )}
      style={rowStyle}
    >
      <Input
        aria-label={`${label} search`}
        className="min-w-40 flex-1"
        placeholder="Search…"
        style={controlStyle}
      />
      <Select defaultValue="updated">
        <SelectTrigger aria-label={`${label} sort`} style={controlStyle}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updated">Last updated</SelectItem>
          <SelectItem value="created">Created</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" style={controlStyle}>
        Filter
      </Button>
      <Button style={controlStyle}>New</Button>
      <label
        className="ml-1 flex items-center gap-2 text-ui text-muted-foreground"
        style={metrics ? { minHeight: metrics.control, fontSize: metrics.text } : undefined}
      >
        <Switch defaultChecked /> Live
      </label>
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
              "apps/desktop/src/renderer/src/components/ui/button.tsx:8",
            ],
            [
              "Input / Select",
              "rounded-md",
              "Correct field family, but its height rhythm differs.",
              "apps/desktop/src/renderer/src/components/ui/input.tsx:11 · apps/desktop/src/renderer/src/components/ui/select.tsx:34",
            ],
            [
              "Menu item",
              "rounded-sm",
              "Good parent-minus-inset relationship.",
              "apps/desktop/src/renderer/src/components/ui/select.tsx:103",
            ],
            [
              "Ticket card",
              "rounded-lg",
              "Entity card shares the same treatment as quiet settings groups.",
              "apps/desktop/src/renderer/src/components/board/ticket-card.tsx:59",
            ],
            [
              "Project tile",
              "rounded-[10px]",
              "Visually strong, but literal and outside the radius scale.",
              "apps/desktop/src/renderer/src/components/rail/project-tile.tsx:68",
            ],
            [
              "App inset",
              "--radius-xl",
              "Excellent shell-level role and paired-corner logic.",
              "apps/desktop/src/renderer/src/globals.css:622",
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
            value="Four roles + clamp"
            copy="Base, raised, overlay, and blocking; relative fill and stable role shadow."
          />
          <PolicyCard
            title="Size"
            value="data-density + variables"
            copy="A global CSS contract first; JavaScript only persists and stamps the preference."
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
            ["Instant", "0ms", "Keyboard palette, tab focus, repeated disclosure/navigation"],
            ["Press", "100–160ms", "Pointer-down feedback and tiny state response"],
            ["Overlay", "150–250ms", "Popover, select, menu, dialog"],
            ["Structural", "Measured", "Occasional geometry only; instant on busy terminal paths"],
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
              "Remove the 400ms grid-row disclosure; mount repeated tool detail instantly",
              "Test opacity-only disclosure only if the instant version is genuinely disorienting",
              "Make AlertDialog, Select, swatch hover, and every overlay honor the same accessibility contract",
              "Name shared duration/easing presets instead of local combinations",
            ]}
          />
        </div>
        <div className="rounded-xl border border-border bg-background p-4 text-xs leading-5 text-muted-foreground">
          <strong className="text-foreground">Addition gate:</strong> no new motion is approved by
          this audit. First remove repeated layout motion and redundant streaming cues. Only then
          feel-check occasional, spatially meaningful transitions such as recoverable completion or
          rare first-session success.
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

const LabSurfaceDepthContext = React.createContext(0);

function CandidateDropdownContent({ children }: { children: ReactNode }) {
  const substrate = React.useContext(LabSurfaceDepthContext);
  const depth = Math.min(substrate + 1, 2);
  return (
    <LabSurfaceDepthContext.Provider value={depth}>
      <DropdownMenuContent
        data-lab-surface-role="overlay"
        data-lab-surface-depth={depth}
        className="border-border-strong bg-popover shadow-[var(--shadow-overlay)]"
      >
        {children}
      </DropdownMenuContent>
    </LabSurfaceDepthContext.Provider>
  );
}

function CandidateDropdownSubContent({ children }: { children: ReactNode }) {
  const substrate = React.useContext(LabSurfaceDepthContext);
  const depth = Math.min(substrate + 1, 2);
  return (
    <LabSurfaceDepthContext.Provider value={depth}>
      <DropdownMenuSubContent
        data-lab-surface-role="overlay"
        data-lab-surface-depth={depth}
        className="border-border-strong bg-popover shadow-[var(--shadow-overlay)] dark:bg-[color-mix(in_oklab,var(--popover)_88%,white)]"
      >
        {children}
      </DropdownMenuSubContent>
    </LabSurfaceDepthContext.Provider>
  );
}

function SurfaceProofMenu({ candidate = false }: { candidate?: boolean }) {
  const rootItems = (
    <>
      <DropdownMenuItem>Open in workbench</DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
        {candidate ? (
          <CandidateDropdownSubContent>
            <DropdownMenuItem>Todo</DropdownMenuItem>
            <DropdownMenuItem>Doing</DropdownMenuItem>
            <DropdownMenuItem>Needs Review</DropdownMenuItem>
          </CandidateDropdownSubContent>
        ) : (
          <DropdownMenuSubContent>
            <DropdownMenuItem>Todo</DropdownMenuItem>
            <DropdownMenuItem>Doing</DropdownMenuItem>
            <DropdownMenuItem>Needs Review</DropdownMenuItem>
          </DropdownMenuSubContent>
        )}
      </DropdownMenuSub>
      <DropdownMenuItem>Copy link</DropdownMenuItem>
    </>
  );

  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <p className="text-ui font-semibold text-foreground">
        {candidate ? "Candidate · relative" : "Current · absolute"}
      </p>
      <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">
        {candidate
          ? "Root and sub-menu share the Overlay role. Dark fill advances before the clamp; light relies on edge and the same shadow."
          : "Root and sub-menu both hard-code bg-popover, so their effective fill cannot respond to nesting."}
      </p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="mt-3" variant={candidate ? "default" : "outline"}>
            Open {candidate ? "candidate" : "current"} menu
          </Button>
        </DropdownMenuTrigger>
        {candidate ? (
          <CandidateDropdownContent>{rootItems}</CandidateDropdownContent>
        ) : (
          <DropdownMenuContent>{rootItems}</DropdownMenuContent>
        )}
      </DropdownMenu>
      <Evidence>Open the menu, then point at “Move to” to inspect the nested surface.</Evidence>
    </div>
  );
}

function NextProofPage() {
  return (
    <div className="space-y-10">
      <Section
        eyebrow="One falsifiable proof"
        title="Apply a Surface primitive to dropdown sub-menus only"
        description="The first production slice should answer one question: can a real nested dropdown remain legibly separated from its substrate while keeping one stable overlay shadow? Dark fill may advance before its clamp; light fill may already be clamped and rely on edge plus shadow. If neither appearance reads, stop before building a general surface system."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <SurfaceProofMenu />
          <SurfaceProofMenu candidate />
        </div>
        <div className="rounded-xl border border-primary/35 bg-primary/8 p-5 shadow-[var(--shadow-raised)]">
          <div className="grid gap-4 md:grid-cols-[10rem_1fr]">
            <div>
              <p className="font-mono text-label uppercase text-primary-text">Surface proof 01</p>
              <p className="mt-2 text-sm font-semibold text-foreground">Dropdown → Sub-menu</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                [
                  "Scope",
                  "Surface/Substrate seam plus root and nested Dropdown content. No palette rewrite.",
                ],
                [
                  "Appearance",
                  "Dark fill changes before clamp; warm light may separate with edge and shadow alone.",
                ],
                ["Shadow", "One overlay recipe remains unchanged at root and nested depth."],
                [
                  "Stop rule",
                  "If the real collapse is not reproduced or fixed, retire the abstraction.",
                ],
              ].map(([label, copy]) => (
                <div key={label} className="rounded-lg border border-border bg-background p-3">
                  <p className="font-mono text-label uppercase text-muted-foreground">{label}</p>
                  <p className="mt-1 text-xs leading-5 text-foreground">{copy}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
        <Evidence>
          apps/desktop/src/renderer/src/components/ui/dropdown-menu.tsx:26 ·
          apps/desktop/src/renderer/src/components/ui/dropdown-menu.tsx:204
        </Evidence>
      </Section>

      <Section eyebrow="Open decisions" title="The Lab decides before architecture expands">
        <div className="overflow-hidden rounded-xl border border-border bg-background">
          {[
            [
              "Control height",
              "Open",
              "Compare 36/28 and 28/24 on real primitives and the App Shell.",
            ],
            ["Light elevation", "Direction", "Warm base, one fill lift, then shadow/edge/scrim."],
            ["Dark elevation", "Direction", "Relative fill lifting with an explicit clamp."],
            ["Density transport", "Direction", "Global html attribute and CSS variables first."],
            ["Typography", "Guardrail", "Content scale fixed; compact UI type remains optional."],
            ["Motion", "Correction", "Repeated tool disclosure becomes instant."],
          ].map(([decision, status, next]) => (
            <div
              key={decision}
              className="grid gap-2 border-b border-border/60 px-4 py-3 last:border-0 sm:grid-cols-[9rem_7rem_1fr] sm:items-center"
            >
              <p className="text-ui font-semibold text-foreground">{decision}</p>
              <span className="w-fit rounded-full bg-secondary px-2 py-0.5 font-mono text-label text-muted-foreground">
                {status}
              </span>
              <p className="text-xs leading-5 text-muted-foreground">{next}</p>
            </div>
          ))}
        </div>
        <Button asChild variant="outline">
          <a href="#app-shell">Judge the size fork in the App Shell</a>
        </Button>
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
              "Eight numeric surface levels as public component API",
              "A multi-phase migration plan before proof 01 passes",
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
              A critical codebase audit and an interactive proposal for relative surfaces, CSS-first
              density, semantic shape, and restrained physical motion.
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
        {page === "proof" ? <NextProofPage /> : null}
      </main>
    </div>
  );
}
