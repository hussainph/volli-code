import * as React from "react";

import { ArmedRunWindows } from "@renderer/components/automations/armed-run-window";
import { hasVisibleNativePlane } from "@renderer/components/browser/browser-plane-freeze";
import { ChromeBar } from "@renderer/components/chrome-bar";
import { HarnessTrustDialog } from "@renderer/components/harness/harness-trust-dialog";
import { NewTicketDialog } from "@renderer/components/board/new-ticket-dialog";
import { MainContent } from "@renderer/components/pages/main-content";
import { ProjectRail } from "@renderer/components/rail/project-rail";
import { SessionDetailDialog } from "@renderer/components/sessions/session-detail-dialog";
import {
  armRevealClock,
  CLOSE_MS,
  OPEN_MS,
  useEdgeReveal,
  ZONE_TOP_DEAD_BAND,
  ZONE_WIDTH,
} from "@renderer/components/sidebar/edge-reveal";
import {
  type ContentMotionJourney,
  isContentMoving,
  planContentMotion,
} from "@renderer/components/sidebar/content-motion";
import { PrimarySidebar } from "@renderer/components/sidebar/primary-sidebar";
import {
  LIVE_WIDTH_PROPERTY,
  SidebarResizeHandle,
} from "@renderer/components/sidebar/sidebar-resize-handle";
import { Sidebar, SidebarInset, SidebarProvider } from "@renderer/components/ui/sidebar";
import { Toaster } from "@renderer/components/ui/sonner";
import { UpdateInstallDialog } from "@renderer/components/update/update-install-dialog";
import { useFullScreen } from "@renderer/hooks/use-fullscreen";
import { useNavHistory } from "@renderer/hooks/use-nav-history";
import { useNewTicketShortcut } from "@renderer/hooks/use-new-ticket-shortcut";
import { useProjectRootsSync } from "@renderer/hooks/use-project-roots-sync";
import { useProjectShortcuts } from "@renderer/hooks/use-project-shortcuts";
import { useNotificationTargetReport } from "@renderer/hooks/use-notification-target";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useBootNotice, useCliLaunchNotice } from "@renderer/hooks/use-startup-notices";
import { useZoomCommands } from "@renderer/hooks/use-zoom-commands";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

const WORKSPACE_RAIL_WIDTH = 60;
/** globals.css `--shell-inset`, in the one place TS has to agree with it. */
const SHELL_INSET = 8;
/** The standing hint, in the canvas gutter the framed card already leaves bare. */
const SLIVER_WIDTH = 6;
/**
 * How far past the clip line the panel parks, so its shadow leaves too. The
 * widest either surface throws sideways is `--shadow-overlay`'s `44px` blur at
 * `-8px` spread — 44/2 − 8 = 14px — and `--shadow-card` reaches 9; 16 clears
 * both with a pixel to spare and nothing to gain by growing.
 */
const SHADOW_ALLOWANCE = 16;
/**
 * How far the panel's clip is let out on the three sides that are NOT the rail,
 * matching the number the seam's own `clip-path` uses (globals.css). Wide enough
 * that no shadow ever reaches it, so those three edges behave as if unclipped.
 */
const CLIP_SPILL = 60;
/**
 * How much wider the arming strip gets when the workspace rail is down. With
 * the rail standing, {@link ZONE_WIDTH} is the gutter the rail already leaves
 * and the sliver says where to aim. With the rail down that same 8px is the
 * bare window edge — in a windowed window, an invisible line floating
 * mid-screen, in exactly the state the reveal is most needed and hardest to
 * fire. The extra is one shell inset: 16px total, still only 8px into the
 * card's own border-and-radius margin, where no page draws anything
 * interactive — an aim tolerance, not a new trigger surface.
 */
const RAIL_OFF_ZONE_EXTRA = SHELL_INSET;

/** A live journey, plus the handle and endpoints only the DOM side needs. */
type ContentMotionRecord = ContentMotionJourney & {
  animation: Animation;
  from: number;
  to: number;
};

/**
 * The live used value of a WAAPI standalone `translate`, in this row's CSS px.
 *
 * The computed style is the truth — it is what the compositor is drawing — but
 * a `translate` that has not resolved yet parses as `NaN`, so the running
 * animation's own progress is the second reading rather than a guess.
 */
function liveTranslateX(element: HTMLElement, motion: ContentMotionRecord): number {
  const parsed = Number.parseFloat(getComputedStyle(element).translate);
  if (Number.isFinite(parsed)) return parsed;
  const progress = motion.animation.effect?.getComputedTiming().progress;
  return typeof progress === "number"
    ? motion.from + (motion.to - motion.from) * progress
    : motion.from;
}

/**
 * Moves the content half of a pin/unpin without animating its layout width.
 *
 * The final layouts still differ — a pinned sidebar genuinely gives the content
 * less room — so transform-only cannot mean "never resize". It means resize
 * once at an endpoint where the changed right edge is outside the viewport:
 *
 * - open: keep the unpinned (wide) layout, translate it right, then atomically
 *   reserve the gap and remove the equal translate;
 * - close: atomically release the gap under an equal translate, then animate
 *   that translate back to zero.
 *
 * WAAPI is deliberate rather than an rAF writer. Once started, Chromium can run
 * a `translate` animation on the compositor while renderer JS is starved — the
 * exact condition this path has to survive.
 *
 * Everything this hook DECIDES lives in `sidebar/content-motion.ts`, under the
 * coverage gate. What stays here is the part only a browser can do: measuring
 * the two boxes, running the animation, and holding React state.
 */
function useSidebarContentMotion({
  pinned,
  instant,
  panelRef,
}: {
  pinned: boolean;
  instant: boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
}): {
  contentRef: React.RefObject<HTMLElement | null>;
  layoutPinned: boolean;
  moving: boolean;
} {
  const contentRef = React.useRef<HTMLElement | null>(null);
  const [layoutPinned, setLayoutPinned] = React.useState(pinned);
  const [animating, setAnimating] = React.useState(false);
  const targetRef = React.useRef(pinned);
  const closingFromRef = React.useRef<number | null>(null);
  const motionRef = React.useRef<ContentMotionRecord | null>(null);

  React.useLayoutEffect(() => {
    const content = contentRef.current;
    const panel = panelRef.current;
    const record = motionRef.current;

    const settle = (next: boolean): void => {
      targetRef.current = pinned;
      closingFromRef.current = null;
      record?.animation.cancel();
      motionRef.current = null;
      setAnimating(false);
      if (layoutPinned !== next) setLayoutPinned(next);
    };

    // No surface yet, or a host with no WAAPI: the endpoint is the whole
    // journey. Answered here rather than in the planner because it is a fact
    // about the document, not a rule about the gesture.
    if (content === null || panel === null || typeof content.animate !== "function") {
      settle(pinned);
      return;
    }

    const plan = planContentMotion(
      {
        pinned,
        target: targetRef.current,
        layoutPinned,
        instant,
        journey: record,
        closingFrom: closingFromRef.current,
      },
      // Called at most once, and only on a pass that is going to move
      // something — see `MeasureContentMotion` for why that matters.
      () => ({
        // `offsetWidth` is one deliberate endpoint read, not a frame-loop read.
        // In floating mode the panel box has the shell inset taken off; add it
        // back to recover the exact `--panel-w` that the spacer reserves. The
        // unpinned card already starts one shell inset inside the row and the
        // pinned seam starts flush after the spacer, so the visible left edges
        // are `--panel-w - --shell-inset` apart, not a whole panel width.
        travel: panel.offsetWidth + (pinned ? 0 : SHELL_INSET) - SHELL_INSET,
        at: record === null ? 0 : liveTranslateX(content, record),
      }),
    );

    switch (plan.kind) {
      case "hold":
        return;
      case "settle":
        settle(plan.layoutPinned);
        return;
      case "clear-fill":
        record?.animation.cancel();
        motionRef.current = null;
        setAnimating(false);
        return;
      case "release-layout":
        // The parked translate is held by whatever is on the element now: a
        // landed opening's `fill: "forwards"`, or nothing at all when the
        // layout is already where the transform would put it. Either way the
        // animation that walks it back to zero starts on the next pass, from
        // `closingFrom`.
        targetRef.current = pinned;
        closingFromRef.current = plan.from;
        setAnimating(true);
        setLayoutPinned(false);
        return;
      case "animate": {
        targetRef.current = pinned;
        closingFromRef.current = null;
        record?.animation.cancel();
        setAnimating(true);
        const animation = content.animate(
          [{ translate: `${plan.from}px 0px` }, { translate: `${plan.to}px 0px` }],
          {
            duration: pinned ? OPEN_MS : CLOSE_MS,
            easing: getComputedStyle(content).getPropertyValue("--ease-swift").trim(),
            fill: "forwards",
          },
        );
        const started: ContentMotionRecord = {
          animation,
          from: plan.from,
          to: plan.to,
          targetPinned: pinned,
          settling: false,
        };
        motionRef.current = started;
        animation.onfinish = () => {
          if (motionRef.current !== started) return;
          // BOTH directions commit their layout here, and the symmetry is
          // load-bearing rather than tidy. An opening holds its transform while
          // React pins the layout underneath it; a close releases the layout it
          // already released before it started. That second one reads as
          // redundant and is exactly what was missing when a close could inherit
          // a landed opening's record and leave the spacer reserved forever.
          if (started.targetPinned) {
            started.settling = true;
            setLayoutPinned(true);
            return;
          }
          animation.cancel();
          motionRef.current = null;
          setAnimating(false);
          setLayoutPinned(false);
        };
        return;
      }
    }
  }, [instant, layoutPinned, panelRef, pinned]);

  React.useEffect(
    () => () => {
      motionRef.current?.animation.cancel();
      motionRef.current = null;
    },
    [],
  );

  return { contentRef, layoutPinned, moving: isContentMoving({ animating, layoutPinned, pinned }) };
}

/**
 * Window shell: the chrome band, the workspace rail, the sidebar panel and the
 * content card.
 *
 * THE PANEL IS SUMMONED, NOT DOCKED. The collapsed sidebar used to be a 57px
 * icon strip, and that strip charged the viewport for a list of PAGES forever
 * while the thing you came back for — which sessions are running — was only ever
 * inside the expanded pane. A strip that is neither the content nor free is the
 * worst of the three options, so collapsed is now genuinely zero: the panel is
 * an overlay summoned by the pointer at the window's left edge (see
 * `edge-reveal.ts` for when a pointer there MEANS that) and pinned into the
 * layout by ⌘B or the chrome-band trigger.
 *
 * THE WORKSPACE RAIL IS CHROME, NOT SIDEBAR. It is a flow sibling of the panel
 * rather than a tier inside it, owned solely by `workspaceRailHidden`, and it
 * never rides in the panel's tow. That is one toggle governing one thing: an
 * earlier arrangement had `WorkspaceRailToggle` say "show the switcher" while
 * the switcher only STOOD when the panel happened to be pinned, which is two
 * controls, four states and only two of them coherent. All four combinations now
 * mean exactly what they say:
 *
 *   rail on  + pinned    rail 0–60, panel docked 60–318, content from 318
 *   rail on  + unpinned  rail 0–60, panel floating, content from 68
 *   rail off + pinned    panel docked 0–258, content from 258
 *   rail off + unpinned  panel floating, content from 8
 *
 * The panel is one width in all four — `sidebarWidth` is the two-tier width and
 * the rail's 60 comes off it — so hiding the rail returns its width to the
 * canvas rather than widening the panel, and a panel you sized while it floated
 * is the panel you get when you pin it.
 *
 * THE TWO RECTANGLES COINCIDE, which is what makes pinning a content animation
 * rather than a sidebar one. Docked, the panel's box is full-bleed and
 * globals.css insets `[data-volli-sidebar]` by 8px to draw the seam. Floating,
 * the box is itself inset by 8px and the pane sits flush inside it. Both land
 * the visible card on the same rectangle, so nothing about the sidebar's RESTING
 * place moves on ⌘B — the reveal and the content presentation slide in concert.
 *
 * TWO REVEALS, ONE SLIDE, AND A CLIP THAT SEPARATES THEM. A pin and a hover peek
 * are different gestures and read differently — a pin PUSHES (the spacer takes
 * the panel's width and the content card walks right in step with it), a peek
 * FLOATS (the spacer never moves and the panel passes over the card). What they
 * are not allowed to differ on is where the panel may paint, and the first
 * version let both of them travel the whole way back to the window edge, which
 * meant the panel crossed the workspace rail — 60px of somebody else's chrome —
 * on every open and every close. That is what read as "clipping through the
 * workspace picker", and it was worst on a pin, where the panel is supposed to
 * be arriving into a dock rather than flying over the room.
 *
 * The fix is a clip, not a second animation. The panel travels inside a wrapper
 * that does not move, clipped flush at `panelLeft` — the rail's right edge, or
 * the window's when the rail is down — and let out by {@link CLIP_SPILL} on the
 * other three sides so its shadow still behaves. The wrapper is the whole point,
 * and two plausible ways of writing it are wrong for reasons only a browser will
 * tell you: a `clip-path` on the panel itself rides the panel's own transform
 * and clips nothing, and a `clip-path` on the wrapper forms a backdrop root that
 * silently disables the peek's glass. Both are written up on the element. The
 * panel parks just past the wall rather than past the whole window, so
 * "hidden" costs its own width plus {@link SHADOW_ALLOWANCE} instead of the
 * journey back to zero. The panel now emerges FROM the rail's edge and withdraws
 * into it, in both modes and both directions, and its left edge is never a thing
 * the eye can catch crossing something else. The transform is still the only
 * property that animates, which is what keeps a clip affordable: `clip-path` is
 * static here, so it costs one raster property on an already-promoted layer and
 * nothing per frame.
 *
 * PINNING IS ONE JOURNEY WITH TWO HALVES, so the halves share a clock — but no
 * longer a layout property. The panel was already compositor-only; the hidden
 * cost was its flow spacer animating `width`, which resized every terminal and
 * editor on every frame. The content half now travels on a WAAPI `translate`
 * while its inline geometry stays at one endpoint, then the spacer snaps where
 * that transform leaves it. Opening keeps the wide unpinned surface until the
 * journey lands and clips its translated overflow at the window edge; closing
 * expands it before the journey starts, under an equal inverse translate. The
 * visible left and right edges follow the same path, but expensive descendants
 * see one settled resize instead of ten. See `useSidebarContentMotion` below.
 *
 * ChromeBar owns the top 40px of window chrome and sits above the rail + panel +
 * content row, so SidebarProvider lays out as a column (h-svh, not the stock
 * min-h-svh row) with ChromeBar first.
 */
export function AppShell({ mainContent }: { mainContent?: React.ReactNode } = {}) {
  useProjectShortcuts();
  useNewTicketShortcut();
  useNavHistory();
  useProjectRootsSync();
  useZoomCommands();
  useBootNotice();
  useCliLaunchNotice();
  // What this window is showing, reported to main so an alert for a Session or
  // ticket already in front of the person is not also posted by the OS (VC-295).
  useNotificationTargetReport();
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const workspaceRailHidden = useUiStore((state) => state.workspaceRailHidden);
  const pinChoice = useUiStore((state) => state.sidebarPinned);
  const setSidebarPinned = useUiStore((state) => state.setSidebarPinned);
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const uiScale = useUiStore((state) => state.uiScale);
  const fullScreen = useFullScreen();
  const [resizing, setResizing] = React.useState(false);
  const [geometryInstant, setGeometryInstant] = React.useState(false);
  const [nativePlaneInstant, setNativePlaneInstant] = React.useState(false);
  const [pinSuspended, setPinSuspended] = React.useState(false);
  const terminalFocused = terminalFocusTarget !== null;
  // What the layout below reads. The stored choice, minus a suspension nothing
  // durable ever hears about — see the fullscreen effect.
  const pinned = pinChoice && !pinSuspended;
  // The pin as the CONTENT half sees it. Terminal focus hands the whole canvas
  // to a PTY, so it is an unpin that no stored choice records.
  const docked = pinned && !terminalFocused;

  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const zoneRef = React.useRef<HTMLDivElement | null>(null);
  const bandRef = React.useRef<HTMLDivElement | null>(null);

  const reveal = useEdgeReveal({
    enabled: !pinned && !terminalFocused,
    panelRef,
    zoneRef,
    bandRef,
  });

  const railWidth = workspaceRailHidden || terminalFocused ? 0 : WORKSPACE_RAIL_WIDTH;
  const railHidden = workspaceRailHidden || terminalFocused;
  // `sidebarWidth` stores the full two-tier width and the panel is always what
  // is left after the rail's fixed 60, whether or not the rail is on screen —
  // but that subtraction now happens once, in CSS, as `--panel-w` below, so a
  // drag can move every box that depends on it without re-rendering anything.
  const panelLeft = railWidth;
  const floatingInset = pinned ? 0 : SHELL_INSET;
  const panelShown = !terminalFocused && (pinned || reveal.visible);
  // Native child views composite above every renderer z-index. Keep the marker
  // through the floating panel's exit transition as well as its open state, or
  // the Browser plane would jump in front for the final 160ms of withdrawal.
  const [floatingOverlayExiting, setFloatingOverlayExiting] = React.useState(false);
  const previousPanelShown = React.useRef(panelShown);
  React.useLayoutEffect(() => {
    const wasShown = previousPanelShown.current;
    previousPanelShown.current = panelShown;
    if (pinned || terminalFocused || panelShown || nativePlaneInstant) {
      setFloatingOverlayExiting(false);
    } else if (wasShown) {
      setFloatingOverlayExiting(true);
    }
  }, [nativePlaneInstant, panelShown, pinned, terminalFocused]);
  // How far past `-100%` the panel parks to be gone. Only far enough to clear
  // the clip line, because the clip is what "gone" now means: its own width
  // lands the right edge on the panel box's own left edge, `floatingInset` puts
  // that edge on the clip line itself (floating, the box starts 8px inside it),
  // and the allowance takes the shadow with it. This used to have to cover
  // `panelLeft` as well — the whole distance back to the window — for the one
  // reason the clip has since taken away.
  const hiddenShift = floatingInset + SHADOW_ALLOWANCE;

  // Showing or hiding the switcher moves the inline panel box by 60px. That box
  // must snap: half a move animating while its sibling half snaps is worse than
  // none of it. Terminal focus has the same requirement, so both hold the
  // existing `data-motion=instant` hatch through the first settled frame.
  const previousGeometry = React.useRef({ railWidth, terminalFocused });
  const geometryChanged =
    previousGeometry.current.railWidth !== railWidth ||
    previousGeometry.current.terminalFocused !== terminalFocused;
  React.useLayoutEffect(() => {
    const previous = previousGeometry.current;
    if (previous.railWidth === railWidth && previous.terminalFocused === terminalFocused) return;
    previousGeometry.current = { railWidth, terminalFocused };
    setGeometryInstant(true);
    const frame = window.requestAnimationFrame(() => setGeometryInstant(false));
    return () => window.cancelAnimationFrame(frame);
  }, [railWidth, terminalFocused]);

  /* THE NATIVE-PLANE EXCEPTION, and it is a hatch of its OWN.
   *
   * A live WebContentsView is a child of the window, not a node in this
   * document, so it cannot ride the content surface's transform. While one is on
   * screen the pin takes both endpoints directly instead: `nativePlaneInstant`
   * settles the content half, and `data-pin-motion` below freezes the panel
   * half, for the one frame it takes them to commit.
   *
   * Deliberately NOT folded into `data-motion=instant`. That hatch belongs to
   * terminal focus and rail geometry, it is read by the sidebar primitive's own
   * width transitions, and its contract is one frame of snapped GEOMETRY — not
   * "nothing in this shell may animate". Overloading it made ⌘B silently
   * animation-free whenever a Browser Tab was on screen, which is a different
   * promise from the one that attribute makes.
   *
   * Armed off the resolved pin TARGET rather than inside the ⌘B handler, because
   * that handler was never the only writer: Settings' "Keep the sidebar open"
   * switch calls the store directly, and the fullscreen suspension is not a
   * control at all. A guard living at one control is a guard the other two walk
   * past. Watching the target catches every writer there will ever be, at a cost
   * of one commit of arming that React flushes before paint — the journey the
   * first commit starts is cancelled by the second, and no frame is painted in
   * between. */
  const previousDocked = React.useRef(docked);
  React.useLayoutEffect(() => {
    if (previousDocked.current === docked) return;
    previousDocked.current = docked;
    if (hasVisibleNativePlane(document)) setNativePlaneInstant(true);
  }, [docked]);

  // Hold the suppression through the first paint of the endpoint swap, then let
  // go. The Browser owner can replace this exception with a capture/ready
  // protocol; starting a DOM transform before its native view is hidden visibly
  // detaches page pixels from the Browser chrome for up to the capture deadline.
  React.useLayoutEffect(() => {
    if (!nativePlaneInstant) return;
    const frame = window.requestAnimationFrame(() => setNativePlaneInstant(false));
    return () => window.cancelAnimationFrame(frame);
  }, [nativePlaneInstant]);

  const reducedMotion = useReducedMotion();
  const contentMotion = useSidebarContentMotion({
    pinned: docked,
    // A resize drag needs exact pointer tracking, and terminal/rail geometry has
    // always owned the shell's instant escape hatch. Settle any in-flight pin
    // journey before either changes the width token underneath it.
    instant:
      resizing ||
      terminalFocused ||
      geometryInstant ||
      geometryChanged ||
      nativePlaneInstant ||
      reducedMotion,
    panelRef,
  });
  // The spacer still owns the final layout, but it now has only two values and
  // never transitions between them. Opening snaps it under the translated
  // content at the end; closing releases it under an equal translate at the
  // start. A drag remains CSS-only because the reserved value is the same live
  // `--panel-w` custom property as every other sidebar box.
  const gapWidth = contentMotion.layoutPinned ? "var(--panel-w)" : "0px";
  // Native child views do not inherit renderer transforms. Use the same captured
  // stand-in path as a floating sidebar while the whole content surface moves.
  const nativePlaneOverlay =
    (!pinned && (panelShown || floatingOverlayExiting)) || contentMotion.moving;

  /* Fullscreen SUSPENDS the pin; it does not answer it.
   *
   * Entering fullscreen is an explicit "give me the content", so unpinning is
   * reading the room — but it is an inference read off a window mode, and it has
   * no business outliving the window. Written through `setSidebarPinned` it did:
   * that key persists (stores/ui.ts), so pinning the panel, entering fullscreen
   * and quitting there left `false` on disk, and the next launch opened WINDOWED
   * with the panel gone and nothing anywhere recording that the user never asked
   * for it. Durable storage answers "what did they choose".
   *
   * So the suspension is local state that dies with the process, the stored
   * choice is untouched, and leaving fullscreen simply lifts it — no remembered
   * value to restore, because nothing was overwritten. A deliberate ⌘B inside
   * fullscreen still wins, and now for the plain reason rather than a bookkeeping
   * one: `setPinned` lifts the suspension and writes the choice, so from that
   * moment the panel is answering the user rather than the window. */
  const previousFullScreen = React.useRef(fullScreen);

  React.useEffect(() => {
    if (previousFullScreen.current === fullScreen) return;
    previousFullScreen.current = fullScreen;
    setPinSuspended(fullScreen);
  }, [fullScreen]);

  const setPinned = React.useCallback(
    (next: boolean) => {
      setPinSuspended(false);
      // A deliberate pin toggle uses the full base clock. CSS retargets the
      // panel from its live value if the direction changes; the content hook
      // separately samples its live WAAPI translate before reversing.
      armRevealClock(panelRef.current, next, true);
      setSidebarPinned(next);
    },
    [setSidebarPinned],
  );

  /**
   * The subtrees this shell only ever MOVES, held at one element identity so
   * React stops re-rendering them when it moves them.
   *
   * Every hover peek and every pin sets state in this component, and a shell
   * that re-renders re-renders its children — so a pointer resting for a moment
   * in an 8px strip was re-rendering the board, the ticket surface, the chat
   * transcripts and the session layer, twice (in, then out), for a change that
   * moves one panel by a transform. Measured in the lab shell, which carries a
   * fraction of the app's tree: ~99ms of script per toggle. None of these four
   * read anything from this render — the shell's geometry reaches them as CSS,
   * never as props — so holding the elements is not a memoisation guess about
   * what MIGHT be equal; it is the honest statement that they are the same
   * elements in a different box. Anything they genuinely depend on they
   * subscribe to themselves, and a context change (the pin, via
   * `SidebarProvider`) still reaches its consumers through this.
   */
  const railContent = React.useMemo(() => <ProjectRail />, []);
  const paneContent = React.useMemo(() => <PrimarySidebar />, []);
  const chrome = React.useMemo(() => <ChromeBar />, []);
  const content = React.useMemo(() => <MainContent override={mainContent} />, [mainContent]);

  return (
    <SidebarProvider
      // `open` IS the pin now: the icon strip is gone, so nothing reads a
      // collapsed presentation any more and the primitive's own vocabulary
      // means the one thing left. This is what routes the real ⌘B and the
      // unmodified chrome-band trigger into the new model.
      open={pinned}
      onOpenChange={setPinned}
      // No fill of its own: the canvas IS the backdrop and it is painted on
      // `<html>` (globals.css), where it is outside every zoom and outside
      // React — which is what lets it be correct before any JS runs. A fill
      // here would simply cover it.
      // The content surface stays wide while it translates right, so its far
      // edge deliberately overhangs the viewport until the one settled resize.
      // Clip that compositor-only overhang instead of creating a transient
      // horizontal scroll range; vertical paint and the panel's shadow stay free.
      className="relative h-svh flex-col overflow-x-clip"
      // Arms the seam's geometry (globals.css). The framed arrangement — one
      // inset unit with the canvas running around it — is what terminal focus
      // takes away and what unpinning trades for a floating card; the seam's
      // rules are unlayered author CSS, so a Tailwind `m-0` on the card cannot
      // switch them off from the other side. The content surface carries its
      // own endpoint marker during pin motion; every other seam rule reads this
      // shell attribute.
      data-volli-shell={terminalFocused ? "focused" : pinned ? "framed" : "ephemeral"}
      data-motion={terminalFocused || geometryInstant ? "instant" : undefined}
      // The pin journey's own hatch, separate from `data-motion` above and read
      // only by the panel's reveal. See the native-plane exception.
      data-pin-motion={nativePlaneInstant ? "instant" : undefined}
      data-resizing={resizing || undefined}
      style={
        {
          // The committed two-tier width, and `--panel-w`: the panel's share of
          // whichever width is current — the grip's live override while a drag
          // is in flight, the committed one otherwise. Everything below is sized
          // off `--panel-w`, so a drag moves the whole geometry in CSS with no
          // React in the loop. See `sidebar-resize-handle.tsx` for why the drag
          // stopped going through the store, and why the override is a second
          // property rather than this one.
          //
          // This is also the ONE place the rail's fixed share comes off the
          // stored width, which is what keeps the live and committed values
          // meaning the same thing.
          "--sidebar-total": `${sidebarWidth}px`,
          "--panel-w": `calc(var(${LIVE_WIDTH_PROPERTY}, var(--sidebar-total)) - ${WORKSPACE_RAIL_WIDTH}px)`,
          // The panel's own box. Floating, it insets itself by the shell's 8px,
          // so the pane inside has that much less to fill.
          "--sidebar-width": `calc(var(--panel-w) - ${floatingInset}px)`,
          // Zero at THIS level, and that is the decoupling in one line: the rail
          // is no longer inside the pane's box, so the pane's calc must stop
          // subtracting it. The rail re-declares the real value on itself below,
          // purely so globals.css's rail-padding rule keeps reading 60.
          "--rail-width": "0px",
          // What the pane has to give back to whatever draws an edge around it.
          // Docked, the seam draws one border (globals.css uses --shell-edge
          // directly and ignores this). Floating, the card draws two, one on
          // each side, plus its own 8px inset which is already off the width
          // above.
          "--sidebar-edge": pinned ? "var(--shell-edge)" : "calc(2 * var(--shell-edge))",
        } as React.CSSProperties
      }
    >
      {/* The band owns its own 40px and the hover strip stops short of it. */}
      <div ref={bandRef} className="shrink-0">
        {chrome}
      </div>
      {/* UI-zoom invariant: CSS `zoom` scales everything BELOW the chrome band
          (rail + panel + content), never the band itself and never
          SidebarProvider — so the band stays at native scale and its
          SidebarTrigger keeps aligning with the fixed native traffic lights
          (which don't scale). Unlike transform:scale, CSS `zoom` participates in
          layout, so terminal canvases and ResizeObservers below see real resized
          boxes. `zoom` is missing from this TS lib's CSSProperties, hence the
          same cast style used for the custom properties above.

          contain-layout makes THIS row the containing block for the panel's
          absolute box, so it starts below ChromeBar and its height tracks the
          row rather than the window. */}
      {/* No fill of its own: the canvas on `<html>` IS the backdrop, and a fill
          here would simply cover it. */}
      <div
        className="relative flex min-h-0 flex-1 contain-layout"
        style={{ zoom: uiScale } as React.CSSProperties}
      >
        {/* Permanent chrome. A flow sibling of the panel, not a tier inside it —
            it stands or it is gone, and only WorkspaceRailToggle (and terminal
            focus) decides which. Its own `--rail-width` is what globals.css's
            centering correction reads; capping the padding by it is how a rail
            asked for 0 does not get floored at 8 by its own padding.

            `opacity-0` is NOT belt-and-braces on top of a zero width. A zero box
            does not hide anything on its own here, because `ProjectRail` centres
            a 36px tile inside it and centring in nothing puts half the tile at
            negative x. `overflow-hidden` is the obvious answer and it is REVOKED
            in this shell: globals.css turns `overflow` back to `visible` for
            every `[data-slot="sidebar"].overflow-hidden` under
            `data-volli-shell="framed"`, so the collapsible wrapper stops
            clipping the seam's shadow — and this rail matches that selector too.
            So the tiles paint outside a 0px box, and only opacity takes them
            away. */}
        <Sidebar
          collapsible="none"
          data-workspace-rail
          aria-hidden={railHidden || undefined}
          inert={railHidden}
          className={cn(
            // Transparent, not `bg-rail`: the rail was already painted in the
            // backdrop's own token, so it has nothing of its own to give up —
            // it simply sits on the canvas now.
            "w-(--rail-width) shrink-0 overflow-hidden bg-transparent pl-[min(var(--shell-inset),var(--rail-width))]",
            railHidden && "opacity-0",
          )}
          style={{ "--rail-width": `${railWidth}px` } as React.CSSProperties}
        >
          {railContent}
        </Sidebar>

        {/* The entire FINAL docked-vs-floating difference, expressed as one
            width. It deliberately has no transition: `useSidebarContentMotion`
            moves the content presentation on the compositor, then changes this
            inline geometry once where the two renderings coincide. */}
        <div aria-hidden className="shrink-0" style={{ width: gapWidth }} />

        {/* The framed content surface (docs/DESIGN.md): every page — sessions
            layer included — renders inside this one card. overflow-hidden clips
            full-bleed children (tab strips, terminals) to the rounded corners. */}
        {/* Grain is no longer a layer here: the canvas draws it as a gradient
            layer of its own, on the surface it is actually visible on. The card
            is opaque paper above it. */}
        <SidebarInset
          ref={contentMotion.contentRef}
          data-sidebar-content-motion={contentMotion.moving ? "" : undefined}
          // Keep the content's box model at the endpoint its descendants are
          // actually laid out against. During an open the shell itself is
          // already framed for the panel, while this surface deliberately stays
          // ephemeral and wide until the transform lands.
          data-sidebar-layout={contentMotion.layoutPinned ? "framed" : "ephemeral"}
          // Names the app's principal surface for probes that need to anchor on
          // the card rather than guess at it.
          data-volli-surface=""
          className={cn(
            "overflow-hidden",
            terminalFocused
              ? "m-0 rounded-none border-0"
              : cn(
                  // Docked, margin/radius/seam-facing border are the seam's
                  // (globals.css) and what stays here is the hairline the card
                  // draws on its own outer edges. Floating, the surface's layout
                  // marker does not match and the card becomes whole again —
                  // four corners, its own left border, standing on the canvas.
                  "border border-border",
                  !contentMotion.layoutPinned && "m-2 rounded-xl shadow-card",
                ),
          )}
        >
          {content}
        </SidebarInset>

        {/* THE WALL. A box that does not move, holding a clip that therefore
            does not move either — which is the entire reason it exists as a
            separate element rather than as a `clip-path` on the panel itself.
            That was the first attempt and it silently did nothing: `clip-path`
            resolves against the element's OWN reference box, so it rides the
            element's transform, and a clip that travels with the thing it is
            clipping is a clip with no edge. Measured by stepping the panel
            through its whole journey and hashing the rail's painted column: 20
            of 20 positions still put ink on the rail, against a noise floor of
            zero. On this wrapper the same one-line clip is stationary, and the
            same sweep comes back with one rendering.

            Left edge flush at `panelLeft` — the rail's right edge, or the
            window's when the rail is down. The other three sides let out by
            CLIP_SPILL so every shadow behaves exactly as it did unclipped.

            `overflow-hidden` on an OVERSIZED box, not `clip-path` on a tight
            one, and the difference is not stylistic. `clip-path` on an ancestor
            forms a backdrop root: the peek panel's `backdrop-blur-lg` stopped
            sampling the board behind it and the glass went to plain 90% fill,
            with the card's text legible straight through it. `overflow` clips
            without grouping the backdrop, so the blur survives — but it clips
            all four sides, which would eat the shadows. Hence the box is let out
            by CLIP_SPILL on the three sides that are not the wall, putting those
            three cuts 60px away from anything that paints.

            One box for both arrangements: the mode difference lives entirely in
            the panel's own inset inside it. `pointer-events-none` because this
            is a paint boundary and nothing else — the panel below re-enables
            them, so a withdrawn panel still leaves its docked strip clickable
            by whatever is actually under it.

            Deliberately NOT `aria-hidden`, however tempting the symmetry is.
            `aria-hidden` is inherited and cannot be revoked by a descendant, so
            putting it here took the whole sidebar — nav, sessions, footer — out
            of the accessibility tree permanently, including while it was open
            and on screen. The panel below already carries the conditional
            `aria-hidden`/`inert` pair that expresses the thing actually worth
            expressing: withdrawn is hidden, shown is not. A wrapper that exists
            only to clip paint must stay silent about semantics. */}
        <div
          className="pointer-events-none absolute z-20 overflow-hidden"
          style={{
            top: -CLIP_SPILL,
            bottom: -CLIP_SPILL,
            left: panelLeft,
            width: `calc(var(--panel-w) + ${CLIP_SPILL}px)`,
          }}
        >
          {/* The panel. Its BOX is set per pin state and never transitions:
              docked it is full-bleed with the seam inset drawn inside it,
              floating it is itself inset and the pane sits flush. Both put the
              visible card on the same rectangle, so the only thing left to
              animate is the reveal — and that is transform alone, behind the
              wall above. */}
          <div
            ref={panelRef}
            data-slot="sidebar"
            data-native-plane-overlay={nativePlaneOverlay ? "" : undefined}
            aria-hidden={!panelShown || undefined}
            inert={!panelShown}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && !panelShown) {
                setFloatingOverlayExiting(false);
              }
            }}
            onClick={reveal.onPanelClick}
            onFocus={reveal.onPanelFocus}
            onBlur={reveal.onPanelBlur}
            className={cn(
              "pointer-events-auto absolute flex transform-gpu text-sidebar-foreground",
              // `translate` FIRST, and it is the one that does the work.
              // Tailwind v4 compiles `translate-x-*` to the standalone
              // `translate` property, not into `transform` — so a transition
              // list naming only `transform` covers a property nothing is
              // changing, and the panel teleports at full opacity instead of
              // sliding. `transform` stays because `transform-gpu` writes it,
              // and neither costs anything.
              "transition-[translate,transform,opacity] ease-swift [transition-duration:var(--reveal-duration,200ms)] group-data-[pin-motion=instant]/sidebar-wrapper:transition-none",
              // No `will-change` here, and that is not an omission.
              // `transform-gpu` above writes `transform: translateZ(0)`, which
              // already gives this element its own compositor layer for as long
              // as it exists — so the hint had nothing left to promote, and it
              // named `transform` while the property that actually moves is
              // `translate` (see below).
              !pinned &&
                // The floating card's own surface. It lives on the WRAPPER, not
                // on `[data-volli-sidebar]`, because that selector is
                // unconditional in globals.css and forces `background-color:
                // transparent` for its lift overlay — a fill declared on the
                // pane would be overruled in every mode. The lift then
                // composites over this glass, which is the correct order
                // anyway: material first, tier on top.
                //
                // `lg` (16px), not `2xl` (40px): the compositor re-samples the
                // backdrop across the panel's whole area every frame it
                // translates, and cost scales with radius — 40px was double the
                // 20px transition-time budget for a panel whose entrance IS a
                // translate. At 90% fill the material reads the same.
                "overflow-hidden rounded-xl border border-border bg-sidebar/90 shadow-overlay backdrop-blur-lg",
              panelShown
                ? "translate-x-0"
                : // Reduced motion: the surface arrives where it will rest
                  // instead of travelling 250px across the reader's field of
                  // view. Opacity is the only thing left moving, and briefly.
                  "translate-x-[calc(-100%-var(--panel-hidden-shift))] motion-reduce:translate-x-0 motion-reduce:opacity-0",
              // Terminal focus is not a reveal: the canvas is being handed to a
              // PTY, so the panel leaves without a journey to watch.
              terminalFocused && "invisible",
            )}
            style={
              {
                // Inset INSIDE the wall, not placed against the row: the wrapper
                // already stands at `panelLeft`, so what is left here is the
                // difference between the two arrangements — plus the wall's own
                // vertical overhang, which the panel has to give back or it
                // would hang CLIP_SPILL px above the row it belongs to.
                top: floatingInset + CLIP_SPILL,
                bottom: floatingInset + CLIP_SPILL,
                left: floatingInset,
                width: `calc(var(--panel-w) - ${floatingInset}px)`,
                "--panel-hidden-shift": `${hiddenShift}px`,
              } as React.CSSProperties
            }
          >
            {/* The lifted half of the seam, and the one on-canvas tier that
                moves (globals.css § ELEVATION). It carries no fill of its own:
                `--lift-2` composites over the gradient as a background IMAGE,
                and a veil underneath would be a second mechanism pushing the
                same way.

                `data-volli-sidebar` rather than a utility class, because the
                seam has to name this element specifically: it is one of three
                `data-slot="sidebar"` roots in this tree, and selecting it by a
                fill it no longer has was how the lab did it. */}
            <Sidebar collapsible="none" data-volli-sidebar className="min-w-0 flex-1">
              {paneContent}
            </Sidebar>
            {/* The grip sets the panel's width in both modes, and one width
                serves both. Safe mid-drag because pointer-down suspends every
                open/close rule. */}
            <SidebarResizeHandle onResizingChange={setResizing} />
          </div>
        </div>

        {/* The standing evidence that any of this exists, in the 8px canvas
            gutter between the rail and the card — and ONLY there. With the rail
            standing the remaining strip is thin enough that the user has to
            aim, and this is what they aim at. With the rail down the target is
            the zone below, which widens by one shell inset to answer the aiming
            problem itself; the owner's call is that a hint there is not worth
            the ink. A hint, not a handle. */}
        {!pinned && !terminalFocused && !workspaceRailHidden ? (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute z-30 transition-opacity duration-150 ease-swift",
              reveal.visible ? "opacity-0" : "opacity-100",
            )}
            style={{ top: 0, bottom: 0, left: panelLeft, width: SLIVER_WIDTH }}
          >
            <div
              className={cn(
                "absolute inset-y-2 left-[2px] w-[2px] rounded-full transition-colors duration-150",
                reveal.arming ? "bg-foreground/30" : "bg-foreground/10",
              )}
            />
          </div>
        ) : null}

        {/* Hit-tested, never hit: the reveal reads THIS element's rect rather
            than arithmetic, so the rule stays correct under the row's `zoom`,
            where CSS px and client px diverge. */}
        <div
          ref={zoneRef}
          aria-hidden
          className="pointer-events-none absolute z-30"
          style={{
            top: ZONE_TOP_DEAD_BAND,
            bottom: 0,
            left: panelLeft,
            width: workspaceRailHidden ? ZONE_WIDTH + RAIL_OFF_ZONE_EXTRA : ZONE_WIDTH,
          }}
        />
      </div>
      <Toaster />
      {/* The armed-column delay window (VC-128, main-owned in VC-226).
          Window-level beside the Toaster rather than inside the board: any
          mounted renderer projects main's same durable countdown, whatever
          page it shows, and Cancel from any window deletes that exact arrival.
          The timer itself is in main, so an explicit `volli ticket move` still
          fires with no renderer open. */}
      <ArmedRunWindows />
      <NewTicketDialog />
      {/* Window-level beside the other app-wide dialogs (VC-290): a closed
          Session's record is reachable from the sidebar and from ⌘K, and both
          of those outlive whatever page is in front. It opens OVER the current
          surface and takes nothing over, which is the whole point — reading
          what a terminal did must not cost you the tab you were in. */}
      <SessionDetailDialog />
      <HarnessTrustDialog />
      <UpdateInstallDialog />
    </SidebarProvider>
  );
}
