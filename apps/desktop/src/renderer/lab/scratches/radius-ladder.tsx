/**
 * The radius A/B rig — pick the app's new control/container ladder BY EYE.
 *
 * SYNTHESIS §5 [R] settled that 8/14/pill is too square and that the ladder
 * turns *up*: the app reads rounded because a rounded main view sits inside
 * rounded chrome, and the 16px composer is the liked datum. This renders the
 * candidate pairs on the real components so the choice is made on the actual
 * surfaces rather than on swatches.
 *
 * HOW A CANDIDATE IS APPLIED — and why it is not one variable.
 *
 * `globals.css` declares the rungs inside `@theme inline`, so Tailwind INLINES
 * their expressions into the utilities instead of referencing the token:
 *
 *   .rounded-sm  → calc(var(--radius) - 4px)
 *   .rounded-md  → calc(var(--radius) - 2px)
 *   .rounded-lg  → var(--radius)
 *   .rounded-xl  → calc(var(--radius) + 4px)     ← container, welded to control
 *   .rounded-2xl → var(--radius-2xl)             ← escapes the ladder entirely
 *
 * Setting `--radius` therefore moves four rungs at once and CANNOT move the
 * container rung independently — `rounded-xl` is permanently control+4, and
 * `rounded-2xl` (the composer, the interaction cards — the largest radius on
 * screen) reads Tailwind's stock 1rem and never hears about `--radius` at all.
 * Both are mirrored by hand below so the rig does not quietly show you a
 * container radius the pair never asked for. That mirroring is the finding as
 * much as it is the workaround: the container rung has to be registered in the
 * pipeline before any of these pairs can actually ship.
 *
 * ASSIGNMENT. Today's surfaces sit on rungs that disagree with their role — a
 * dialog on `rounded-lg` (control), a menu surface on `rounded-md` (control−2),
 * a text field on `rounded-md` too, so field and popover are the same shape.
 * "Proposed" puts each surface on the rung its role names (controls → control,
 * surfaces → container, rows inside a `p-1` surface → container − inset, which
 * is the parent-minus-inset relationship the decision asks to preserve).
 * "As shipped" applies only the numbers and leaves today's assignment alone.
 * `Current` carries no overrides in either mode — it is the reference.
 *
 * WHAT IS REAL: every composite is the app's own component with fixture data.
 * The one mock is the chrome corner, and even that is styled by the shipped
 * `[data-volli-shell="framed"]` rules in `globals.css` — the margins, hairlines
 * and seam radii are the app's, not a redrawing of them.
 *
 * DRIVE IT: keys 1–5 switch candidates, `c` toggles compare. In single mode the
 * pair is written onto `<html>` so the portalled menu and dialog inherit it too;
 * in compare mode each column carries its own.
 */
import * as React from "react";
import {
  ArchiveIcon,
  ArrowSquareOutIcon,
  CopyIcon,
  GitBranchIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";

import { TicketCardContent } from "@renderer/components/board/ticket-card";
import {
  SessionComposer,
  type ComposerModelSelection,
} from "@renderer/components/chat/composer-ui";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
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
import { Textarea } from "@renderer/components/ui/textarea";

import { project, ticketById } from "../fixtures";
import { appApi, seedBoard } from "../seed";

export const title = "Radius ladder · A/B";
export const note = "Candidate control/container pairs on the real composites — pick by eye";
export const viewport = "window" as const;

export const seed = seedBoard;
export const api = appApi;

interface Candidate {
  id: string;
  label: string;
  /** The control rung: text fields, non-pill buttons, small chips. */
  control: number;
  /** The container rung: menus, dialogs, cards, the composer, the framed card. */
  container: number;
  /** What the numbers mean on screen, in the rig's own words. */
  reading: string;
  /** `Current` applies nothing at all — it is what ships today. */
  shipped?: boolean;
}

const CANDIDATES: readonly Candidate[] = [
  {
    id: "current",
    label: "Current",
    control: 10,
    container: 14,
    reading: "10 control · 14 frame · 16 composer",
    shipped: true,
  },
  { id: "10-16", label: "10 / 16", control: 10, container: 16, reading: "composer stays 16" },
  { id: "12-18", label: "12 / 18", control: 12, container: 18, reading: "one notch up on both" },
  {
    id: "12-20",
    label: "12 / 20",
    control: 12,
    container: 20,
    reading: "wider parent-minus-inset",
  },
  { id: "16-28", label: "16 / 28", control: 16, container: 28, reading: "the doubled bracket" },
];

type Assignment = "proposed" | "shipped";

const ASSIGNMENTS = [
  { value: "proposed", label: "Proposed rungs" },
  { value: "shipped", label: "As shipped" },
] as const satisfies readonly { value: Assignment; label: string }[];

type Mode = "single" | "compare";

const MODES = [
  { value: "single", label: "Single" },
  { value: "compare", label: "Compare" },
] as const satisfies readonly { value: Mode; label: string }[];

/**
 * `--rig-*` are the pair; the `--radius*` writes exist so anything reading the
 * tokens directly (the shell seam in `globals.css` reads `--radius-xl`; the
 * `rounded-2xl` utility reads `--radius-2xl`) sees the same pair rather than a
 * stale one. `Current` gets none of them and every rule below falls back to
 * today's expression, which is why the reference costs no special-casing.
 */
function candidateVars(candidate: Candidate): React.CSSProperties | undefined {
  if (candidate.shipped) return undefined;
  return {
    "--rig-control": `${candidate.control}px`,
    "--rig-container": `${candidate.container}px`,
    "--radius": `${candidate.control}px`,
    "--radius-sm": `${candidate.control - 4}px`,
    "--radius-md": `${candidate.control - 2}px`,
    "--radius-lg": `${candidate.control}px`,
    "--radius-xl": `${candidate.container}px`,
    "--radius-2xl": `${candidate.container}px`,
  } as React.CSSProperties;
}

const CONTROL = "var(--rig-control, var(--radius))";
const CONTAINER = "var(--rig-container, calc(var(--radius) + 4px))";

const rigCss = `
  /* The two rungs the token pipeline cannot carry: rounded-xl is inlined as
     calc(var(--radius) + 4px), and rounded-2xl never touched the ladder at
     all. Both are re-pointed at the candidate's container here. */
  [data-radius-rig] .rounded-xl { border-radius: ${CONTAINER}; }
  [data-radius-rig] .rounded-2xl { border-radius: var(--rig-container, var(--radius-2xl)); }

  /* Proposed assignment: role decides the rung. */
  [data-rig-assign="proposed"] :is(
    [data-slot="input"],
    [data-slot="textarea"],
    [data-slot="select-trigger"]
  ) { border-radius: ${CONTROL}; }

  [data-rig-assign="proposed"] :is(
    [data-slot="dropdown-menu-content"],
    [data-slot="dropdown-menu-sub-content"],
    [data-slot="context-menu-content"],
    [data-slot="select-content"],
    [data-slot="popover-content"],
    [data-slot="dialog-content"],
    [data-slot="alert-dialog-content"]
  ) { border-radius: ${CONTAINER}; }

  /* Parent minus inset — every one of these surfaces is padded p-1 (4px). */
  [data-rig-assign="proposed"] :is(
    [data-slot="dropdown-menu-item"],
    [data-slot="dropdown-menu-label"],
    [data-slot="dropdown-menu-checkbox-item"],
    [data-slot="dropdown-menu-radio-item"],
    [data-slot="dropdown-menu-sub-trigger"],
    [data-slot="context-menu-item"],
    [data-slot="select-item"]
  ) { border-radius: calc(${CONTAINER} - 4px); }

  /* A board card is a surface, not a control — today it sits on rounded-lg. */
  [data-rig-assign="proposed"] [data-rig-tile] > article { border-radius: ${CONTAINER}; }

  /* The lab's own floating chrome is not under audit; hold it still so a
     screenshot never shows a candidate applied to the tool measuring it. */
  [data-radius-rig] [data-testid="lab-theme-toolbar"] { border-radius: 12px; }
`;

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <span className="mr-1 font-mono text-[10px] uppercase text-muted-foreground">{label}</span>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="rounded-[999px] px-2.5 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:bg-foreground aria-pressed:text-background"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A labelled frame around one composite. Its own corners are arbitrary values
 * on purpose: rig furniture that changed shape with the candidate would be one
 * more moving edge in every comparison.
 */
function Panel({
  label,
  width,
  children,
  className,
}: {
  label: string;
  width?: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      style={width === undefined ? undefined : { width }}
      className={`flex flex-col gap-3 rounded-[14px] border border-border/70 bg-background/60 p-4 ${className ?? ""}`}
    >
      <h2 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </h2>
      {children}
    </section>
  );
}

const SELECTION: ComposerModelSelection = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "high",
};

/** The liked datum. Real composer, fixture text, nothing stacked on it. */
function ComposerComposite() {
  const [value, setValue] = React.useState("Rework the ladder so the container rung is a token.");
  return (
    <SessionComposer
      value={value}
      onValueChange={setValue}
      models={[]}
      selection={SELECTION}
      onSelectionChange={() => undefined}
      working={false}
      ready
      queued={[]}
      onQueuedChange={() => undefined}
      onSteerQueued={() => undefined}
      onSubmit={() => undefined}
      onStop={() => undefined}
    />
  );
}

/**
 * Real Button at both rungs it could occupy. The pill row is what ships and
 * stays pill in every candidate; the squared row is the same 28px control
 * wearing the candidate's control radius, which is the only way to see whether
 * a turned-up ladder makes the pill look like a decision or an accident.
 */
function ButtonComposite({ compact = false }: { compact?: boolean }) {
  const squared = { borderRadius: CONTROL } as React.CSSProperties;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button>Start session</Button>
        <Button variant="outline">Cancel</Button>
        {compact ? null : <Button variant="secondary">Retry</Button>}
        <Button variant="ghost" size="icon" aria-label="Copy">
          <CopyIcon />
        </Button>
        <span className="font-mono text-[10px] text-muted-foreground">28 · pill</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button style={squared}>Start session</Button>
        <Button variant="outline" style={squared}>
          Cancel
        </Button>
        {compact ? null : (
          <Button variant="secondary" style={squared}>
            Retry
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label="Copy" style={squared}>
          <CopyIcon />
        </Button>
        <span className="font-mono text-[10px] text-muted-foreground">28 · control</span>
      </div>
    </div>
  );
}

function FieldComposite() {
  return (
    <div className="flex flex-col gap-2">
      <Input defaultValue="volli/VC-12-radius-ladder" aria-label="Branch" />
      <Input placeholder="Search sessions" aria-label="Search" />
      <Select defaultValue="sonnet">
        <SelectTrigger className="w-full" aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="sonnet">Sonnet 4.5</SelectItem>
          <SelectItem value="opus">Opus 4.1</SelectItem>
        </SelectContent>
      </Select>
      <Textarea
        defaultValue={"Ship the ladder as tokens.\nNo raw radius values in feature code."}
        aria-label="Notes"
      />
    </div>
  );
}

/**
 * Open on mount and never closable: `open` without `onOpenChange` makes Radix
 * ignore every dismissal, so a menu surface — the composite you otherwise only
 * see for as long as you hold a pointer still — stays in frame beside the
 * others and lands in the screenshot. `modal={false}` keeps it from locking the
 * page's scroll behind it.
 */
function MenuComposite() {
  return (
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Session actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-56">
        <DropdownMenuLabel>VC-12 · radius ladder</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <PencilSimpleIcon />
          Rename
          <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <GitBranchIcon />
          Open worktree
        </DropdownMenuItem>
        <DropdownMenuItem>
          <ArrowSquareOutIcon />
          Reveal in Finder
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <ArchiveIcon />
          Archive
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive">
          <TrashIcon />
          Delete session
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DialogComposite() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Open dialog
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive VC-12?</DialogTitle>
          <DialogDescription>
            The worktree is removed and the branch stays on origin.
          </DialogDescription>
        </DialogHeader>
        <Input defaultValue="volli/VC-12-radius-ladder" aria-label="Branch to keep" />
        <DialogFooter>
          <Button variant="ghost">Cancel</Button>
          <Button variant="destructive">Archive</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TileComposite({ compact = false }: { compact?: boolean }) {
  const first = ticketById("tkt-11");
  const second = ticketById("tkt-14");
  return (
    <div data-rig-tile className="flex flex-col gap-2">
      <TicketCardContent ticket={first} ticketPrefix={project.ticketPrefix} />
      {compact ? null : (
        <TicketCardContent ticket={second} ticketPrefix={project.ticketPrefix} selected />
      )}
    </div>
  );
}

/**
 * The nesting the whole decision rests on: a rounded main view inside rounded
 * chrome. The window corner is FIXED — macOS draws it and no candidate can move
 * it — so what the candidate changes is the inner card's corner measured
 * against a corner that never moves.
 *
 * Styled by `globals.css`'s own `[data-volli-shell="framed"]` rules rather than
 * by classes written here: the margins, the seam-facing borders, the shadow and
 * both seam radii are the shipped ones, so the mock cannot drift from the app
 * on the one relationship it exists to show.
 */
function ChromeCornerComposite({ height = 220 }: { height?: number }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border/80 shadow-[var(--shadow-overlay)]">
      <div className="flex h-10 items-center gap-2 px-3">
        <span className="size-3 rounded-[999px] bg-[#ff5f57]" />
        <span className="size-3 rounded-[999px] bg-[#febc2e]" />
        <span className="size-3 rounded-[999px] bg-[#28c840]" />
        <span className="ml-2 truncate text-[11px] text-muted-foreground">voltaic — VLT-14</span>
      </div>
      <div data-volli-shell="framed" className="flex" style={{ height }}>
        <div data-volli-sidebar className="w-40 shrink-0 bg-sidebar">
          <div className="flex flex-col gap-1 p-2">
            {["Board", "Sessions", "Files"].map((row, index) => (
              <span
                key={row}
                className={`rounded-md px-2 py-1 text-[11px] ${
                  index === 0 ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"
                }`}
              >
                {row}
              </span>
            ))}
          </div>
        </div>
        <div data-slot="sidebar-inset" className="min-w-0 flex-1 bg-background">
          <div className="flex h-10 items-center border-b border-border px-3 text-[11px] text-muted-foreground">
            Doing · 3
          </div>
          <div data-rig-tile className="p-3">
            <TicketCardContent ticket={ticketById("tkt-12")} ticketPrefix={project.ticketPrefix} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CandidateBadge({ candidate }: { candidate: Candidate }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-[13px] text-foreground">{candidate.label}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{candidate.reading}</span>
    </div>
  );
}

/**
 * One compare column: its own rig root, so five pairs coexist on one screen.
 *
 * `min-w-0` is load-bearing rather than tidy. A flex item keeps `min-width:
 * auto`, so the composer's intrinsic width wins over `w-[320px]` and every
 * column silently renders ~500px wide — which is not five columns of the same
 * width being compared, it is five different layouts.
 */
function CompareColumn({
  candidate,
  assignment,
}: {
  candidate: Candidate;
  assignment: Assignment;
}) {
  return (
    <div
      data-radius-rig
      data-rig-assign={assignment}
      style={candidateVars(candidate)}
      className="flex w-[320px] min-w-0 shrink-0 flex-col gap-4"
    >
      <div className="rounded-[14px] border border-border/70 bg-background/60 px-3 py-2">
        <CandidateBadge candidate={candidate} />
      </div>
      <ComposerComposite />
      <FieldComposite />
      <ButtonComposite compact />
      <TileComposite compact />
      <ChromeCornerComposite height={170} />
    </div>
  );
}

export default function RadiusLadderScratch() {
  const [candidateId, setCandidateId] = React.useState(CANDIDATES[0].id);
  const [assignment, setAssignment] = React.useState<Assignment>("proposed");
  const [mode, setMode] = React.useState<Mode>("single");
  const candidate = CANDIDATES.find((entry) => entry.id === candidateId) ?? CANDIDATES[0];

  // On `<html>`, not on a wrapper: the menu and the dialog are portalled to
  // `body`, so a pair written any lower would leave the two surfaces the
  // decision most needs to see inheriting the shipped ladder. Compare mode
  // clears the pair again — there the columns are the only source.
  React.useEffect(() => {
    const root = document.documentElement;
    const vars = mode === "single" ? candidateVars(candidate) : undefined;
    root.dataset.radiusRig = "";
    root.dataset.rigAssign = assignment;
    if (vars !== undefined) {
      for (const [name, value] of Object.entries(vars)) {
        root.style.setProperty(name, String(value));
      }
    }
    return () => {
      delete root.dataset.radiusRig;
      delete root.dataset.rigAssign;
      for (const name of Object.keys(candidateVars(CANDIDATES[1]) ?? {})) {
        root.style.removeProperty(name);
      }
    };
  }, [assignment, candidate, mode]);

  // 1–5 and `c`, so an A/B is a keypress rather than a pointer trip to the
  // toolbar and back — the composer's textarea keeps its own keys.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (event.key === "c") {
        setMode((current) => (current === "single" ? "compare" : "single"));
        return;
      }
      const index = Number.parseInt(event.key, 10) - 1;
      if (Number.isInteger(index) && index >= 0 && index < CANDIDATES.length) {
        setMode("single");
        setCandidateId(CANDIDATES[index].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="h-svh w-full overflow-y-auto">
      <style>{rigCss}</style>

      {/* Sticky rather than floating: compare mode lays five columns out from
          the top edge, and a floating bar puts the candidate's own label — the
          one thing a screenshot has to carry — underneath itself. The right
          padding is the lab's own theme toolbar, which is fixed up there. */}
      <div className="sticky top-0 z-[9998] flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 bg-background/85 px-3 py-2 pr-[440px] backdrop-blur-xl">
        <span className="rounded-[999px] bg-primary/15 px-2 py-1 font-mono text-[10px] uppercase text-primary-text">
          Lab · radius
        </span>
        <ChoiceGroup
          label="Ladder"
          value={candidateId}
          options={CANDIDATES.map((entry) => ({ value: entry.id, label: entry.label }))}
          onChange={(next) => {
            setMode("single");
            setCandidateId(next);
          }}
        />
        <ChoiceGroup<Assignment>
          label="Rungs"
          value={assignment}
          options={ASSIGNMENTS}
          onChange={setAssignment}
        />
        <ChoiceGroup<Mode> label="View" value={mode} options={MODES} onChange={setMode} />
      </div>

      {mode === "compare" ? (
        <div className="flex gap-5 px-6 pt-5 pb-10">
          {CANDIDATES.map((entry) => (
            <CompareColumn key={entry.id} candidate={entry} assignment={assignment} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-5 px-6 pt-5 pb-10">
          <div className="flex items-center gap-3 rounded-[14px] border border-border/70 bg-background/60 px-4 py-2">
            <CandidateBadge candidate={candidate} />
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              1–5 switch · c compares
            </span>
          </div>

          <div className="flex flex-wrap items-start gap-5">
            <Panel label="Composer — the liked 16px datum" width={680}>
              <ComposerComposite />
            </Panel>
            <Panel label="Chrome corner — rounded view in rounded chrome" width={560}>
              <ChromeCornerComposite />
            </Panel>
            <Panel label="Dropdown menu" width={320} className="min-h-[360px]">
              <MenuComposite />
            </Panel>
            <Panel label="Text fields" width={360}>
              <FieldComposite />
            </Panel>
            <Panel label="Buttons" width={440}>
              <ButtonComposite />
            </Panel>
            <Panel label="Card / tile" width={320}>
              <TileComposite />
            </Panel>
            <Panel label="Dialog" width={220}>
              <DialogComposite />
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
