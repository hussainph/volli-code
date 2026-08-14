/**
 * The interactive rigs from the design-system audit (PR #212). The audit's
 * spec prose — the diagnosis, the decision tables, the shape/radius/motion
 * rationale — has been cut; those rules now live as code (globals.css, the
 * token pipeline, the component primitives) instead of as a rendered
 * document. What remains are the comparisons still worth looking at: a
 * size-contract A/B on the real controls, an async-state gallery, and
 * Proof-01 — the current-vs-candidate dropdown surface comparison.
 */
import * as React from "react";
import type { ReactNode } from "react";

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

export const title = "Design system · audit";
export const note = "Size-contract A/B, async-state gallery, and the Proof-01 dropdown surface rig";

const PAGES = [
  { id: "sizes", label: "Sizes" },
  { id: "motion", label: "Motion & states" },
  { id: "proof", label: "Next proof" },
] as const;

type PageId = (typeof PAGES)[number]["id"];
type Density = "normal" | "compact";
type SizeContract = "roomy" | "compact-first";
type OperationState = "rest" | "pending" | "success" | "failure";

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

function Evidence({ children }: { children: ReactNode }) {
  return <p className="font-mono text-label leading-5 text-muted-foreground/80">{children}</p>;
}

function SizesPage({
  density,
  onDensityChange,
}: {
  density: Density;
  onDensityChange(value: Density): void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-raised)]">
        <p className="text-sm font-semibold text-foreground">Interface density</p>
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
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-ui font-semibold text-foreground">Current</p>
        <RealControlRow label="Current" />
        <Evidence>Button h-7 · Input h-9 · Select h-9 · Switch h-4</Evidence>
      </div>
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

function MotionPage({
  state,
  onStateChange,
}: {
  state: OperationState;
  onStateChange(value: OperationState): void;
}) {
  return (
    <div className="space-y-6">
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
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <SurfaceProofMenu />
        <SurfaceProofMenu candidate />
      </div>
    </div>
  );
}

export default function DesignSystemAuditScratch() {
  const [page, setPage] = React.useState<PageId>("sizes");
  const [density, setDensity] = React.useState<Density>("compact");
  const [operationState, setOperationState] = React.useState<OperationState>("rest");

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background shadow-[var(--shadow-card)]">
      <header className="border-b border-border bg-card/80 px-5 py-5 backdrop-blur-xl">
        <Eyebrow>Design system · audit</Eyebrow>
        <nav
          aria-label="Design system audit pages"
          className="mt-3 flex gap-1 overflow-x-auto pb-1"
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
        {page === "sizes" ? <SizesPage density={density} onDensityChange={setDensity} /> : null}
        {page === "motion" ? (
          <MotionPage state={operationState} onStateChange={setOperationState} />
        ) : null}
        {page === "proof" ? <NextProofPage /> : null}
      </main>
    </div>
  );
}
