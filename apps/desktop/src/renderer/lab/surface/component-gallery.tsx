import * as React from "react";
import {
  Check,
  CheckCircle,
  Copy,
  DotsThree,
  Folder,
  MagnifyingGlass,
  NotePencil,
  Star,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { TICKET_PRIORITY_LABELS, type TicketPriority } from "@volli/shared";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@renderer/components/ui/accordion";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
import { Checkbox } from "@renderer/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@renderer/components/ui/input-group";
import { Notice } from "@renderer/components/ui/notice";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Separator } from "@renderer/components/ui/separator";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { Switch } from "@renderer/components/ui/switch";
import { Tab, TabStrip } from "@renderer/components/ui/tab-strip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import type { SurfaceStyle } from "./model";
import { SpatialLayers } from "./spatial-lighting";

/** Imported production families, beyond the workspace fixture's six primitives. */
export const COMPONENT_COVERAGE = [
  "Badge",
  "Switch",
  "Checkbox",
  "Select",
  "Accordion",
  "TabStrip",
  "ButtonGroup",
  "Notice",
  "StatusDot",
  "Spinner",
  "Skeleton",
  "InputGroup",
  "Tooltip",
  "DropdownMenu",
  "ContextMenu",
  "Dialog",
  "SectionHeading",
  "Separator",
  "PriorityIndicator",
] as const;

const FLOATING_IDS = [
  "gallery-select",
  "gallery-menu",
  "gallery-submenu",
  "gallery-context-menu",
  "gallery-tooltip",
  "gallery-dialog",
] as const;
type FloatingId = (typeof FLOATING_IDS)[number];
const SESSION_STATES: { state: StatusDotState; label: string }[] = [
  { state: "working", label: "Working" },
  { state: "ready", label: "Ready" },
  { state: "waiting", label: "Waiting" },
  { state: "error", label: "Error" },
  { state: "parked", label: "Parked" },
];
const TABS = ["Overview", "Activity", "Files"] as const;
const PRIORITIES: TicketPriority[] = ["low", "medium", "high"];

function keepDialsInteractive(event: { target: EventTarget | null; preventDefault(): void }) {
  if (
    event.target instanceof Element &&
    event.target.closest(".dialkit-root, [data-surface-controls]")
  )
    event.preventDefault();
}

function GallerySection({ title, children }: { title: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-muted/10 p-4"
    >
      <SectionHeading as="h3" id={id}>
        {title}
      </SectionHeading>
      {children}
    </section>
  );
}

/** All controls write only this fixture's state. No store, preload or main API. */
export function SurfaceComponentGallery({
  style,
  onSurface,
  material = "glass",
  reference = false,
}: {
  style: SurfaceStyle;
  onSurface: (id: string, node: HTMLElement | null) => void;
  material?: string;
  reference?: boolean;
}) {
  const [notifications, setNotifications] = React.useState(true);
  const [included, setIncluded] = React.useState<boolean | "indeterminate">("indeterminate");
  const [priority, setPriority] = React.useState<TicketPriority>("medium");
  const [tab, setTab] = React.useState<(typeof TABS)[number]>("Overview");
  const [query, setQuery] = React.useState("");
  const [pinned, setPinned] = React.useState(false);
  const [fault, setFault] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [message, setMessage] = React.useState("Local fixture ready");
  const tabPanel = React.useId();
  const tabPrefix = React.useId();
  const matchingFiles = ["globals.css", "surface.tsx"].filter((name) =>
    name.toLowerCase().includes(query.toLowerCase()),
  );

  // Stable ref identities prevent unregister/register churn while typing or tuning.
  const surfaceCallback = React.useRef(onSurface);
  surfaceCallback.current = onSurface;
  const refs = React.useMemo(() => {
    const result = {} as Record<FloatingId, (node: HTMLElement | null) => void>;
    for (const id of FLOATING_IDS) result[id] = (node) => surfaceCallback.current(id, node);
    return result;
  }, []);
  const floating = (id: FloatingId) => ({
    style,
    ref: refs[id],
    className: `surface-lens surface-dimensional text-ui animate-none!${reference ? " surface-reference" : ""}`,
    "data-material": material,
  });

  return (
    <TooltipProvider>
      <section
        style={style}
        aria-label="Production component gallery"
        data-testid="surface-component-gallery"
        className="flex min-w-0 flex-col gap-4 text-ui text-foreground"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeading>Component gallery</SectionHeading>
          <Badge variant="count-pill">{COMPONENT_COVERAGE.length} families</Badge>
        </div>
        <div aria-label="Component inventory" className="flex flex-wrap gap-1">
          {COMPONENT_COVERAGE.map((name) => (
            <Badge key={name} variant="outline">
              {name}
            </Badge>
          ))}
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
          <GallerySection title="Fields & choices">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="accent">Selected</Badge>
              <Badge variant="secondary">Fixture</Badge>
              <Badge variant="destructive">Failed</Badge>
            </div>
            <label className="flex items-center justify-between gap-2">
              Preview notifications
              <Switch checked={notifications} onCheckedChange={setNotifications} />
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={included} onCheckedChange={setIncluded} />
              Include local changes
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Priority</span>
              <Select
                value={priority}
                onValueChange={(value) => {
                  const next = PRIORITIES.find((item) => item === value);
                  if (next) setPriority(next);
                }}
              >
                <SelectTrigger aria-label="Gallery ticket priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent {...floating("gallery-select")} position="popper" align="end">
                  <SpatialLayers materialFace />
                  {PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      <PriorityIndicator priority={value} />
                      {TICKET_PRIORITY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <InputGroup aria-label="Gallery search field">
              <InputGroupAddon>
                <MagnifyingGlass aria-hidden className="size-4" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search gallery files"
                placeholder="Find a file…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>{matchingFiles.length}</InputGroupText>
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Reset gallery search"
                  onClick={() => setQuery("")}
                >
                  <X aria-hidden />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </GallerySection>

          <GallerySection title="Navigation & groups">
            {/* Short, non-shrinking labels never activate Tab's internal clipped-label portal. */}
            <TabStrip variant="folder" label="Gallery workspace tabs">
              {TABS.map((name) => (
                <Tab
                  key={name}
                  id={`${tabPrefix}-${name}`}
                  label={name}
                  active={tab === name}
                  tabStop={tab === name}
                  closable={false}
                  aria-controls={tabPanel}
                  onActivate={() => setTab(name)}
                />
              ))}
            </TabStrip>
            <div
              id={tabPanel}
              role="tabpanel"
              aria-labelledby={`${tabPrefix}-${tab}`}
              tabIndex={0}
              className="rounded-lg border border-border p-2"
            >
              {tab === "Overview"
                ? "VC-617 · Surface study"
                : tab === "Activity"
                  ? "Fixture session · ready"
                  : matchingFiles.length
                    ? matchingFiles.join(" · ")
                    : "No matching files"}
            </div>
            <ButtonGroup aria-label="Gallery review actions">
              <Button variant="outline" size="sm" onClick={() => setMessage("Local draft saved")}>
                <NotePencil aria-hidden />
                Save draft
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMessage("Local review requested")}
              >
                <Check aria-hidden />
                Review
              </Button>
            </ButtonGroup>
            <Accordion type="single" collapsible defaultValue="branch">
              <AccordionItem value="branch">
                <AccordionTrigger>Working copy</AccordionTrigger>
                <AccordionContent>
                  <span className="text-muted-foreground">volli / VC-617-surface</span>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="checks">
                <AccordionTrigger>Checks</AccordionTrigger>
                <AccordionContent>
                  <Badge variant="secondary">3 passed</Badge>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </GallerySection>

          <GallerySection title="Read states & feedback">
            <div className="flex flex-wrap gap-4">
              {SESSION_STATES.map(({ state, label }) => (
                <span key={state} className="inline-flex items-center gap-2">
                  <StatusDot state={state} />
                  {label}
                </span>
              ))}
            </div>
            <Notice
              tone={fault ? "error" : "positive"}
              icon={fault ? WarningCircle : CheckCircle}
              title={fault ? "Fixture read paused" : "Fixture read recovered"}
              actions={
                <Button size="sm" variant="outline" onClick={() => setFault((value) => !value)}>
                  {fault ? "Retry fixture" : "Simulate fault"}
                </Button>
              }
              announce
            />
            <Separator />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2">
                {loading ? (
                  <Spinner aria-label="Loading fixture" />
                ) : (
                  <CheckCircle aria-hidden className="size-4 text-positive" />
                )}
                {loading ? "Reading fixture" : "Fixture loaded"}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setLoading((value) => !value)}>
                {loading ? "Finish read" : "Replay read"}
              </Button>
            </div>
            {loading ? (
              <div aria-hidden className="flex flex-col gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : (
              <p className="text-muted-foreground">Surface exploration · 2 local files</p>
            )}
          </GallerySection>

          <GallerySection title="Floating surfaces">
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <DotsThree aria-hidden />
                    Fixture actions
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  {...floating("gallery-menu")}
                  align="start"
                  onInteractOutside={keepDialsInteractive}
                >
                  <SpatialLayers materialFace />
                  <DropdownMenuLabel>Surface exploration</DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={() => setMessage("Local title copied (fixture only)")}
                  >
                    <Copy aria-hidden />
                    Copy title
                  </DropdownMenuItem>
                  <DropdownMenuCheckboxItem checked={pinned} onCheckedChange={setPinned}>
                    <Star aria-hidden />
                    Pin fixture
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Folder aria-hidden />
                      Move sample
                    </DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent {...floating("gallery-submenu")}>
                        <SpatialLayers materialFace />
                        <DropdownMenuItem
                          onSelect={() => setMessage("Sample moved to Todo locally")}
                        >
                          Todo
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setMessage("Sample moved to Doing locally")}
                        >
                          Doing
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Pin gallery sample"
                    aria-pressed={pinned}
                    onClick={() => setPinned((value) => !value)}
                  >
                    <Star aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent {...floating("gallery-tooltip")}>
                  <SpatialLayers materialFace />
                  {pinned ? "Unpin sample" : "Pin sample"}
                </TooltipContent>
              </Tooltip>
              {/* Non-modal: DialogContent's internal Overlay renders no DOM. Every rendered portal is scoped. */}
              <Dialog modal={false}>
                <DialogTrigger asChild>
                  <Button variant="outline">Sample details</Button>
                </DialogTrigger>
                <DialogContent
                  {...floating("gallery-dialog")}
                  onInteractOutside={keepDialsInteractive}
                >
                  <SpatialLayers materialFace />
                  <DialogHeader>
                    <DialogTitle>Surface exploration</DialogTitle>
                    <DialogDescription>VC-617 · Local fixture</DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <PriorityIndicator priority={priority} />
                    <Badge variant="accent">{TICKET_PRIORITY_LABELS[priority]}</Badge>
                    <Badge variant="secondary">{pinned ? "Pinned" : "Unpinned"}</Badge>
                  </div>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline" size="sm">
                        Dismiss details
                      </Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button
                        size="sm"
                        onClick={() => setMessage("Fixture details applied locally")}
                      >
                        Apply sample
                      </Button>
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
            <ContextMenu modal={false}>
              <ContextMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="w-full justify-start border border-dashed border-border"
                >
                  <Folder aria-hidden />
                  Sample file · right-click
                </Button>
              </ContextMenuTrigger>
              <ContextMenuContent
                {...floating("gallery-context-menu")}
                onInteractOutside={keepDialsInteractive}
              >
                <SpatialLayers materialFace />
                <ContextMenuLabel>surface.tsx</ContextMenuLabel>
                <ContextMenuItem
                  icon={NotePencil}
                  onSelect={() => setMessage("Sample file opened locally")}
                >
                  Open sample
                </ContextMenuItem>
                <ContextMenuItem
                  icon={Copy}
                  onSelect={() => setMessage("Sample path copied (fixture only)")}
                >
                  Copy sample path
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem icon={Star} onSelect={() => setPinned((value) => !value)}>
                  {pinned ? "Unpin sample" : "Pin sample"}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            <Notice title={message} announce />
          </GallerySection>
        </div>
      </section>
    </TooltipProvider>
  );
}
