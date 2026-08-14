/**
 * Starting a Session: the split control, and the accelerator that goes with it.
 *
 * Round two. The split button won, terminals at two clicks is accepted, and
 * real keyboard shortcuts for both kinds are in scope — so this file now leads
 * with one proposal and keeps the others behind it as the alternatives it beat
 * rather than as four peers. The click tally stays, because it is what made the
 * case and it is the only part of this that is measured rather than asserted.
 *
 * The thing all of it rests on is an asymmetry the code already has and neither
 * shipped drawing expresses. `@volli/agent-runtime` is the one structured
 * executor; a terminal is an explicit manual companion, never a silent
 * structured fallback. Both shipped modules SAY so — `ticket-session-actions`
 * calls the terminal "its explicit companion, never a peer", `new-session-menu`
 * argues neither kind should be hidden — and then one draws two identical ghost
 * icon buttons (which is what two peers look like) and the other lists Terminal
 * above Chat, so the deliberate act is the item the keyboard opens onto. The
 * split resolves it in the only way a control can: the default is a press, the
 * companion is a press plus something.
 *
 * The drawing is settled: caret shown, `+ Chat`, chords in the menu. Those are
 * the defaults, so the scratch opens on what ships. The three toggles under it
 * stay anyway, demoted from chooser to evidence — each one is the alternative
 * that lost, kept live because "the caret costs 16px" and "the word is dead
 * weight at the hundredth use" are claims you settle by pointing at them, and a
 * later reader deserves the comparison rather than the verdict alone. The one
 * worth re-pointing at is `label`: a labelled target is a BIGGER target, so the
 * word earns its width through Fitts and not only through first-run legibility,
 * which is the part that is easy to get backwards from memory.
 *
 * `newSessionKindForKeyEvent` below is not a lab fiction: it is the predicate
 * as it would ship in `lib/new-session-shortcut.ts`, in the shape this repo
 * already uses four times over (a pure function taking a structural subset of
 * KeyboardEvent, so it unit-tests in the node environment with no DOM, paired
 * with a hook that binds the listener and reads stores at press time). The lab
 * drives it through a documented ⌃-for-⌘ swap, since the browser owns ⌘T and
 * Electron does not. `newSessionScopeForChrome` beside it answers the other half
 * — who owns the Session a chord starts — and the panel resolves the real
 * function against five chrome states rather than describing it in a table that
 * would go stale on the first change.
 *
 * Imported for real: `TicketSessionActions` and `NewSessionMenu` (the two
 * baselines, so the comparison is against the shipped thing rather than a
 * redrawing of it), plus `Button`, the dropdown and the context-menu
 * primitives. Rebuilt here: the tab strip's own tab chrome and the rail's
 * session rows — `TabShell` and `SessionRow` are private to their modules, and
 * they are the frame, not the subject. Their geometry is copied verbatim
 * (h-7 rounded-md pl-2.5 text-xs on bg-rail; rounded-md border px-2 py-1) so a
 * control that only looks right in a roomier frame has nowhere to hide.
 *
 * Motion is CSS, on purpose. `motion` sits in apps/desktop's dependencies but
 * nothing in the renderer imports it, and a design draft should not smuggle in
 * the first adoption of a library. Everything here is compositor-only
 * (transform/opacity/color), interruptible because a transition restarts from
 * the computed value, critically damped by default, and given overshoot
 * nowhere, because none of these presses carry momentum.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { displayTicketId } from "@volli/shared";

import { NewSessionMenu } from "@renderer/components/sessions/new-session-menu";
import { TicketSessionActions } from "@renderer/components/ticket/ticket-session-actions";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";
import { scratchScope, ticketScope, type SessionScope } from "@renderer/stores/sessions";
import type { NavKey } from "@renderer/stores/workspace";

import { chatSessions, project, sessions, tickets } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Sessions · Starting one";
export const note = "The split control and its ⌘T, against the four it beat";

export const seed = seedApp;
export const api = appApi;

/** The two kinds a user is choosing between — chat is the default act. */
type SessionKind = "chat" | "terminal";

/** Where an instance of a control is drawn. Same semantics, different room. */
type Placement = "strip" | "rail";

interface ControlProps {
  /** A Session of either kind is already booting. */
  disabled: boolean;
  placement: Placement;
  /**
   * What was started, and what it cost. Clicks, not keystrokes — a chord costs
   * zero clicks and that is exactly the claim it is making.
   */
  onStart(kind: SessionKind, clicks: number): void;
}

/* -------------------------------------------------------------------------- */
/* The accelerator                                                             */
/* -------------------------------------------------------------------------- */

/** The subset of `KeyboardEvent` the new-Session chords inspect. */
interface NewSessionKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  /** Physical key, layout-independent — needed for the ⌥-remapped terminal chord. */
  code: string;
  repeat: boolean;
}

/**
 * ⌘T → chat, ⌥⌘T → terminal. Anything else → no Session.
 *
 * Written as it would ship in `lib/new-session-shortcut.ts`: pure, structurally
 * typed rather than DOM-typed, so it unit-tests in the node environment the way
 * `isCommandPaletteKeyEvent`, `projectIndexForKeyEvent` and the nav predicates
 * already do. One predicate returning the KIND rather than two booleans,
 * because the two chords are one decision and a caller that had to ask twice
 * could get a "both" answer that means nothing.
 *
 * Three details that are not taste:
 *
 *  • The ⌥ chord is matched by `code`, never by `key`. On macOS Option remaps
 *    the character — ⌥T produces "†" — which is the same trap `isRailToggleKeyEvent`
 *    documents for ⌥⌘B and "∫". The un-Optioned ⌘T accepts either, the way ⌘[
 *    and ⌘] accept `key` or `code`.
 *  • `repeat` is rejected. Holding ⌘T would otherwise spawn a Session per
 *    key-repeat, which is the one failure mode a create chord has that a
 *    navigate chord does not.
 *  • Ctrl is excluded outright, so ⌃T stays with the shell and readline.
 *
 * Shift is excluded too, which quietly reserves ⌘⇧T. That is the browser's
 * reopen-closed-tab chord, and this product has durable Sessions and a History
 * drawer full of them — leaving it free is cheaper than taking it back later.
 */
function newSessionKindForKeyEvent(event: NewSessionKeyEvent): SessionKind | null {
  if (!event.metaKey || event.ctrlKey || event.shiftKey || event.repeat) return null;
  if (event.altKey) return event.code === "KeyT" ? "terminal" : null;
  return event.key.toLowerCase() === "t" || event.code === "KeyT" ? "chat" : null;
}

/** The chrome facts the chord resolves against, read at press time. */
interface SessionChordChrome {
  selectedProjectId: string | null;
  /** The selected project's open ticket. Lives UNDER `nav: "board"` — see below. */
  openTicketId: string | null;
  nav: NavKey;
}

/**
 * Who owns the Session a chord starts, and where to land afterwards.
 *
 * The chord is context-sensitive, and the no-ticket case is global rather than
 * a no-op: inside a ticket ⌘T starts a ticket-owned Session, everywhere else it
 * starts the project's ticketless one and navigates to the Sessions surface.
 * The alternative reading — always global, even inside a ticket — is worse for
 * two reasons that only show up once it is built. It would make ⌘T disagree
 * with the split control sitting 40px above the cursor on the very same strip,
 * which is two affordances for one act with different results; and a ticketless
 * Session has no worktree, so "new chat while I am working this ticket" would
 * silently land in the project's main checkout instead of the ticket's tree.
 *
 * "In a ticket" is `nav === "board" && openTicketId !== null`, not a nav of its
 * own: `openTicketWorkspace` patches `{ nav: "board", openTicketId }`, so ticket
 * detail is a STATE of the board nav. A predicate that looked for a "ticket"
 * NavKey would compile, always miss, and quietly make every ⌘T global.
 *
 * Returning the landing spot rather than performing it keeps this pure and
 * unit-testable in the node environment, the way `selectRailMode` already hands
 * its caller a chrome transition instead of committing one. `navigateTo: null`
 * means stay put — pressing ⌘T while already on Sessions must not re-nav.
 */
function newSessionScopeForChrome(
  chrome: SessionChordChrome,
): { scope: SessionScope; navigateTo: NavKey | null } | null {
  const { selectedProjectId, openTicketId, nav } = chrome;
  // No project selected: nothing exists that could own a Session, and inventing
  // one is worse than the chord doing nothing.
  if (selectedProjectId === null) return null;
  if (nav === "board" && openTicketId !== null) {
    return { scope: ticketScope(selectedProjectId, openTicketId), navigateTo: null };
  }
  return {
    scope: scratchScope(selectedProjectId),
    navigateTo: nav === "sessions" ? null : "sessions",
  };
}

/**
 * What the hook does with that, named against the real seams so the sketch is
 * checkable rather than plausible:
 *
 *   const resolved = newSessionScopeForChrome(readChromeAtPressTime());
 *   if (resolved === null) return;
 *   if (resolved.navigateTo !== null)
 *     useWorkspaceStore.getState().setNav(projectId, resolved.navigateTo);
 *   kind === "chat"
 *     ? void bootChatSession(resolved.scope, { title, land })
 *     : void createTerminalSession(resolved.scope);
 *
 * Both boot paths already run under `underOwnerGuard`, which allows one create
 * per owner at a time — so the chord needs no in-flight guard of its own, and a
 * held ⌘T is already refused twice over (here by `repeat`, there by the guard).
 */

/**
 * The lab's half of the chord: binds it once, globally, through the real
 * predicate.
 *
 * ⌃T / ⌥⌃T stand in for ⌘T / ⌥⌘T because Chrome owns ⌘T and would swallow the
 * demo; Electron does not, and the drawn chord is the shipping one. The swap is
 * a two-field rewrite handed to the same predicate rather than a second copy of
 * the matching rules, so what you are operating here really is the function
 * that would ship.
 *
 * Bound ONCE, at the scratch root, and attributed to the split. The accelerator
 * is orthogonal to which control is drawn — every variant on this page would
 * ship with the same two chords — and a listener mounted per control would
 * count one chord as four Sessions.
 */
function useNewSessionChord(onStart: (kind: SessionKind) => void): void {
  const handler = React.useRef(onStart);
  handler.current = onStart;
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Field by field, never `{...event}`: a DOM event's properties live on
      // its prototype, so spreading one yields an empty object and every field
      // this predicate reads would arrive `undefined` — which typechecks (the
      // spread is KeyboardEvent-typed) and then silently answers "chat" to
      // ⌥⌃T, because `undefined` is falsy and the Option branch never runs.
      const kind = newSessionKindForKeyEvent({
        metaKey: event.ctrlKey,
        ctrlKey: false,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        key: event.key,
        code: event.code,
        repeat: event.repeat,
      });
      if (kind === null) return;
      event.preventDefault();
      handler.current(kind);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1 py-px font-mono text-label text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * Where the chords would live, and what they have to survive.
 *
 * The renderer, not `main/menu.ts`. Every app-specific shortcut this build has
 * — ⌘K, ⌘1–9, ⌘[ / ⌘], ⌥⌘B, bare "c" — is a renderer `keydown` listener over a
 * pure predicate, and `menu.ts` carries only roles and zoom. An app-menu
 * accelerator would also fire straight through the terminal-focus guard the
 * renderer path can consult, and it would put the one create verb in the app on
 * a different rail from every other verb.
 *
 * Neither chord takes the ⌘K terminal-focus guard, and that is deliberate:
 * a pty is sent Ctrl chords, not Cmd chords, so ⌘T means nothing to a shell and
 * suppressing it would break the chord exactly where a second session is most
 * often wanted. ⌘K guards because ⌘K clears a shell; ⌘T has no such twin.
 */
const NEIGHBOURS: readonly { chord: string; owner: string }[] = [
  { chord: "⌘K", owner: "command palette" },
  { chord: "⌘1–9", owner: "project rail" },
  { chord: "⌘[ ⌘]", owner: "nav back / forward" },
  { chord: "⌘B", owner: "sidebar pin (being redefined)" },
  { chord: "⌥⌘B", owner: "right rail" },
  { chord: "⌥⌘F", owner: "terminal focus (proposed)" },
  { chord: "⌘D ⌘⇧D", owner: "split, pane-scoped today" },
  { chord: "⌥⌘←↑↓→", owner: "pane nav" },
];

/**
 * The four chrome states the chord has to answer for, resolved by the real
 * function rather than described beside it — a scoping table hand-written next
 * to the predicate it documents is a table that goes stale on the first change.
 */
const CHORD_CONTEXTS: readonly { label: string; chrome: SessionChordChrome }[] = [
  {
    label: `In a ticket · ${displayTicketId(project.ticketPrefix, tickets[0]!.ticketNumber)}`,
    chrome: { selectedProjectId: project.id, openTicketId: tickets[0]!.id, nav: "board" },
  },
  {
    label: "On Sessions",
    chrome: { selectedProjectId: project.id, openTicketId: null, nav: "sessions" },
  },
  {
    label: "On the Board",
    chrome: { selectedProjectId: project.id, openTicketId: null, nav: "board" },
  },
  {
    label: "On Files",
    chrome: { selectedProjectId: project.id, openTicketId: null, nav: "files" },
  },
  {
    label: "No project",
    chrome: { selectedProjectId: null, openTicketId: null, nav: "board" },
  },
];

function AcceleratorPanel({ live }: { live: SessionKind | null }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/70 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col">
          <h3 className="text-ui font-medium text-foreground">Accelerator</h3>
          <p className="text-xs text-muted-foreground">
            the plain chord starts the default; the modified one starts the companion
          </p>
        </div>
        <span className="shrink-0 font-mono text-label text-muted-foreground">
          renderer keydown · lib/new-session-shortcut.ts
        </span>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <dl className="grid shrink-0 grid-cols-[auto_auto_1fr] items-center gap-x-3 gap-y-1.5">
          {(
            [
              { chord: "⌘T", kind: "chat" as const, gloss: "Chat — the structured default" },
              { chord: "⌥⌘T", kind: "terminal" as const, gloss: "Terminal — the manual companion" },
              { chord: "⌘⇧T", kind: null, gloss: "reserved — reopen the last closed Session" },
            ] satisfies readonly { chord: string; kind: SessionKind | null; gloss: string }[]
          ).map(({ chord, kind, gloss }) => (
            <React.Fragment key={chord}>
              <dt>
                <Kbd>{chord}</Kbd>
              </dt>
              <dd
                className={cn(
                  "size-1.5 rounded-full transition-colors duration-150 ease-out",
                  kind !== null && live === kind ? "bg-primary" : "bg-transparent",
                )}
              />
              <dd
                className={cn(
                  "text-xs",
                  kind === null ? "text-muted-foreground/60" : "text-muted-foreground",
                )}
              >
                {gloss}
              </dd>
            </React.Fragment>
          ))}
        </dl>

        <div className="flex min-w-[280px] flex-1 flex-col gap-2">
          <p className="font-mono text-label uppercase text-muted-foreground/70">
            Taken, and survived
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {NEIGHBOURS.map(({ chord, owner }) => (
              <span key={chord} className="font-mono text-label text-muted-foreground/70">
                <span className="text-muted-foreground">{chord}</span> {owner}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Try <Kbd>⌃T</Kbd> and <Kbd>⌥⌃T</Kbd> — they stand in for ⌘T and ⌥⌘T, which the browser
            owns and Electron does not. Both run the real predicate and land on the split&apos;s
            tally at zero clicks.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <p className="font-mono text-label uppercase text-muted-foreground/70">
          What it starts, per surface
        </p>
        <div className="grid grid-cols-[auto_auto_1fr] items-center gap-x-4 gap-y-1">
          {CHORD_CONTEXTS.map(({ label, chrome }) => {
            const resolved = newSessionScopeForChrome(chrome);
            return (
              <React.Fragment key={label}>
                <span className="text-xs text-muted-foreground">{label}</span>
                <span
                  className={cn(
                    "font-mono text-label",
                    resolved === null ? "text-muted-foreground/50" : "text-foreground",
                  )}
                >
                  {resolved === null
                    ? "—"
                    : resolved.scope.kind === "ticket"
                      ? "ticket-owned"
                      : "global · ticketless"}
                </span>
                <span className="font-mono text-label text-muted-foreground/70">
                  {resolved === null
                    ? "nothing starts"
                    : resolved.navigateTo === null
                      ? "stays put"
                      : `lands on ${resolved.navigateTo}`}
                </span>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/**
 * What ⌘K would have to grow to finish the keyboard story: two create verbs
 * above the destinations it lists today.
 *
 * Drawn, not wired. `command-palette.tsx` builds `{tickets, sessions}` and every
 * `onSelect` routes to something that already exists — there is no create path
 * in it at all. The chord is the fast route and this is the findable one, so
 * they are complements rather than alternatives: a chord nobody can discover
 * and a palette nobody would use twice fail in opposite directions.
 */
function PaletteProposal() {
  return (
    <div className="w-full max-w-[420px] overflow-hidden rounded-lg border border-border bg-popover">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-mono">⌘K</span>
        <span className="text-muted-foreground/70">new ses</span>
      </div>
      <div className="p-1.5">
        <p className="px-1.5 py-1 text-label font-semibold uppercase text-muted-foreground">
          Start
        </p>
        {(
          [
            { icon: ChatCircleIcon, label: "New chat", chord: "⌘T" },
            { icon: TerminalWindowIcon, label: "New terminal", chord: "⌥⌘T" },
          ] as const
        ).map(({ icon: Icon, label, chord }, index) => (
          <div
            key={label}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-1.5 py-1.5",
              index === 0 && "bg-accent",
            )}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
              <Icon weight="fill" className="size-3" />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">{label}</span>
            <span className="shrink-0 font-mono text-label text-muted-foreground">{chord}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The proposal · Split                                                        */
/* -------------------------------------------------------------------------- */

/** What the primary segment says. The open question, wired rather than argued. */
type SplitLabel = "plus-word" | "word" | "glyph";

interface SplitOptions {
  /**
   * Whether the caret segment is drawn. Off, the menu is reachable only by
   * right-click — one press cheaper in width, and completely invisible cold.
   */
  caret: boolean;
  label: SplitLabel;
  /**
   * Where the chords are announced. `"menu"` uses the menu's own shortcut slot
   * (a primitive both menus already export and nothing currently uses);
   * `"inline"` parks a kbd chip in the strip forever.
   */
  hint: "menu" | "inline";
}

/**
 * The settled drawing: caret shown, `+ Chat`, chords in the menu.
 *
 * These are defaults rather than toggle positions on purpose — the scratch
 * opens showing the design that ships, and the toggles below it exist now only
 * as the evidence for why the alternatives lose, not as a chooser.
 */
const SPLIT_DEFAULTS: SplitOptions = { caret: true, label: "plus-word", hint: "menu" };

/** The chord each kind announces in a menu's trailing slot. */
const CHORD: Record<SessionKind, string> = { chat: "⌘T", terminal: "⌥⌘T" };

/**
 * The trailing-slot override, and why there is one.
 *
 * This is the app's FIRST use of `DropdownMenuShortcut` / `ContextMenuShortcut`,
 * so it sets the pattern. What the primitives already give is right: `ml-auto`
 * puts the chord on the right edge, `text-xs` is the type scale's meta step —
 * the one for hints and counts — sitting correctly beside a `text-sm` label,
 * and `text-muted-foreground` keeps it a hint rather than a second label.
 *
 * What is wrong for these particular strings is `tracking-widest`. Letter
 * spacing is applied after the LAST glyph as well as between them, so every
 * chord sits roughly a pixel short of the right edge and the column reads inset
 * from the menu's own padding — visible precisely because `ml-auto` promised it
 * would be flush, and worse with two rows of different width stacked. Latin
 * chords ("⌘K", "esc") absorb it; the ⌥⌘ glyph pairs do not.
 *
 * Overridden at the call site because a lab scratch may not edit app source.
 * When this lands the fix belongs in the two primitives, not in every caller.
 */
const CHORD_SLOT = "tracking-normal";

/**
 * Primary segment fires; the caret admits the exception exists.
 *
 * The press-scale sits on the WRAPPER rather than on each half: `:active`
 * matches an ancestor of the pressed element, so the whole pill depresses as
 * one object. Halves scaling independently would open a seam mid-press, which
 * reads as two buttons that happen to touch — the exact thing the shape is
 * trying not to be.
 *
 * The menu repeats Chat above Terminal. Repeating the primary is the split
 * button's own convention, and here it also puts the default act on the item
 * the keyboard opens onto, which the shipped "+" menu currently has backwards.
 * Right-click reaches the same two items wherever the caret is, so turning the
 * caret off costs discoverability and never capability.
 */
function SplitControl({
  disabled,
  placement,
  onStart,
  caret = SPLIT_DEFAULTS.caret,
  label = SPLIT_DEFAULTS.label,
  hint = SPLIT_DEFAULTS.hint,
}: ControlProps & Partial<SplitOptions>) {
  const compact = placement === "rail";
  const align = placement === "strip" ? "end" : "start";
  const showShortcuts = hint === "menu";

  const primary =
    label === "glyph" ? (
      <PlusIcon weight="bold" />
    ) : (
      <>
        {label === "plus-word" ? <PlusIcon weight="bold" /> : null}
        Chat
        {hint === "inline" ? <Kbd>⌘T</Kbd> : null}
      </>
    );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "inline-flex shrink-0 items-center rounded-full transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:transform-none",
            disabled && "pointer-events-none opacity-50",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size={label === "glyph" ? (compact ? "icon-xs" : "icon-sm") : compact ? "xs" : "sm"}
            disabled={disabled}
            aria-label="New chat"
            aria-keyshortcuts="Meta+T"
            title="New chat (⌘T) — ⌥⌘T for a terminal"
            onClick={() => onStart("chat", 1)}
            className={cn(
              "active:scale-100",
              // The seam only exists when there is a second half to seam against.
              caret && "rounded-r-none pr-1.5",
            )}
          >
            {primary}
          </Button>
          {caret ? (
            <>
              <span aria-hidden className="h-3 w-px bg-border" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size={compact ? "icon-xs" : "icon-sm"}
                    disabled={disabled}
                    aria-label="Other session kinds"
                    // Narrower than a stock icon button: this segment holds one
                    // 12px caret and exists to be SEEN, not aimed at — the whole
                    // menu is also on right-click, so the tab strip pays the
                    // smallest width that still says "there is another kind".
                    className="group w-4 rounded-l-none px-0 active:scale-100"
                  >
                    <CaretDownIcon
                      weight="bold"
                      className="size-3 transition-transform duration-150 ease-out group-data-[state=open]:rotate-180 motion-reduce:transform-none"
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align={align}>
                  <DropdownMenuItem onSelect={() => onStart("chat", 2)}>
                    <ChatCircleIcon weight="fill" />
                    Chat
                    {showShortcuts ? (
                      <DropdownMenuShortcut className={CHORD_SLOT}>
                        {CHORD.chat}
                      </DropdownMenuShortcut>
                    ) : null}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onStart("terminal", 2)}>
                    <TerminalWindowIcon weight="fill" />
                    Terminal
                    {showShortcuts ? (
                      <DropdownMenuShortcut className={CHORD_SLOT}>
                        {CHORD.terminal}
                      </DropdownMenuShortcut>
                    ) : null}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={ChatCircleIcon} onSelect={() => onStart("chat", 2)}>
          Chat
          {showShortcuts ? (
            <ContextMenuShortcut className={CHORD_SLOT}>{CHORD.chat}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
        <ContextMenuItem icon={TerminalWindowIcon} onSelect={() => onStart("terminal", 2)}>
          Terminal
          {showShortcuts ? (
            <ContextMenuShortcut className={CHORD_SLOT}>{CHORD.terminal}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/* -------------------------------------------------------------------------- */
/* Alternatives it beat                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The affordance drawn as the thing it makes: a tab-shaped ghost at the strip's
 * trailing edge, and the same control as the list's last row in the rail.
 *
 * The runner-up, and it lost on diff size rather than on feel. In the strip it
 * reads as the strip's own negative space rather than as a button parked beside
 * it, and in the rail, when the list is empty, this row IS the empty state —
 * the dashed "No active sessions" box is a sign saying nothing can be done
 * here, sitting exactly where the thing to do belongs. Taking it would mean
 * restructuring `TicketSessionsPanel`'s empty state and deleting the duplicate
 * control in `sessions-layer.tsx`'s empty plane; the split is a swap at four
 * call sites. With the click cost identical, that decided it.
 */
function GhostControl({ disabled, placement, onStart }: ControlProps) {
  const strip = placement === "strip";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group flex h-7 shrink-0 items-center rounded-md border border-dashed border-border text-muted-foreground",
            "transition-[color,background-color,border-color] duration-150 ease-out",
            "hover:border-solid hover:border-border-strong hover:bg-accent/50 hover:text-foreground",
            "has-[:focus-visible]:border-solid has-[:focus-visible]:text-foreground",
            strip ? null : "w-full",
            disabled && "pointer-events-none opacity-50",
          )}
        >
          <button
            type="button"
            disabled={disabled}
            onClick={() => onStart("chat", 1)}
            className={cn(
              "flex h-full min-w-0 items-center gap-1.5 rounded-l-md pr-1 pl-2.5 text-xs outline-none",
              "transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:transform-none",
              "focus-visible:ring-[3px] focus-visible:ring-ring/50",
              strip ? null : "flex-1 justify-start",
            )}
          >
            <PlusIcon weight="bold" className="size-3 shrink-0" />
            Chat
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label="Other session kinds"
                className="flex h-full w-5 shrink-0 items-center justify-center rounded-r-md text-muted-foreground/70 outline-none transition-colors duration-150 ease-out hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:text-foreground"
              >
                <CaretDownIcon weight="bold" className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={strip ? "end" : "start"}>
              <DropdownMenuItem onSelect={() => onStart("chat", 2)}>
                <ChatCircleIcon weight="fill" />
                Chat
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onStart("terminal", 2)}>
                <TerminalWindowIcon weight="fill" />
                Terminal
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={ChatCircleIcon} onSelect={() => onStart("chat", 2)}>
          Chat
        </ContextMenuItem>
        <ContextMenuItem icon={TerminalWindowIcon} onSelect={() => onStart("terminal", 2)}>
          Terminal
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Whether Option is down right now.
 *
 * `blur` matters more than it looks: a window that loses focus while Option is
 * held never delivers the keyup, so without it the glyph would sit flipped over
 * a modifier nobody is pressing — a control lying about what a click will do.
 */
function useOptionHeld(): boolean {
  const [held, setHeld] = React.useState(false);
  React.useEffect(() => {
    const sync = (event: KeyboardEvent) => setHeld(event.altKey);
    const clear = () => setHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return held;
}

/**
 * One target, one click, and the exception costs a held key — the only variant
 * that gets a terminal to a single click. Superseded: two clicks for a terminal
 * is accepted, so the modifier is now paying its cold-discoverability cost for
 * a saving nobody asked for. Kept because the glyph morph is the honest way to
 * teach a modifier if one is ever wanted somewhere else.
 */
function ModifierControl({ disabled, placement, onStart }: ControlProps) {
  const option = useOptionHeld();
  // Deliberately carries no `size-*`: the Button primitive sizes bare `svg`
  // descendants per size variant, so leaving it off is how one control follows
  // the pill scale in both contexts instead of pinning one glyph size for both.
  const glyph =
    "col-start-1 row-start-1 transition-[opacity,transform] duration-100 ease-out motion-reduce:transition-none";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={placement === "rail" ? "icon-xs" : "icon-sm"}
          disabled={disabled}
          aria-label={option ? "New terminal" : "New chat"}
          title={option ? "New terminal" : "New chat — hold ⌥ for a terminal"}
          onClick={(event) => onStart(event.altKey ? "terminal" : "chat", 1)}
          className="shrink-0"
        >
          <span className="grid place-items-center">
            <ChatCircleIcon
              weight="fill"
              aria-hidden
              className={cn(
                glyph,
                option ? "-translate-y-1 opacity-0" : "translate-y-0 opacity-100",
              )}
            />
            <TerminalWindowIcon
              weight="fill"
              aria-hidden
              className={cn(
                glyph,
                option ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
              )}
            />
          </span>
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={ChatCircleIcon} onSelect={() => onStart("chat", 2)}>
          Chat
        </ContextMenuItem>
        <ContextMenuItem icon={TerminalWindowIcon} onSelect={() => onStart("terminal", 2)}>
          Terminal
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The chord carries the load; the button only has to be findable.
 *
 * Now that the accelerator is shipping anyway, this is what the split reduces
 * to if you also decide the pointer route can be a bare glyph: no caret, no
 * word, the chords living in a hover-revealed chip and a right-click menu. It
 * is here as the floor — the least chrome that is still operable — so the
 * split's ~76px can be judged against something, not against nothing.
 */
function KeyboardFirstControl({ disabled, placement, onStart }: ControlProps) {
  return (
    <div className="group flex shrink-0 items-center gap-1.5">
      {/* Zero resting width: the hint is the label of the faster route, revealed
          where a pointer already is, and it must not tax the quiet state. */}
      <span className="flex w-0 items-center overflow-hidden opacity-0 transition-[width,opacity] duration-150 ease-out group-hover:w-9 group-hover:opacity-100 group-focus-within:w-9 group-focus-within:opacity-100 motion-reduce:transition-none">
        <Kbd>⌘T</Kbd>
      </span>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={placement === "rail" ? "icon-xs" : "icon-sm"}
            disabled={disabled}
            aria-label="New chat"
            aria-keyshortcuts="Meta+T"
            title="New chat (⌘T) — ⌥⌘T for a terminal"
            onClick={() => onStart("chat", 1)}
          >
            <ChatCircleIcon weight="fill" />
          </Button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem icon={ChatCircleIcon} onSelect={() => onStart("chat", 2)}>
            Chat
            <ContextMenuShortcut className={CHORD_SLOT}>{CHORD.chat}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem icon={TerminalWindowIcon} onSelect={() => onStart("terminal", 2)}>
            Terminal
            <ContextMenuShortcut className={CHORD_SLOT}>{CHORD.terminal}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Shipped today — imported, not redrawn                                       */
/* -------------------------------------------------------------------------- */

function BaselineTwoButtons({ disabled, onStart }: ControlProps) {
  return (
    <TicketSessionActions
      disabled={disabled}
      onNewChat={() => onStart("chat", 1)}
      onNewTerminal={() => onStart("terminal", 1)}
    />
  );
}

function BaselinePlusMenu({ disabled, placement, onStart }: ControlProps) {
  return (
    <NewSessionMenu
      disabled={disabled}
      align={placement === "strip" ? "end" : "start"}
      onNewChat={() => onStart("chat", 2)}
      onNewSession={() => onStart("terminal", 2)}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Context frames — the two rooms every control has to work in                 */
/* -------------------------------------------------------------------------- */

interface DemoTab {
  id: string;
  kind: SessionKind;
  title: string;
  live: boolean;
}

/**
 * Three tabs off the house fixtures, both kinds, including one chat title long
 * enough to hit the strip's `max-w-40` truncation — a trailing control judged
 * against short tidy labels is judged in a strip that never happens.
 */
const DEMO_TABS: readonly DemoTab[] = [
  { id: sessions[0]!.id, kind: "terminal", title: sessions[0]!.title, live: true },
  { id: chatSessions[0]!.sessionId, kind: "chat", title: chatSessions[0]!.title, live: true },
  { id: sessions[2]!.id, kind: "terminal", title: sessions[2]!.title, live: false },
];

/** Copied verbatim from `session-tabs.tsx`'s `TabShell` — the frame, not the subject. */
function StripTab({ tab, active }: { tab: DemoTab; active: boolean }) {
  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors duration-150 ease-out",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tab.live ? (active ? "bg-primary" : "bg-positive") : "bg-muted-foreground/50",
        )}
      />
      {tab.kind === "chat" ? (
        <ChatCircleIcon weight="fill" className="size-3 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="max-w-40 truncate">{tab.title}</span>
    </div>
  );
}

/**
 * Boundary check against the specified split model — not a design of it, a
 * separate agent owns that. The model: proper window-manager semantics (split
 * right / split down, so a tree rather than a flat run), each section of a split
 * IS a tab, and the strip collapses a group past N=2 — two panes draw as two
 * merged tabs, three or more as a single `[focused tab (+n)]` chip that reveals
 * its members on hover. Opening a split may also raise a Codex-style picker of
 * what to put in it, each row carrying its own chord.
 *
 * Placement is unaffected. The control is a `shrink-0` sibling OUTSIDE the
 * scrolling tablist, and every part of that model happens inside the container,
 * so none of it can move the control.
 *
 * The overflow argument, though, inverts, and it was mine to get wrong: I
 * reasoned against a flat-N guess where grouping only ever ADDS width, and
 * concluded the tablist would overflow sooner. Collapsing does the opposite —
 * past N=2 a whole group costs one chip instead of N tabs, so a heavily split
 * project puts LESS pressure on the strip than the same sessions would flat.
 * Being outside the tablist is therefore merely correct rather than newly
 * valuable. It costs nothing either way, which is why the conclusion survives
 * the premise being wrong.
 *
 * One drawing risk, and it is cheap. A `(+n)` chip is an enclosed, tab-shaped
 * object, and a pill sitting immediately after one can read as another member of
 * it. Shape already separates them — the control is `rounded-full` where every
 * tab is `rounded-md` — but once chips exist the strip should mark "end of tabs"
 * with a wider gap or a hairline. A token, not a redesign.
 *
 * The "kinds, never destinations" rule WEAKENS rather than survives intact.
 * Splitting used to look like a different verb; under this model it produces a
 * tab too, so destination is a legitimate axis and mixing the two is a budget
 * problem rather than a category error. What replaces it is sharper, and the
 * picker argues for it rather than against it: the caret menu carries KIND,
 * because kind cannot be had any other way, and GROUPING stays on a gesture —
 * the split chord, or a modifier on the primary — because a flag on an act you
 * are already performing belongs on the gesture. A picker that asks "what goes
 * in this split?" is that same division seen from the other side: the gesture
 * supplied the grouping, the picker supplies the kind. Two items here, not a
 * 2×2, on the most repeated control in the app.
 *
 * The chords do not collide: ⌘T, ⌥⌘T and whatever splits claims are distinct
 * keys. The adjacency is semantic — both now make tabs — and it resolves on the
 * same line the menu does: ⌘T makes a STANDALONE tab, the split chord makes one
 * in the current group. The real item for whoever builds splits is that ⌘D is
 * currently pane-scoped, resolved off `data-terminal-pane-id` inside
 * `handleTerminalShortcut`, so it only fires when a TERMINAL pane holds focus.
 * Universal splits have to lift it to a surface-level chord beside ⌘T, and a
 * tree needs two directions where ⌘D/⌘⇧D today are one chord and its shifted
 * twin. Both belong in one dispatch layer with ⌘T rather than in two.
 */

/**
 * `anchor` is the only thing the strip layout has to know about a control.
 *
 * `"trailing"` is the shipped arrangement: the control is a `shrink-0` sibling
 * OUTSIDE the scrolling tablist, pinned at the right edge, so it never moves as
 * tabs open — which is the whole reason the hundredth use can be muscle memory.
 *
 * `"next"` is the ghost's claim that it is the tab that doesn't exist yet.
 * Populated it behaves exactly like `"trailing"`; empty it slides to the start,
 * where tab one is about to appear. One jump, at zero→one, bought against an
 * empty strip that otherwise reads as a stray button in the corner of nothing.
 */
function StripFrame({
  empty,
  anchor,
  children,
}: {
  empty: boolean;
  anchor: "trailing" | "next";
  children: React.ReactNode;
}) {
  const leading = empty && anchor === "next";
  return (
    <div className="flex h-9 w-full shrink-0 items-center gap-1 rounded-md border border-border bg-rail px-2">
      {leading ? children : null}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {empty
          ? null
          : DEMO_TABS.map((tab, index) => <StripTab key={tab.id} tab={tab} active={index === 0} />)}
      </div>
      {leading ? null : children}
    </div>
  );
}

/** Copied from `ticket-sessions-panel.tsx`'s `SessionRow` / `ChatSessionRow`. */
function RailRow({ tab }: { tab: DemoTab }) {
  return (
    <li className="flex w-full items-center gap-2 rounded-md border border-border/60 px-2 py-1">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-foreground">{tab.title}</span>
        <span className="truncate text-label text-muted-foreground">
          {tab.kind === "chat" ? "Chat" : "Terminal"}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-label text-muted-foreground">
        <span
          className={cn(
            "size-1.5 rounded-full",
            tab.live ? "bg-positive" : "bg-muted-foreground/50",
          )}
        />
        {tab.live ? "Working" : "Idle"}
      </span>
    </li>
  );
}

/**
 * The ticket rail's Sessions panel at its real 300px.
 *
 * `slot` is the one structural difference between the approaches: a chrome
 * control belongs in the header beside the SESSIONS label, and a list control
 * belongs at the end of the list — where it also swallows the empty state,
 * since a row that starts a Session and a box that says none exist are
 * competing for the same place for the same reason.
 */
function RailFrame({
  empty,
  slot,
  children,
}: {
  empty: boolean;
  slot: "header" | "list";
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-[300px] shrink-0 flex-col rounded-md border border-border px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-label font-medium uppercase text-muted-foreground">Sessions</h2>
        {slot === "header" ? children : null}
      </div>
      <div className="mt-3 flex flex-col gap-1">
        {empty && slot === "header" ? (
          <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border py-6 text-center">
            <TerminalWindowIcon weight="fill" className="size-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">No active sessions</p>
          </div>
        ) : null}
        {empty ? null : (
          <ul className="flex flex-col gap-1">
            {DEMO_TABS.map((tab) => (
              <RailRow key={tab.id} tab={tab} />
            ))}
          </ul>
        )}
        {slot === "list" ? children : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The card, and the tally that settled it                                     */
/* -------------------------------------------------------------------------- */

interface Tally {
  chat: number;
  terminal: number;
  clicks: number;
}

const NO_TALLY: Tally = { chat: 0, terminal: 0, clicks: 0 };

function TallyReadout({ tally }: { tally: Tally }) {
  const started = tally.chat + tally.terminal;
  return (
    <span className="shrink-0 font-mono text-label tabular-nums text-muted-foreground">
      {started === 0
        ? "—"
        : `${tally.chat}c ${tally.terminal}t · ${tally.clicks} clicks · ${(tally.clicks / started).toFixed(2)}/session`}
    </span>
  );
}

function VariantCard({
  name,
  cost,
  bet,
  home,
  empty,
  tally,
  renderControl,
  aside: Aside,
  proposal = false,
}: {
  name: string;
  /** Clicks to the common case, then to the exception. The headline number. */
  cost: string;
  /** What this approach is betting on, in one clause. */
  bet: string;
  /**
   * Where the control belongs, which is one decision and not two: `"chrome"`
   * puts it beside the rail's list and at the strip's trailing edge, `"list"`
   * makes it the list's last row (and therefore its empty state) and the
   * strip's next-tab slot. Both frames read it, so a variant cannot end up
   * living in the list in one context and beside it in the other.
   */
  home: "chrome" | "list";
  empty: boolean;
  tally: Tally;
  renderControl(placement: Placement): React.ReactNode;
  aside?: React.ComponentType;
  proposal?: boolean;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4",
        proposal ? "border-primary/40" : "border-border/70",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col">
          <h3 className="text-ui font-medium text-foreground">{name}</h3>
          <p className="text-xs text-muted-foreground">{bet}</p>
        </div>
        <div className="flex shrink-0 items-baseline gap-3">
          <span className="font-mono text-label text-muted-foreground/80">{cost}</span>
          <TallyReadout tally={tally} />
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-[420px] flex-1 flex-col gap-2">
          <p className="font-mono text-label uppercase text-muted-foreground/70">
            Sessions · strip
          </p>
          <StripFrame empty={empty} anchor={home === "list" ? "next" : "trailing"}>
            {renderControl("strip")}
          </StripFrame>
          {Aside ? <Aside /> : null}
        </div>
        <div className="flex flex-col gap-2">
          <p className="font-mono text-label uppercase text-muted-foreground/70">Ticket · rail</p>
          <RailFrame empty={empty} slot={home === "list" ? "list" : "header"}>
            {renderControl("rail")}
          </RailFrame>
        </div>
      </div>
    </section>
  );
}

interface Variant {
  id: string;
  name: string;
  cost: string;
  bet: string;
  Control: React.ComponentType<ControlProps>;
  home: "chrome" | "list";
}

const ALTERNATIVES: readonly Variant[] = [
  {
    id: "ghost",
    name: "Ghost — runner-up",
    cost: "chat 1 · terminal 2",
    bet: "the affordance lives where its result will, and eats the empty state",
    Control: GhostControl,
    home: "list",
  },
  {
    id: "modifier",
    name: "Modifier",
    cost: "chat 1 · terminal 1 + ⌥",
    bet: "one target forever; holding ⌥ teaches the exception on the spot",
    Control: ModifierControl,
    home: "chrome",
  },
  {
    id: "keyboard",
    name: "Keyboard-first — the floor",
    cost: "chat 0 (⌘T) or 1 · terminal 0 (⌥⌘T) or 2",
    bet: "the chord does the work, so the pointer route can be a bare glyph",
    Control: KeyboardFirstControl,
    home: "chrome",
  },
];

const BASELINES: readonly Variant[] = [
  {
    id: "baseline-two-buttons",
    name: "Two buttons — ticket, today",
    cost: "chat 1 · terminal 1",
    bet: "both kinds are peers, and the width is worth the click",
    Control: BaselineTwoButtons,
    home: "chrome",
  },
  {
    id: "baseline-plus-menu",
    name: "Plus menu — Sessions, today",
    cost: "chat 2 · terminal 2",
    bet: "neither kind is hidden, and the click is cheap because it is rare",
    Control: BaselinePlusMenu,
    home: "chrome",
  },
];

/* -------------------------------------------------------------------------- */
/* Lab chrome                                                                  */
/* -------------------------------------------------------------------------- */

function SegmentedToggle<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  /**
   * `NoInfer` because a `useState` setter is `(value: T | ((prev: T) => T)) => void`;
   * left as an inference site it drags `T` up to `string` and the toggle stops
   * being type-safe about its own options.
   */
  onChange(next: NoInfer<T>): void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-label uppercase text-muted-foreground">{label}</span>
      <div className="flex items-center gap-0.5 rounded-full border border-border p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className="rounded-full px-2.5 py-0.5 text-label text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface StartEvent {
  seq: number;
  variantId: string;
  kind: SessionKind;
  clicks: number;
}

export default function SessionStartControlsScratch() {
  const [empty, setEmpty] = React.useState<"populated" | "empty">("populated");
  const [starting, setStarting] = React.useState<"idle" | "starting">("idle");
  const [caret, setCaret] = React.useState<"caret" | "bare">("caret");
  const [label, setLabel] = React.useState<SplitLabel>("plus-word");
  const [hint, setHint] = React.useState<"menu" | "inline">("menu");
  const [tallies, setTallies] = React.useState<Record<string, Tally>>({});
  const [log, setLog] = React.useState<readonly StartEvent[]>([]);
  const [chorded, setChorded] = React.useState<SessionKind | null>(null);

  const start = React.useCallback((variantId: string, kind: SessionKind, clicks: number) => {
    setTallies((current) => {
      const previous = current[variantId] ?? NO_TALLY;
      return {
        ...current,
        [variantId]: {
          chat: previous.chat + (kind === "chat" ? 1 : 0),
          terminal: previous.terminal + (kind === "terminal" ? 1 : 0),
          clicks: previous.clicks + clicks,
        },
      };
    });
    setLog((current) => [
      { seq: (current[0]?.seq ?? 0) + 1, variantId, kind, clicks },
      ...current.slice(0, 7),
    ]);
  }, []);

  // The chord lands on the split's tally at zero clicks, and lights its row in
  // the accelerator table for a moment so a press that produced nothing visible
  // in a scrolled-away card is still legible as a press.
  const onChord = React.useCallback(
    (kind: SessionKind) => {
      start("split", kind, 0);
      setChorded(kind);
    },
    [start],
  );
  useNewSessionChord(onChord);
  React.useEffect(() => {
    if (chorded === null) return;
    const id = setTimeout(() => setChorded(null), 600);
    return () => clearTimeout(id);
  }, [chorded]);

  const isEmpty = empty === "empty";
  const isStarting = starting === "starting";

  const card = (variant: Variant) => (
    <VariantCard
      key={variant.id}
      name={variant.name}
      cost={variant.cost}
      bet={variant.bet}
      home={variant.home}
      empty={isEmpty}
      tally={tallies[variant.id] ?? NO_TALLY}
      renderControl={(placement) => (
        <variant.Control
          disabled={isStarting}
          placement={placement}
          onStart={(kind, clicks) => start(variant.id, kind, clicks)}
        />
      )}
    />
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border/70 px-3 py-2.5">
        <SegmentedToggle
          label="List"
          value={empty}
          onChange={setEmpty}
          options={[
            { value: "populated", label: "Populated" },
            { value: "empty", label: "Empty" },
          ]}
        />
        <SegmentedToggle
          label="Boot"
          value={starting}
          onChange={setStarting}
          options={[
            { value: "idle", label: "Idle" },
            { value: "starting", label: "Starting" },
          ]}
        />
        <button
          type="button"
          onClick={() => {
            setTallies({});
            setLog([]);
          }}
          className="rounded-full border border-border px-2.5 py-0.5 text-label text-muted-foreground transition-colors duration-150 ease-out hover:border-border-strong hover:text-foreground"
        >
          reset tally
        </button>
        <p className="min-w-0 flex-1 truncate text-right font-mono text-label text-muted-foreground/70">
          {log.length === 0
            ? "start a few of each — the average is the argument"
            : log.map((event) => `${event.variantId}:${event.kind[0]}${event.clicks}`).join("  ")}
        </p>
      </div>

      <p className="font-mono text-label uppercase text-muted-foreground/70">Proposal</p>

      {/* Settled, and kept as evidence rather than as a chooser: these open on
          the shipping drawing, and moving one shows what it would have cost.
          All three change the split's resting width in a tab strip, which is
          the only place any of them was ever decidable. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border/70 px-3 py-2.5">
        <SegmentedToggle
          label="Caret"
          value={caret}
          onChange={setCaret}
          options={[
            { value: "caret", label: "Shown" },
            { value: "bare", label: "Right-click only" },
          ]}
        />
        <SegmentedToggle
          label="Label"
          value={label}
          onChange={setLabel}
          options={[
            { value: "plus-word", label: "+ Chat" },
            { value: "word", label: "Chat" },
            { value: "glyph", label: "+" },
          ]}
        />
        <SegmentedToggle
          label="Hint"
          value={hint}
          onChange={setHint}
          options={[
            { value: "menu", label: "In the menu" },
            { value: "inline", label: "Inline kbd" },
          ]}
        />
      </div>

      <VariantCard
        proposal
        name="Split"
        cost="chat 1 · terminal 2 · either at 0 with the chord"
        bet="the caret names the exception without giving it equal weight"
        home="chrome"
        empty={isEmpty}
        tally={tallies.split ?? NO_TALLY}
        renderControl={(placement) => (
          <SplitControl
            disabled={isStarting}
            placement={placement}
            caret={caret === "caret"}
            label={label}
            hint={hint}
            onStart={(kind, clicks) => start("split", kind, clicks)}
          />
        )}
      />

      <AcceleratorPanel live={chorded} />
      <PaletteProposal />

      <p className="mt-2 font-mono text-label uppercase text-muted-foreground/70">
        Alternatives it beat
      </p>
      {ALTERNATIVES.map(card)}

      <p className="mt-2 font-mono text-label uppercase text-muted-foreground/70">Shipped today</p>
      {BASELINES.map(card)}
    </div>
  );
}
