/**
 * Every Phosphor weight the app uses, at the size and ink tier it really uses
 * it, so "this looks out of place" can be settled by looking rather than by
 * arguing.
 *
 * The complaint that started this is about RELATIVE weight — a filled glyph
 * beside a word, not a filled glyph on its own — so nothing here is drawn large
 * or on a white card. Each surface sits on its own real background token and
 * each site keeps its real neighbouring text at its real type step. A 12px
 * muted glyph judged at 24px on `bg-background` is a different glyph.
 *
 * The numbers are measured, not asserted. Phosphor ships every weight as FILLED
 * paths on a 256 viewBox — there is no `stroke-width` anywhere in the set — so
 * "how heavy is this icon" is a path-area question with an exact answer. The
 * figures in `INK` are ink coverage as a fraction of the glyph's box, obtained
 * by flattening each weight's path data and scanline-filling it under the
 * even-odd rule. That measurement is what turns the audit from taste into a
 * rule, because it exposes the thing you cannot see one icon at a time:
 *
 *   • `bold` is a true weight step — 1.50x regular's ink, and within 1.40–1.59x
 *     for every icon in the set. Same drawing, thicker stroke, predictable.
 *   • `fill` is not a weight at all. It averages 2.49x but ranges from 1.04x
 *     (SlidersHorizontal, where it changes literally nothing) to 7.61x (Check,
 *     where it replaces the tick with a solid disc). It is a DIFFERENT DRAWING,
 *     and how heavy it lands is a property of whether the icon happens to have
 *     an interior to flood — not of anything the caller meant.
 *
 * That split is the whole finding. Icons built around an enclosure — circles,
 * squares, screens, sheets — flood to 47–56% coverage under `fill`: half the
 * box goes solid, about three times what the same icon draws at `regular`. Open
 * forms — brooms, wrenches, arrows, sliders — barely move. So the app's 74
 * `weight="fill"` sites are not one decision applied consistently; they are one
 * PROP applied consistently, producing an effect that swings by 7x across
 * sites. The sidebar reads noisy and the ticket rail reads fine, from the same
 * line of code.
 *
 * Where that lands against TYPE is the reason it reads as wrong rather than
 * merely heavy. Regular's 16.9% mean coverage is roughly where a text stem sits
 * in its own advance box at these sizes, which is why an unannotated icon
 * disappears into a sentence correctly. Bold's 25% is about a semibold stem.
 * Nothing in typography sits at 50% — the nearest object in this app to a
 * half-solid box is the session row's `size-1.5` status DOT. That is what a
 * filled 12px ChatCircle is competing with, and losing to, in a row that
 * already has one.
 *
 * ── round 2: what interactivity changed
 *
 * The rule was first written as "fill travels with semantic ink", keyed to
 * `text-primary` / `text-destructive` / a toast tint. It has been re-cut around
 * INTERACTIVITY instead, and the two turn out to be one rule seen from two
 * sides: both are asking whether an item is the exception among its neighbours.
 * Active-among-peers and failed-among-succeeded are the same move, so clause 2
 * now names the move rather than one of its symptoms.
 *
 * The reconciliation bites in exactly one place, and it is the place the two
 * readings appeared to collide: a transcript's failed step is semantic but not
 * interactive, and it sits in a scannable list otherwise being stripped to
 * outline. It KEEPS its fill. "Scannable lists go outline" governs a list's
 * BASELINE, not its exceptions — the scan works because the routine rows are
 * uniform, and stripping the three status glyphs as well would delete the only
 * thing that uniformity was buying.
 *
 * Running the other way: interactivity earns fill, but clause 3 asks first
 * whether the active state is already carried by something else. In this app it
 * always is — the canvas system hands every active surface a veil and an ink
 * promotion — so the honest count of icons that should be filled for being
 * active is ZERO, and both round-1 toggle candidates went to regular. That is
 * not the rule failing to fire. It is "in some places where necessary, not all"
 * applied to an app that already signals state well, and it leaves the weight
 * channel unspent and available for a surface that one day has nothing else.
 *
 * The fragments below are rebuilt rather than imported. Not for convenience:
 * the comparison needs the same row drawn twice at two weights, and every app
 * component in question hard-codes its weight at the call site, so there is no
 * prop to vary. Importing them would show the current state twice. The classes
 * are copied verbatim from the real components (cited per fragment) and the
 * sizes and ink tiers were resolved through the primitives that supply them —
 * `[&_svg:not([class*='size-'])]:size-4` in the menu primitives, the Button
 * size variants, `[&>svg]:size-4` on SidebarMenuButton — so a site listed at
 * 16px is 16px because its parent says so, not because it was guessed.
 */
import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BellSlashIcon } from "@phosphor-icons/react/dist/csr/BellSlash";
import { BroomIcon } from "@phosphor-icons/react/dist/csr/Broom";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { FileIcon } from "@phosphor-icons/react/dist/csr/File";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { FunnelSimpleIcon } from "@phosphor-icons/react/dist/csr/FunnelSimple";
import { GaugeIcon } from "@phosphor-icons/react/dist/csr/Gauge";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { GitCommitIcon } from "@phosphor-icons/react/dist/csr/GitCommit";
import { GitPullRequestIcon } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { HandPalmIcon } from "@phosphor-icons/react/dist/csr/HandPalm";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { ProhibitIcon } from "@phosphor-icons/react/dist/csr/Prohibit";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { SquareIcon } from "@phosphor-icons/react/dist/csr/Square";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import type { Icon, IconWeight } from "@phosphor-icons/react";

import { cn } from "@renderer/lib/utils";

export const title = "Icon weight audit";
export const note = "fill vs regular at real size and ink — the rule, and the 74 sites behind it";

/* ------------------------------------------------------------- measurement */

/**
 * Ink coverage as a fraction of the glyph box, per weight, measured off
 * Phosphor 2.1.10's own path data (see the module comment for how).
 *
 * Only the icons this audit actually renders are listed. The interesting
 * column is the last ratio, not the absolutes: `bold` sits at 1.5x everywhere,
 * `fill` is wherever the icon's geometry happens to put it.
 */
const INK = {
  Archive: { regular: 0.221, bold: 0.329, fill: 0.406 },
  ArrowClockwise: { regular: 0.138, bold: 0.208, fill: 0.146 },
  ArrowSquareOut: { regular: 0.169, bold: 0.253, fill: 0.187 },
  BellSlash: { regular: 0.202, bold: 0.291, fill: 0.391 },
  Broom: { regular: 0.225, bold: 0.333, fill: 0.286 },
  CaretRight: { regular: 0.059, bold: 0.09, fill: 0.149 },
  ChatCircle: { regular: 0.159, bold: 0.237, fill: 0.54 },
  Check: { regular: 0.066, bold: 0.102, fill: 0.505 },
  CheckCircle: { regular: 0.178, bold: 0.269, fill: 0.487 },
  Circle: { regular: 0.147, bold: 0.221, fill: 0.518 },
  Clock: { regular: 0.178, bold: 0.268, fill: 0.488 },
  File: { regular: 0.183, bold: 0.275, fill: 0.513 },
  FileText: { regular: 0.22, bold: 0.336, fill: 0.476 },
  Folder: { regular: 0.182, bold: 0.274, fill: 0.483 },
  Folders: { regular: 0.213, bold: 0.325, fill: 0.44 },
  FunnelSimple: { regular: 0.103, bold: 0.161, fill: 0.475 },
  Gauge: { regular: 0.192, bold: 0.283, fill: 0.377 },
  GearSix: { regular: 0.231, bold: 0.346, fill: 0.436 },
  GitCommit: { regular: 0.108, bold: 0.158, fill: 0.185 },
  GitPullRequest: { regular: 0.181, bold: 0.268, fill: 0.206 },
  Globe: { regular: 0.304, bold: 0.427, fill: 0.367 },
  HandPalm: { regular: 0.21, bold: 0.311, fill: 0.387 },
  Info: { regular: 0.173, bold: 0.262, fill: 0.492 },
  MagnifyingGlass: { regular: 0.142, bold: 0.212, fill: 0.291 },
  Moon: { regular: 0.146, bold: 0.217, fill: 0.332 },
  PaperPlaneTilt: { regular: 0.177, bold: 0.264, fill: 0.345 },
  PencilSimple: { regular: 0.15, bold: 0.223, fill: 0.285 },
  Prohibit: { regular: 0.19, bold: 0.281, fill: 0.401 },
  PushPin: { regular: 0.157, bold: 0.235, fill: 0.358 },
  SidebarSimple: { regular: 0.204, bold: 0.303, fill: 0.273 },
  SlidersHorizontal: { regular: 0.134, bold: 0.202, fill: 0.139 },
  Square: { regular: 0.169, bold: 0.252, fill: 0.559 },
  TerminalWindow: { regular: 0.209, bold: 0.316, fill: 0.514 },
  Ticket: { regular: 0.217, bold: 0.321, fill: 0.423 },
  Warning: { regular: 0.174, bold: 0.261, fill: 0.406 },
  WarningCircle: { regular: 0.171, bold: 0.259, fill: 0.494 },
  Wrench: { regular: 0.178, bold: 0.263, fill: 0.284 },
  XCircle: { regular: 0.194, bold: 0.292, fill: 0.472 },
} as const satisfies Record<string, Record<"regular" | "bold" | "fill", number>>;

type IconName = keyof typeof INK;

/** The audited glyph set, so a site names its icon once and gets both drawing and data. */
const GLYPH: Record<IconName, Icon> = {
  Archive: ArchiveIcon,
  ArrowClockwise: ArrowClockwiseIcon,
  ArrowSquareOut: ArrowSquareOutIcon,
  BellSlash: BellSlashIcon,
  Broom: BroomIcon,
  CaretRight: CaretRightIcon,
  ChatCircle: ChatCircleIcon,
  Check: CheckIcon,
  CheckCircle: CheckCircleIcon,
  Circle: CircleIcon,
  Clock: ClockIcon,
  File: FileIcon,
  FileText: FileTextIcon,
  Folder: FolderIcon,
  Folders: FoldersIcon,
  FunnelSimple: FunnelSimpleIcon,
  Gauge: GaugeIcon,
  GearSix: GearSixIcon,
  GitCommit: GitCommitIcon,
  GitPullRequest: GitPullRequestIcon,
  Globe: GlobeIcon,
  HandPalm: HandPalmIcon,
  Info: InfoIcon,
  MagnifyingGlass: MagnifyingGlassIcon,
  Moon: MoonIcon,
  PaperPlaneTilt: PaperPlaneTiltIcon,
  PencilSimple: PencilSimpleIcon,
  Prohibit: ProhibitIcon,
  PushPin: PushPinIcon,
  SidebarSimple: SidebarSimpleIcon,
  SlidersHorizontal: SlidersHorizontalIcon,
  Square: SquareIcon,
  TerminalWindow: TerminalWindowIcon,
  Ticket: TicketIcon,
  Warning: WarningIcon,
  WarningCircle: WarningCircleIcon,
  Wrench: WrenchIcon,
  XCircle: XCircleIcon,
};

/**
 * Real render sizes, as Tailwind utilities rather than inline pixels — the same
 * classes the audited call sites carry or inherit, so what you measure here is
 * what ships.
 */
const SIZE_CLASS = {
  8: "size-2",
  10: "size-2.5",
  12: "size-3",
  14: "size-3.5",
  16: "size-4",
  20: "size-5",
  32: "size-8",
} as const;

type Px = keyof typeof SIZE_CLASS;

/* ------------------------------------------------------------------- sites */

/**
 * What the audit concluded, in the vocabulary the rule is stated in.
 *
 * `toggle` is not a fourth weight. It is the one case where `fill` earns its
 * mass — a control whose OFF state is the same icon at `regular` — and it is
 * called out separately because a fill that never toggles is exactly the
 * failure this audit is about.
 */
type Verdict = "fill" | "regular" | "toggle";

interface Site {
  /** `file.tsx:line`, relative to `src/renderer/src/components/`. */
  at: string;
  icon: IconName;
  px: Px;
  /** The ink class actually resolved at this site, inherited chain included. */
  ink: string;
  /** What sits beside it, at its real type step. `null` where the site is icon-only. */
  label: string | null;
  labelClass: string;
  /** The icon's job — the thing the verdict is actually derived from. */
  job: string;
  verdict: Verdict;
  /** Only where the verdict is not obvious from the job. */
  note?: string;
}

interface Surface {
  name: string;
  /** The real background this surface renders on. */
  surfaceClass: string;
  sites: Site[];
}

const MUTED = "text-muted-foreground";

const SURFACES: Surface[] = [
  {
    name: "Sidebar",
    surfaceClass: "bg-sidebar",
    sites: [
      {
        at: "sidebar/session-band-header.tsx:94",
        icon: "FunnelSimple",
        px: 14,
        ink: MUTED,
        label: null,
        labelClass: "",
        job: "Filter trigger",
        verdict: "regular",
        note: "4.6x — the widest fill/regular gap in the app. Regular is three bars; fill is a solid card with the bars knocked out. Different mark, not a heavier one.",
      },
      {
        at: "sidebar/session-band-header.tsx:105",
        icon: "ChatCircle",
        px: 16,
        ink: MUTED,
        label: "Chats",
        labelClass: "text-sm",
        job: "Menu item noun",
        verdict: "regular",
      },
      {
        at: "sidebar/session-band-header.tsx:113",
        icon: "TerminalWindow",
        px: 16,
        ink: MUTED,
        label: "Terminals",
        labelClass: "text-sm",
        job: "Menu item noun",
        verdict: "regular",
      },
      {
        at: "sidebar/session-band-header.tsx:122",
        icon: "Broom",
        px: 16,
        ink: MUTED,
        label: "Cleaned up",
        labelClass: "text-sm",
        job: "Menu item noun",
        verdict: "regular",
        note: "1.27x — dropping the prop is very nearly invisible here.",
      },
      {
        at: "sidebar/session-band-row.tsx:69",
        icon: "Globe",
        px: 12,
        ink: MUTED,
        label: "Ticketless session",
        labelClass: "text-label",
        job: "Identity noun",
        verdict: "regular",
        note: "1.21x — invisible change.",
      },
      {
        at: "sidebar/session-band-row.tsx:83",
        icon: "ChatCircle",
        px: 12,
        ink: MUTED,
        label: "Rebase onto main",
        labelClass: "text-xs",
        job: "Kind glyph",
        verdict: "regular",
        note: "3.4x. At 12px the fill is a solid disc covering 54% of its box, sat inside a 12px muted line — the glyph becomes the heaviest thing in a row whose job is to be scanned past.",
      },
      {
        at: "sidebar/session-band-row.tsx:83",
        icon: "TerminalWindow",
        px: 12,
        ink: MUTED,
        label: "Rebase onto main",
        labelClass: "text-xs",
        job: "Kind glyph",
        verdict: "regular",
      },
      {
        at: "sidebar/session-band-row.tsx:217",
        icon: "Broom",
        px: 12,
        ink: MUTED,
        label: "Cleaned up",
        labelClass: "text-xs",
        job: "Row state mark",
        verdict: "regular",
        note: "1.27x. The row already carries its state as 45% opacity — the broom names it, it does not signal it.",
      },
      {
        at: "sidebar/nav-list.tsx:60",
        icon: "Ticket",
        px: 16,
        ink: "text-sidebar-foreground",
        label: "Board",
        labelClass: "text-sm",
        job: "Nav destination noun",
        verdict: "regular",
        note: "Active is already carried by ink + background veil. Weight would be a third copy of one bit.",
      },
      {
        at: "sidebar/primary-sidebar.tsx:149",
        icon: "GearSix",
        px: 16,
        ink: "text-sidebar-foreground",
        label: "Settings",
        labelClass: "text-sm",
        job: "Nav destination noun",
        verdict: "regular",
      },
      {
        at: "sidebar/file-tree.tsx:419",
        icon: "Folder",
        px: 16,
        ink: "text-sidebar-foreground",
        label: "packages/shared",
        labelClass: "text-sm",
        job: "Tree row noun",
        verdict: "regular",
        note: 'Sits beside a weight="bold" CaretRight in the same 16px slot — the row currently mixes both overcorrections.',
      },
      {
        at: "sidebar/file-tree.tsx:357",
        icon: "File",
        px: 16,
        ink: "text-sidebar-foreground",
        label: "session-band-row.tsx",
        labelClass: "text-sm",
        job: "Tree row noun",
        verdict: "regular",
      },
    ],
  },
  {
    name: "Chat transcript",
    surfaceClass: "bg-card",
    sites: [
      {
        at: "chat/activity-ui.tsx:338",
        icon: "TerminalWindow",
        px: 14,
        ink: MUTED,
        label: "Ran  pnpm test",
        labelClass: "text-xs",
        job: "Tool-kind noun",
        verdict: "regular",
      },
      {
        at: "chat/activity-ui.tsx:338",
        icon: "FileText",
        px: 14,
        ink: MUTED,
        label: "Read  session-band-row.tsx",
        labelClass: "text-xs",
        job: "Tool-kind noun",
        verdict: "regular",
      },
      {
        at: "chat/activity-ui.tsx:338",
        icon: "PencilSimple",
        px: 14,
        ink: MUTED,
        label: "Edited  context-menu.tsx",
        labelClass: "text-xs",
        job: "Tool-kind noun",
        verdict: "regular",
        note: "1.90x, and it is an open form — the flood has nowhere to go.",
      },
      {
        at: "chat/activity-ui.tsx:338",
        icon: "MagnifyingGlass",
        px: 14,
        ink: MUTED,
        label: "Searched  weight=",
        labelClass: "text-xs",
        job: "Tool-kind noun",
        verdict: "regular",
      },
      {
        at: "chat/activity-ui.tsx:320",
        icon: "Wrench",
        px: 14,
        ink: MUTED,
        label: "6 tool calls",
        labelClass: "text-xs",
        job: "Bundle header noun",
        verdict: "regular",
      },
      {
        at: "chat/activity-ui.tsx:834",
        icon: "Gauge",
        px: 14,
        ink: MUTED,
        label: "Thought for 4s",
        labelClass: "text-xs",
        job: "Reasoning noun",
        verdict: "regular",
        // Was a Brain (0.267 / 0.384 / 0.42), retired app-wide on the owner's
        // call. Gauge is the lightest glyph in this table at 0.192 — a hair
        // above the 16.9% mean where an outline glyph disappears correctly
        // into a sentence, which is exactly the job in a scannable list. The
        // composer's effort chip draws the SAME glyph at `bold` (0.283) for
        // the opposite reason: it sits alone on a control row that rests at
        // 70%, where 0.192 draws lighter than the 13px word beside it.
      },
      {
        at: "chat/activity-ui.tsx:368",
        icon: "CheckCircle",
        px: 14,
        ink: MUTED,
        label: "Ran  pnpm test",
        labelClass: "text-xs",
        job: "Settled status",
        verdict: "regular",
        note: "The module's own comment says a settled row should say nothing else. Muted fill says it loudly.",
      },
      {
        at: "chat/activity-ui.tsx:357",
        icon: "HandPalm",
        px: 14,
        ink: "text-primary",
        label: "Needs approval",
        labelClass: "text-xs text-primary",
        job: "Blocked status",
        verdict: "fill",
      },
      {
        at: "chat/activity-ui.tsx:360",
        icon: "XCircle",
        px: 14,
        ink: "text-destructive",
        label: "Failed  exit 1",
        labelClass: "text-xs text-destructive",
        job: "Failure status",
        verdict: "fill",
      },
      {
        at: "chat/activity-ui.tsx:364",
        icon: "Prohibit",
        px: 14,
        ink: "text-destructive",
        label: "Denied",
        labelClass: "text-xs text-destructive",
        job: "Denied status",
        verdict: "fill",
      },
      {
        at: "chat/interaction-ui.tsx:246",
        icon: "HandPalm",
        px: 14,
        ink: "text-primary",
        label: "Approve a tool call",
        labelClass: "text-sm",
        job: "Permission card mark",
        verdict: "fill",
      },
      {
        at: "chat/interaction-ui.tsx:312",
        icon: "Warning",
        px: 14,
        ink: "text-destructive",
        label: "Not delivered",
        labelClass: "text-xs text-destructive",
        job: "Severity signal",
        verdict: "fill",
      },
      {
        at: "chat/chat-plane.tsx:510",
        icon: "Warning",
        px: 14,
        ink: "text-destructive",
        label: "Runtime unreachable",
        labelClass: "text-xs text-destructive",
        job: "Severity signal",
        verdict: "fill",
      },
      {
        at: "chat/chat-plane.tsx:513",
        icon: "Clock",
        px: 14,
        ink: MUTED,
        label: "Waiting for the runtime",
        labelClass: "text-xs",
        job: "Waiting status",
        verdict: "regular",
        note: "2.74x on muted ink — mass without contrast. It sits directly under the destructive Warning above and must not compete with it.",
      },
      {
        at: "chat/composer-ui.tsx:196",
        icon: "Square",
        px: 14,
        ink: "text-foreground",
        label: null,
        labelClass: "",
        job: "Stop control",
        verdict: "fill",
        note: "Settled as fill, and it no longer needs a carve-out to get there: the control is interactive and it is the exception rather than the category, appearing only while a turn runs. Clause 2 reaches it twice. That a stop square MEANS solid, the way a play triangle does, is now the third reason rather than the only one.",
      },
    ],
  },
  {
    name: "Menus — context and dropdown",
    surfaceClass: "bg-popover",
    sites: [
      {
        at: "ui/context-menu.tsx:124",
        icon: "Archive",
        px: 16,
        ink: MUTED,
        label: "Archive ticket",
        labelClass: "text-sm",
        job: "Action noun",
        verdict: "regular",
        note: "Every context-menu item in the app, via the shared primitive. 16px glyph beside 14px text — already larger, and fill makes it ~3x the ink.",
      },
      {
        at: "ui/context-menu.tsx:60",
        icon: "PushPin",
        px: 16,
        ink: MUTED,
        label: "Move to",
        labelClass: "text-sm",
        job: "Submenu noun",
        verdict: "regular",
      },
      {
        at: "ui/context-menu.tsx:172",
        icon: "Circle",
        px: 8,
        ink: "text-foreground",
        label: "Selected option",
        labelClass: "text-sm",
        job: "Radio indicator",
        verdict: "fill",
        note: "Solid IS the meaning, and its off state is absence rather than an outline. At 8px nothing else resolves.",
      },
      {
        at: "ticket/ticket-properties.tsx:853",
        icon: "GitCommit",
        px: 16,
        ink: MUTED,
        label: "Copy commit",
        labelClass: "text-sm",
        job: "Action noun",
        verdict: "regular",
      },
      {
        at: "ticket/ticket-properties.tsx:858",
        icon: "GitPullRequest",
        px: 16,
        ink: MUTED,
        label: "Open pull request",
        labelClass: "text-sm",
        job: "Action noun",
        verdict: "regular",
        note: "1.14x — invisible change.",
      },
      {
        at: "ticket/ticket-properties.tsx:863",
        icon: "ArrowSquareOut",
        px: 16,
        ink: MUTED,
        label: "Open in Finder",
        labelClass: "text-sm",
        job: "Action noun",
        verdict: "regular",
        note: "1.11x — invisible change.",
      },
      {
        at: "ticket/ticket-properties.tsx:870",
        icon: "PushPin",
        px: 16,
        ink: MUTED,
        label: "Pin ticket",
        labelClass: "text-sm",
        job: "Action noun",
        verdict: "regular",
      },
      {
        at: "ticket/ticket-properties.tsx:874",
        icon: "BellSlash",
        px: 16,
        ink: MUTED,
        label: "Mute notifications",
        labelClass: "text-sm",
        job: "Action noun",
        verdict: "regular",
      },
    ],
  },
  {
    name: "Toasts",
    surfaceClass: "bg-popover",
    sites: [
      {
        at: "ui/sonner.tsx:24",
        icon: "CheckCircle",
        px: 16,
        ink: "text-emerald-500",
        label: "Worktree created",
        labelClass: "text-sm",
        job: "Outcome badge",
        verdict: "fill",
        note: "The one surface where the glyph is meant to out-weigh its sentence — a toast is read as a colour first and a string second.",
      },
      {
        at: "ui/sonner.tsx:25",
        icon: "Info",
        px: 16,
        ink: "text-sky-500",
        label: "Session resumed",
        labelClass: "text-sm",
        job: "Outcome badge",
        verdict: "fill",
      },
      {
        at: "ui/sonner.tsx:26",
        icon: "WarningCircle",
        px: 16,
        ink: "text-amber-500",
        label: "Branch is behind origin",
        labelClass: "text-sm",
        job: "Outcome badge",
        verdict: "fill",
      },
      {
        at: "ui/sonner.tsx:27",
        icon: "XCircle",
        px: 16,
        ink: "text-destructive",
        label: "Could not push",
        labelClass: "text-sm",
        job: "Outcome badge",
        verdict: "fill",
      },
    ],
  },
  {
    name: "Ticket rail, tabs and board",
    surfaceClass: "bg-card",
    sites: [
      {
        at: "ticket/ticket-rail.tsx:84",
        icon: "Folders",
        px: 14,
        ink: MUTED,
        label: null,
        labelClass: "",
        job: "Rail tab — active",
        verdict: "regular",
        note: "The one that looked like a toggle, and is the clearest case for clause 3. Active already reads as text-primary over bg-primary/15 — two channels. Filling it too would be a third copy of one bit, and it is the ONLY state the tab has, so the fill would be on permanently in the surface where you notice it least.",
      },
      {
        at: "ui/segmented.tsx",
        icon: "Moon",
        px: 14,
        ink: "text-foreground",
        label: "Dark",
        labelClass: "text-ui",
        job: "Segmented option — selected",
        verdict: "regular",
        note: "Same resolution. The selected segment already changes button variant; the pill IS the selection. Weight adds nothing a user could read.",
      },
      {
        at: "sessions/session-tabs.tsx:310",
        icon: "ChatCircle",
        px: 12,
        ink: MUTED,
        label: "Rebase onto main",
        labelClass: "text-xs",
        job: "Tab kind noun",
        verdict: "regular",
        note: "Sits immediately after an 8px solid status dot. Two solid objects in a 12px row is one too many.",
      },
      {
        at: "ticket/ticket-tabs.tsx:230",
        icon: "Moon",
        px: 12,
        ink: MUTED,
        label: "Parked",
        labelClass: "text-xs",
        job: "Parked status",
        verdict: "regular",
        note: "12px since the two strips became one tab (`sessions/session-tabs.tsx:220` draws it identically). A filled moon at this size is a disc with a bite out of it — the ship draws bold, which is the ≤12px tier, not a fill.",
      },
      {
        at: "board/ticket-card.tsx:33",
        icon: "Archive",
        px: 12,
        ink: "text-primary",
        label: "Ready to archive",
        labelClass: "text-label",
        job: "Card status signal",
        verdict: "fill",
      },
      {
        at: "ticket/ticket-activity-feed.tsx:91",
        icon: "GitCommit",
        px: 12,
        ink: "text-muted-foreground/70",
        label: "pushed 3 commits",
        labelClass: "text-xs",
        job: "Event-kind noun",
        verdict: "regular",
      },
      {
        at: "ticket/ticket-activity-feed.tsx:333",
        icon: "PaperPlaneTilt",
        px: 14,
        ink: "text-primary-foreground",
        label: "Comment",
        labelClass: "text-ui",
        job: "Submit affordance",
        verdict: "regular",
        note: "On a filled primary button the glyph is already at maximum contrast; fill only makes it heavier than its own label.",
      },
      {
        at: "(retired) ticket/ticket-environment-inspector.tsx:227",
        icon: "Folders",
        px: 16,
        ink: MUTED,
        label: "Worktree",
        labelClass: "text-ui",
        job: "Row noun",
        verdict: "regular",
        note: "Site gone: the Calm Stack folded the inspector into ticket-repository-summary.tsx, whose Worktree row is a text CardLabel with no glyph. Kept as measurement, not as a live verdict.",
      },
      {
        at: "ticket/rail-panel-parts.tsx:143",
        icon: "ArrowClockwise",
        px: 12,
        ink: "text-destructive",
        label: "Retry",
        labelClass: "text-xs",
        job: "Recovery affordance",
        verdict: "regular",
        note: "1.06x — invisible change, and an affordance rather than a state despite the destructive ink. Moved here from the retired environment inspector, same ink and same job.",
      },
    ],
  },
  {
    name: "Chrome and settings",
    surfaceClass: "bg-rail",
    sites: [
      {
        at: "chrome-bar.tsx:168",
        icon: "SidebarSimple",
        px: 16,
        ink: "text-foreground",
        label: null,
        labelClass: "",
        job: "Sidebar toggle — genuinely interactive",
        verdict: "regular",
        note: "The one control where clause 3's channel really is empty: aria-pressed with no visual on-state at all. Fill still loses — SidebarSimple's fill is 1.34x, far too weak to carry a state on its own, and spending weight here would leave the a11y bug in place behind a change nobody can see. Fix the on-state with the veil every other active surface uses; that is a separate sweep.",
      },
      {
        at: "pages/settings-shell.tsx:69",
        icon: "GearSix",
        px: 16,
        ink: MUTED,
        label: "General",
        labelClass: "text-ui",
        job: "Settings nav noun",
        verdict: "regular",
      },
      {
        at: "pages/settings-shell.tsx:130",
        icon: "SlidersHorizontal",
        px: 16,
        ink: MUTED,
        label: "Appearance",
        labelClass: "text-sm font-semibold",
        job: "Section noun",
        verdict: "regular",
        note: "1.04x — the prop does nothing at all here.",
      },
      {
        at: "pages/appearance-settings.tsx:115",
        icon: "FileText",
        px: 14,
        ink: "text-foreground",
        label: "Ghostty config",
        labelClass: "text-ui",
        job: "Button affordance",
        verdict: "regular",
      },
      {
        at: "pages/configure-page.tsx:37",
        icon: "SlidersHorizontal",
        px: 20,
        ink: MUTED,
        label: "Nothing configured yet",
        labelClass: "text-sm",
        job: "Empty-state noun",
        verdict: "regular",
      },
      {
        at: "sessions/sessions-layer.tsx:473",
        icon: "TerminalWindow",
        px: 32,
        ink: MUTED,
        label: "No open sessions.",
        labelClass: "text-sm",
        job: "Empty-state illustration",
        verdict: "regular",
        note: "The closest fill came to surviving on size alone — at 32px the flood competes with no adjacent text. Settled as regular: an empty state is not an exception to anything, and at 32px the pen is already 2px, so legibility was never the argument. Fill just makes it a sticker.",
      },
      {
        at: "command-palette.tsx:114",
        icon: "TerminalWindow",
        px: 14,
        ink: MUTED,
        label: "Open terminal",
        labelClass: "text-sm",
        job: "Result-kind noun",
        verdict: "regular",
      },
      {
        at: "command-palette.tsx:146",
        icon: "Ticket",
        px: 14,
        ink: MUTED,
        label: "VC-12 · MCP server",
        labelClass: "text-sm",
        job: "Result-kind noun",
        verdict: "regular",
      },
    ],
  },
];

/* -------------------------------------------------------------- primitives */

/**
 * `toggle` survives the round-2 rule with zero members, and that is a finding
 * rather than dead vocabulary. Interactivity now EARNS fill — but clause 3
 * asks whether the active state is already spoken for, and in this app it
 * always is, because the canvas system hands every active surface a veil and an
 * ink promotion. So the weight channel stays unspent. Keeping the verdict named
 * is what makes that a decision instead of an omission.
 */
const VERDICT_LABEL: Record<Verdict, string> = {
  fill: "keep fill",
  regular: "→ regular",
  toggle: "→ fill when active",
};

const VERDICT_CLASS: Record<Verdict, string> = {
  fill: "border-border text-muted-foreground",
  regular: "border-primary/40 bg-primary/10 text-primary-text",
  toggle: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

function VerdictChip({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-px text-label whitespace-nowrap",
        VERDICT_CLASS[verdict],
      )}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

/** One glyph at one weight, at the site's real size and ink. */
function Glyph({
  icon,
  weight,
  px,
  ink,
}: {
  icon: IconName;
  weight: IconWeight;
  px: Px;
  ink: string;
}) {
  const Component = GLYPH[icon];
  return <Component aria-hidden weight={weight} className={cn(SIZE_CLASS[px], "shrink-0", ink)} />;
}

/**
 * The site's own row, drawn once per weight.
 *
 * Everything except the weight is held constant — same size, same ink, same
 * neighbouring string at the same type step — because the question is never
 * "is this icon nice" but "does it out-weigh the word next to it".
 */
function InSitu({ site, weight }: { site: Site; weight: IconWeight }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Glyph icon={site.icon} weight={weight} px={site.px} ink={site.ink} />
      {site.label === null ? (
        <span className="text-label text-muted-foreground/40 italic">icon only</span>
      ) : (
        <span className={cn("truncate", site.labelClass)}>{site.label}</span>
      )}
    </span>
  );
}

/** Ink coverage as a bar, so the ratio in the table is also visible as area. */
function CoverageBar({ value, tone }: { value: number; tone: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", tone)}
          style={{ width: `${value * 100}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right font-mono text-label tabular-nums text-muted-foreground">
        {(value * 100).toFixed(0)}%
      </span>
    </span>
  );
}

function SiteRow({ site }: { site: Site }) {
  const ink = INK[site.icon];
  const ratio = ink.fill / ink.regular;
  const invisible = ratio < 1.35;

  return (
    <div className="flex flex-col gap-1 border-t border-border/50 py-2.5 first:border-t-0">
      <div className="flex items-baseline gap-2">
        <code className="font-mono text-label text-muted-foreground/70">{site.at}</code>
        <span className="text-label text-muted-foreground/50">
          {site.icon} · {site.px}px · {site.job}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span
            className={cn(
              "font-mono text-label tabular-nums",
              invisible ? "text-muted-foreground/50" : "text-muted-foreground",
            )}
          >
            fill {ratio.toFixed(2)}×
          </span>
          <VerdictChip verdict={site.verdict} />
        </span>
      </div>

      <div className="grid grid-cols-[1fr_1fr_1fr] items-center gap-4">
        {(["fill", "regular", "bold"] as const).map((weight) => (
          <span key={weight} className="flex min-w-0 flex-col gap-0.5">
            <span
              className={cn(
                "text-label uppercase",
                weight === site.verdict || (site.verdict === "toggle" && weight === "regular")
                  ? "text-primary-text"
                  : "text-muted-foreground/40",
              )}
            >
              {weight}
              {weight === "fill" ? " · today" : ""}
            </span>
            <InSitu site={site} weight={weight} />
          </span>
        ))}
      </div>

      {site.note === undefined ? null : (
        <p className="max-w-content text-label text-muted-foreground/60">{site.note}</p>
      )}
    </div>
  );
}

function SurfaceBlock({ surface }: { surface: Surface }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-baseline gap-2 font-mono text-label uppercase text-muted-foreground">
        {surface.name}
        <span className="text-muted-foreground/40 normal-case">{surface.surfaceClass}</span>
      </h2>
      <div className={cn("rounded-lg border border-border px-3 py-1", surface.surfaceClass)}>
        {/* `at` alone repeats — one call site can draw several icons (the
            transcript's kind column is four sites on one line) — so the pair is
            the identity. */}
        {surface.sites.map((site) => (
          <SiteRow key={`${site.at}-${site.icon}`} site={site} />
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- rule */

const RULE: readonly { head: string; body: string }[] = [
  {
    head: "Outline is the baseline. Everything is regular until a clause below promotes it.",
    body: "No prop, no decision. The app's ~60 unannotated icons are already right and stay untouched.",
  },
  {
    head: "Fill marks the exception within a surface, never the category.",
    body: "Two things make an item exceptional: it is the ACTIVE one among peers, or it is the one that went wrong. Both are the same move — this item, unlike its neighbours. If every icon on a surface is filled, fill means nothing; it only works while it stays the minority.",
  },
  {
    head: "Don't double-signal. An active state already carried by background, ink or position stays regular.",
    body: "Weight fills in only where those channels are empty. In this app they almost never are — the canvas system gives every active row a veil and an ink promotion — which is why fill is available to interactivity but rarely spent on it. That is the 'in some places where necessary, not all'.",
  },
  {
    head: "Scannable and ephemeral lists are outline throughout — except their own exceptions.",
    body: "Every kind glyph, menu item and tree row: regular. The one row that failed, was denied, or needs you: fill. The scan works BECAUSE the baseline is uniform — stripping the exceptions too would flatten the thing the scan is for.",
  },
  {
    head: "bold is the small-size tier, not emphasis.",
    body: "Phosphor's pen is 16/256 em at regular and 24/256 at bold — 0.75px vs 1.125px at 12px, against a ~1.1px text stem. At ≤12px regular draws lighter than its own label; bold lands on it. duotone: never.",
  },
];

/** The two families, drawn from the set the app actually imports. */
const ENCLOSED: IconName[] = [
  "ChatCircle",
  "TerminalWindow",
  "Square",
  "File",
  "FunnelSimple",
  "Check",
  "Clock",
  "Info",
];
const OPEN: IconName[] = [
  "SlidersHorizontal",
  "ArrowClockwise",
  "ArrowSquareOut",
  "GitPullRequest",
  "Broom",
  "SidebarSimple",
  "Wrench",
  "PencilSimple",
];

function FamilyTable({
  heading,
  icons,
  blurb,
}: {
  heading: string;
  icons: IconName[];
  blurb: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <h3 className="text-ui font-medium text-foreground">{heading}</h3>
      <p className="text-label text-muted-foreground">{blurb}</p>
      <div className="flex flex-col">
        {icons.map((name) => {
          const ink = INK[name];
          return (
            <div
              key={name}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-border/50 py-1.5 first:border-t-0"
            >
              <span className="flex items-center gap-2">
                <Glyph icon={name} weight="regular" px={16} ink="text-muted-foreground" />
                <Glyph icon={name} weight="fill" px={16} ink="text-foreground" />
              </span>
              <span className="flex flex-col gap-0.5">
                <CoverageBar value={ink.regular} tone="bg-muted-foreground/50" />
                <CoverageBar value={ink.fill} tone="bg-primary" />
              </span>
              <span className="flex flex-col items-end">
                <span className="font-mono text-label text-muted-foreground/60">{name}</span>
                <span className="font-mono text-label tabular-nums text-foreground">
                  {(ink.fill / ink.regular).toFixed(2)}×
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- small-glyph tier */

/**
 * Phosphor's pen, in viewBox units, derived from the ring geometry of the
 * circle icons — where coverage has a closed form and the answer is exact.
 * `Circle` regular is a ring between r=104 and r=88; bold between 108 and 84.
 *
 * These two numbers settle an argument that ink coverage cannot, because
 * COVERAGE IS SCALE-INVARIANT: a 12px icon and a 14px icon of the same weight
 * have identical coverage, so growing a glyph cannot change how heavy it reads
 * against its label — only how big it is. Weight is the only control that moves
 * the pen. That is the whole case for fixing the sidebar's small tier with
 * `bold` rather than with pixels.
 */
const PEN = { regular: 16 / 256, bold: 24 / 256 } as const;

/** A 12–13px system-text stem, for the comparison the pen is being judged against. */
const TEXT_STEM_PX = 1.1;

const TIER_OPTIONS = [
  { label: "12px regular", px: 12, weight: "regular" },
  { label: "12px bold", px: 12, weight: "bold" },
  { label: "14px regular", px: 14, weight: "regular" },
] as const satisfies readonly { label: string; px: Px; weight: IconWeight }[];

/**
 * The sidebar's small glyphs under the three treatments on the table, against
 * the text they actually sit in.
 *
 * Both remedies were reached for independently and for the same reason — a 12px
 * regular glyph draws lighter than its own label — so the sidebar must pick one
 * or it will overshoot with both at once.
 */
function SmallGlyphTier() {
  const rows: readonly { icon: IconName; label: string }[] = [
    { icon: "FunnelSimple", label: "Previous · filter trigger" },
    { icon: "ChatCircle", label: "Rebase onto main" },
    { icon: "TerminalWindow", label: "Scratch — token sweep" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {TIER_OPTIONS.map((option) => (
          <span key={option.label} className="font-mono text-label text-muted-foreground">
            {option.label} — pen{" "}
            <span className="text-foreground tabular-nums">
              {(PEN[option.weight === "bold" ? "bold" : "regular"] * option.px).toFixed(2)}px
            </span>
          </span>
        ))}
        <span className="font-mono text-label text-muted-foreground">
          text stem — <span className="text-foreground tabular-nums">{TEXT_STEM_PX}px</span>
        </span>
      </div>

      <div className="rounded-lg border border-border bg-sidebar px-3 py-2">
        <div className="grid grid-cols-3 gap-x-6">
          {TIER_OPTIONS.map((option) => (
            <span key={option.label} className="flex flex-col gap-1">
              <span
                className={cn(
                  "text-label uppercase",
                  option.label === "12px bold" ? "text-primary-text" : "text-muted-foreground/40",
                )}
              >
                {option.label}
                {option.label === "12px bold" ? " · proposed" : ""}
              </span>
              {rows.map((row) => (
                <span
                  key={row.icon}
                  className="flex h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Glyph
                    icon={row.icon}
                    weight={option.weight}
                    px={option.px}
                    ink="text-muted-foreground"
                  />
                  <span className="truncate">{row.label}</span>
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- settled */

/**
 * The three calls that were genuinely close, and how they went.
 *
 * Kept in the scratch rather than deleted because each one is a place the rule
 * could plausibly have gone the other way, and a rule is only usable if the
 * near-misses are on the record — the next person to reach for `fill` on an
 * empty state should be able to see that it was considered rather than missed.
 */
const SETTLED: readonly { call: string; outcome: string }[] = [
  {
    call: "The stop Square — composer-ui:196, interaction-ui:301",
    outcome:
      "Keeps fill. Interactive, and the exception rather than the category — it exists only while a turn is running. A hollow stop square reads as a checkbox.",
  },
  {
    call: "32px empty-state icons — sessions-layer:473, files-page:345, main.tsx:32",
    outcome:
      "Regular. Nothing about an empty state is exceptional, and at 32px the pen is already 2px, so legibility was never the problem. Fill makes them stickers.",
  },
  {
    call: "aria-pressed with no visual on-state — chrome-bar:168/:243, ticket-tabs:385",
    outcome:
      "Out of scope for weight, and swept separately as an on-state fix using the veil. ticket-tabs hard-codes aria-pressed={false} on a button that can never render pressed — the same latent bug wearing a different mask. Weights here stay regular.",
  },
];

function Settled() {
  return (
    <ol className="flex max-w-content flex-col gap-2.5">
      {SETTLED.map((entry) => (
        <li key={entry.call} className="flex gap-3">
          <CheckIcon
            aria-hidden
            weight="bold"
            className="mt-1 size-3 shrink-0 text-muted-foreground/50"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-ui text-foreground">{entry.call}</span>
            <span className="text-ui text-muted-foreground">{entry.outcome}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ tally */

function tally(verdict: Verdict): number {
  return SURFACES.reduce(
    (total, surface) => total + surface.sites.filter((site) => site.verdict === verdict).length,
    0,
  );
}

export default function IconWeightAuditScratch() {
  const shown = SURFACES.reduce((total, surface) => total + surface.sites.length, 0);

  return (
    <div className="flex flex-col gap-10 pb-16">
      <section className="flex flex-col gap-4">
        <h1 className="text-heading text-foreground">The rule</h1>
        <ol className="flex max-w-content flex-col gap-2.5">
          {RULE.map((entry, index) => (
            <li key={entry.head} className="flex gap-3">
              <span className="w-4 shrink-0 font-mono text-label tabular-nums text-muted-foreground/50">
                {index + 1}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-ui font-medium text-foreground">{entry.head}</span>
                <span className="text-ui text-muted-foreground">{entry.body}</span>
              </span>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {(["fill", "regular", "toggle"] as const).map((verdict) => (
            <span key={verdict} className="flex items-center gap-1.5">
              <VerdictChip verdict={verdict} />
              <span className="font-mono text-label tabular-nums text-muted-foreground">
                {verdict === "fill" ? 16 : verdict === "regular" ? 58 : tally(verdict)}
              </span>
            </span>
          ))}
          <span className="text-label text-muted-foreground/50">
            of 74 fill sites · {shown} drawn here · 28 bold sites unchanged
          </span>
        </div>
        <p className="max-w-content text-ui text-muted-foreground">
          <span className="text-foreground">Nothing is filled for being active.</span> Interactivity
          now earns fill, but clause 3 asks first whether the active state is already spoken for —
          and here it always is, so both round-1 toggle candidates went to regular. The channel
          stays unspent, deliberately.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-label uppercase text-muted-foreground">
          Why — fill is a different drawing, not a heavier one
        </h2>
        <p className="max-w-content text-ui text-muted-foreground">
          Measured ink coverage per weight, off Phosphor&apos;s own path data. Grey bar regular,
          ember bar fill. <span className="text-foreground">bold is 1.50× regular everywhere</span>{" "}
          (1.40–1.59 across 43 icons); fill ranges 1.04–7.61× on the same prop.
        </p>
        <div className="flex flex-wrap gap-8">
          <FamilyTable
            heading="Enclosed forms — fill floods"
            icons={ENCLOSED}
            blurb="47–56% coverage: half the box solid. These are the sites that look wrong."
          />
          <FamilyTable
            heading="Open forms — fill is nearly a no-op"
            icons={OPEN}
            blurb="Within 1.0–1.9× of regular. The prop encodes an intent it never delivers."
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-label uppercase text-muted-foreground">
          Sidebar small-glyph tier — pick one
        </h2>
        <p className="max-w-content text-ui text-muted-foreground">
          Two remedies were proposed for one problem: add weight, or add size. Coverage is
          scale-invariant, so{" "}
          <span className="text-foreground">size cannot change how heavy a glyph reads</span>{" "}
          against its label — only how big it is. 12px bold puts the pen at 1.13px, on the text
          stem; 14px regular leaves it at 0.88px and 17% larger.
        </p>
        <SmallGlyphTier />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-label uppercase text-muted-foreground">
          The two the owner named
        </h2>
        <div className="flex flex-wrap gap-4">
          <FilterHeaderFragment />
          <PreviousBandFragment />
        </div>
      </section>

      {SURFACES.map((surface) => (
        <SurfaceBlock key={surface.name} surface={surface} />
      ))}

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-label uppercase text-muted-foreground">
          Settled — the close calls
        </h2>
        <Settled />
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- fragments */

/**
 * `SessionBandHeader` + `SessionBandFilterMenu`, rebuilt so the funnel's weight
 * can vary — classes lifted verbatim from `sidebar/session-band-header.tsx`.
 * The `narrowed` tint is included because that, not weight, is how the trigger
 * already says the list is hiding something.
 */
function FilterHeaderFragment() {
  const [weight, setWeight] = React.useState<IconWeight>("fill");

  return (
    <div className="flex min-w-64 flex-col gap-2">
      <WeightToggle weight={weight} onWeight={setWeight} label="session-band-header.tsx:94" />
      <div className="rounded-lg border border-border bg-sidebar p-2">
        {(["idle", "narrowed"] as const).map((state) => (
          <div key={state} className="flex h-6 items-center gap-2 px-2">
            <span className="text-label font-medium uppercase text-muted-foreground">Previous</span>
            <span className="text-label tabular-nums text-muted-foreground/70">7</span>
            <span className="ml-auto flex items-center">
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-sm",
                  state === "narrowed" ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <FunnelSimpleIcon weight={weight} className="size-3.5" />
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * `PreviousBandRow`, rebuilt for the same reason — `session-band-row.tsx:184`
 * hard-codes fill on all three of its glyphs. The status dot above is the
 * Active row's, kept in frame because it is the argument: the band is meant to
 * have exactly one solid object per row, and today it has three.
 */
function PreviousBandFragment() {
  const [weight, setWeight] = React.useState<IconWeight>("fill");

  return (
    <div className="flex min-w-80 flex-col gap-2">
      <WeightToggle weight={weight} onWeight={setWeight} label="session-band-row.tsx:69/83/217" />
      <div className="rounded-lg border border-border bg-sidebar p-2">
        <div className="flex h-9 items-start gap-2 rounded-md px-2 py-1">
          <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-500" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-ui text-sidebar-foreground">
              Collapse the vocabulary
            </span>
            <span className="flex min-w-0 items-center gap-1 text-label text-muted-foreground">
              <span className="shrink-0 font-mono">VC-14</span>
              <span aria-hidden>·</span>
              <span className="truncate">Pi · Working</span>
            </span>
          </span>
        </div>

        {[
          { id: "VC-12", title: "Rebase onto main", kind: ChatCircleIcon, cleaned: false },
          { id: null, title: "Scratch — token sweep", kind: TerminalWindowIcon, cleaned: true },
        ].map((row) => (
          <div
            key={row.title}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground",
              row.cleaned && "opacity-45",
            )}
          >
            <span className="text-label">
              {row.id === null ? (
                <span className="flex shrink-0 items-center">
                  <GlobeIcon weight={weight} aria-label="No ticket" className="size-3" />
                </span>
              ) : (
                <span className="shrink-0 font-mono">{row.id}</span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.title}</span>
            {row.cleaned ? (
              <span className="flex shrink-0 items-center">
                <BroomIcon weight={weight} aria-label="Cleaned up" className="size-3" />
              </span>
            ) : null}
            <span className="flex shrink-0 items-center">
              <row.kind weight={weight} className="size-3" />
            </span>
            <span className="shrink-0 text-label tabular-nums">2h</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WeightToggle({
  weight,
  onWeight,
  label,
}: {
  weight: IconWeight;
  onWeight(next: IconWeight): void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <code className="font-mono text-label text-muted-foreground/70">{label}</code>
      <span className="ml-auto flex items-center gap-1">
        {(["fill", "regular", "bold"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onWeight(option)}
            aria-pressed={option === weight}
            className="rounded-full px-2 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            {option}
          </button>
        ))}
      </span>
    </div>
  );
}
