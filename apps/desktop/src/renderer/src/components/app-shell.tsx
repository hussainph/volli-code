import * as React from "react";
import { InspectorHostContext } from "./sidebar/inspector-host";
import { GlassSurface, PaperSurface } from "./ui/surface";

import { ArmedRunWindows } from "@renderer/components/automations/armed-run-window";
import { ChromeBar } from "@renderer/components/chrome-bar";
import { HostIsland } from "@renderer/components/hosts/host-island";
import { HarnessTrustDialog } from "@renderer/components/harness/harness-trust-dialog";
import { NewTicketDialog } from "@renderer/components/board/new-ticket-dialog";
import { MainContent } from "@renderer/components/pages/main-content";
import { useSettingsShortcut } from "@renderer/components/settings/settings-panel";
import { FolderClaimDialog } from "@renderer/components/rail/folder-claim-dialog";
import { CloudMovesRoot } from "@renderer/components/cloud-moves/cloud-moves";
import { ProjectRail } from "@renderer/components/rail/project-rail";
import { SessionDetailDialog } from "@renderer/components/sessions/session-detail-dialog";
import { SessionShareDialog } from "@renderer/components/sessions/session-team";
import {
  armRevealClock,
  useEdgeReveal,
  ZONE_TOP_DEAD_BAND,
  ZONE_WIDTH,
} from "@renderer/components/sidebar/edge-reveal";
import { usePaneMotion } from "@renderer/components/sidebar/pane-motion";
import { useProjectsStore } from "@renderer/stores/projects";
import { useOverlayScrollbars } from "@renderer/hooks/use-overlay-scrollbars";
import { PrimarySidebar } from "@renderer/components/sidebar/primary-sidebar";
import {
  LIVE_WIDTH_PROPERTY,
  SidebarResizeHandle,
} from "@renderer/components/sidebar/sidebar-resize-handle";
import { Sidebar, SidebarInset, SidebarProvider } from "@renderer/components/ui/sidebar";
import { Toaster } from "@renderer/components/ui/sonner";
import { UpdateInstallDialog } from "@renderer/components/update/update-install-dialog";
import { useBrowserAppShortcuts } from "@renderer/hooks/use-browser-app-shortcuts";
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

const PROJECT_RAIL_WIDTH = 60;
/** globals.css `--shell-inset`, in the one place TS has to agree with it. */
const SHELL_INSET = 6;
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
 * How much wider the arming strip gets when the project rail is down. With
 * the rail standing, {@link ZONE_WIDTH} is the gutter the rail already leaves
 * and the sliver says where to aim. With the rail down that same 8px is the
 * bare window edge — in a windowed window, an invisible line floating
 * mid-screen, in exactly the state the reveal is most needed and hardest to
 * fire. The extra is one shell inset: 16px total, still only 8px into the
 * card's own border-and-radius margin, where no page draws anything
 * interactive — an aim tolerance, not a new trigger surface.
 */
const RAIL_OFF_ZONE_EXTRA = SHELL_INSET;

/** Window canvas, resident navigation islands and the neutral reading card.
 * Pinning continuously pushes the pane and paper edges together; peeking overlays
 * the same subtree. The permanent rail and native-scale traffic lights never move.
 * A stationary clip stops the left pane crossing the workspace rail. */
export function AppShell({ mainContent }: { mainContent?: React.ReactNode } = {}) {
  useProjectShortcuts();
  useSettingsShortcut();
  useOverlayScrollbars();
  useNewTicketShortcut();
  useNavHistory();
  useProjectRootsSync();
  useZoomCommands();
  useBrowserAppShortcuts();
  useBootNotice();
  useCliLaunchNotice();
  // What this window is showing, reported to main so an alert for a Session or
  // ticket already in front of the person is not also posted by the OS (VC-295).
  useNotificationTargetReport();
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const projectRailHidden = useUiStore((state) => state.projectRailHidden);
  const pinChoice = useUiStore((state) => state.sidebarPinned);
  const setSidebarPinned = useUiStore((state) => state.setSidebarPinned);
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const uiScale = useUiStore((state) => state.uiScale);
  const fullScreen = useFullScreen();
  const reducedMotion = useReducedMotion();
  const [resizing, setResizing] = React.useState(false);
  const [geometryInstant, setGeometryInstant] = React.useState(false);
  const [keyboardInstant, setKeyboardInstant] = React.useState(false);
  const [pinSuspended, setPinSuspended] = React.useState(false);
  const terminalFocused = terminalFocusTarget !== null;
  // What the layout below reads. The stored choice, minus a suspension nothing
  // durable ever hears about — see the fullscreen effect.
  const pinned = pinChoice && !pinSuspended;
  // The pin as the CONTENT half sees it. Terminal focus hands the whole canvas
  // to a PTY, so it is an unpin that no stored choice records.
  const docked = pinned && !terminalFocused;

  const [peekProjectId, setPeekProjectId] = React.useState<string | null>(null);
  const onProjectIntent = React.useCallback((id: string | null) => setPeekProjectId(id), []);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const zoneRef = React.useRef<HTMLDivElement | null>(null);
  const bandRef = React.useRef<HTMLDivElement | null>(null);

  const reveal = useEdgeReveal({
    enabled: !pinned && !terminalFocused,
    panelRef,
    zoneRef,
    bandRef,
    projectTiles: true,
    closeOnNavigation: false,
    onProjectIntent,
  });

  const peekAtPress = React.useRef({ projectId: peekProjectId, visible: reveal.visible });
  peekAtPress.current = { projectId: peekProjectId, visible: reveal.visible };
  const railWidth = projectRailHidden || terminalFocused ? 0 : PROJECT_RAIL_WIDTH;
  const railHidden = projectRailHidden || terminalFocused;
  // `sidebarWidth` stores the full two-tier width and the panel is always what
  // is left after the rail's fixed 60, whether or not the rail is on screen —
  // but that subtraction now happens once, in CSS, as `--panel-w` below, so a
  // drag can move every box that depends on it without re-rendering anything.
  const panelLeft = railWidth;
  const floatingInset = 0;
  const panelShown = !terminalFocused && (pinned || reveal.visible);
  // Native child views composite above every renderer z-index. Keep the marker
  // through the floating panel's exit transition as well as its open state, or
  // the Browser plane would jump in front for the final 160ms of withdrawal.
  const [floatingOverlayExiting, setFloatingOverlayExiting] = React.useState(false);
  const previousPanel = React.useRef({ shown: panelShown, docked });
  React.useLayoutEffect(() => {
    const previous = previousPanel.current;
    previousPanel.current = { shown: panelShown, docked };
    // Instant exits dispatch no transitionend. Release the Browser freeze in
    // that same commit, including when Motion is turned off during an exit.
    if (pinned || terminalFocused || panelShown || reducedMotion || keyboardInstant) {
      setFloatingOverlayExiting(false);
    } else if (previous.shown) {
      // Only a floating peek has a CSS exit. Pin pushes retain the native-plane
      // fence through contentMotion.moving and release it at the spring finish;
      // waiting for transitionend here would keep the Browser frozen forever.
      setFloatingOverlayExiting(!previous.docked);
    }
  }, [panelShown, docked, pinned, terminalFocused, reducedMotion, keyboardInstant]);
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

  // Native planes and expensive editor grids defer resize under the shared
  // pane transaction fence, rather than observing every animated width.
  React.useLayoutEffect(() => {
    if (!keyboardInstant) return;
    const frame = window.requestAnimationFrame(() => setKeyboardInstant(false));
    return () => window.cancelAnimationFrame(frame);
  }, [keyboardInstant]);
  const contentMotion = usePaneMotion({
    side: "left",
    mode: docked ? "pinned" : panelShown ? "peeking" : "closed",
    // A resize drag needs exact pointer tracking, and terminal/rail geometry has
    // always owned the shell's instant escape hatch. Settle any in-flight pin
    // journey before either changes the width token underneath it.
    instant:
      resizing ||
      terminalFocused ||
      geometryInstant ||
      geometryChanged ||
      keyboardInstant ||
      reducedMotion,
    panelRef,
    bandRef,
    geometryKey: sidebarWidth,
  });
  // Both divider edges read this one live value. React commits only intent;
  // the registered property drives native layout during the finite spring.
  const gapWidth = "var(--left-pane-push, var(--panel-w))";
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
    (next: boolean, options?: { instant?: boolean }) => {
      setKeyboardInstant(options?.instant === true);
      setPinSuspended(false);
      const peek = peekAtPress.current;
      if (next && peek.visible && peek.projectId !== null)
        useProjectsStore.getState().select(peek.projectId);
      // A deliberate pin toggle uses the full base clock. CSS retargets the
      // panel from its live value if the direction changes; the content hook
      // separately samples its live WAAPI translate before reversing.
      armRevealClock(panelRef.current, next, true);
      panelRef.current?.removeAttribute("data-glass-blur");
      panelRef.current?.toggleAttribute("data-keyboard-dismiss", options?.instant === true);
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
  const previewProjectId = !pinned && reveal.visible ? peekProjectId : null;
  const paneContent = React.useMemo(
    () => <PrimarySidebar previewProjectId={previewProjectId} />,
    [previewProjectId],
  );
  const chrome = React.useMemo(() => <ChromeBar />, []);
  const [inspectorHost, setInspectorHost] = React.useState<HTMLDivElement | null>(null);
  const content = React.useMemo(() => <MainContent override={mainContent} />, [mainContent]);

  return (
    <InspectorHostContext.Provider value={inspectorHost}>
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
        data-motion={terminalFocused || geometryInstant || keyboardInstant ? "instant" : undefined}
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
            "--panel-w": `calc(var(${LIVE_WIDTH_PROPERTY}, var(--sidebar-total)) - ${PROJECT_RAIL_WIDTH}px)`,
            // The panel's own box, less the shared 6px canvas inset.
            "--sidebar-width": `calc(var(--panel-w) - ${floatingInset}px)`,
            // Zero at THIS level, and that is the decoupling in one line: the rail
            // is no longer inside the pane's box, so the pane's calc must stop
            // subtracting it. The rail re-declares the real value on itself below,
            // purely so globals.css's rail-padding rule keeps reading 60.
            "--rail-width": "0px",
            // What the pane has to give back to whatever draws an edge around it.
            // Both floating arrangements draw two glass edges.
            "--sidebar-edge": "calc(2 * var(--shell-edge))",
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
          data-pane-row=""
          className="relative flex min-h-0 flex-1 contain-layout"
          style={{ zoom: uiScale } as React.CSSProperties}
        >
          {/* Permanent chrome. A flow sibling of the panel, not a tier inside it —
            it stands or it is gone, and only ProjectRailToggle (and terminal
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
            data-project-rail
            aria-hidden={railHidden || undefined}
            data-pane-withdrawn={railHidden || undefined}
            inert={railHidden}
            className={cn(
              // Transparent, not `bg-rail`: the rail was already painted in the
              // backdrop's own token, so it has nothing of its own to give up —
              // it simply sits on the canvas now.
              "w-(--rail-width) shrink-0 overflow-hidden bg-transparent",
              railHidden && "opacity-0",
            )}
            style={{ "--rail-width": `${railWidth}px` } as React.CSSProperties}
          >
            {railContent}
          </Sidebar>

          {/* The reservation and panel consume one animated width. Heavy
            renderers defer their own resize under the pane transaction fence;
            the paper still follows the divider continuously. */}
          <div
            data-pane-reservation="left"
            aria-hidden
            className="shrink-0"
            style={{ width: gapWidth }}
          />

          {/* The framed content surface (docs/DESIGN.md): every page — sessions
            layer included — renders inside this one card. overflow-hidden clips
            full-bleed children (tab strips, terminals) to the rounded corners. */}
          {/* Grain is no longer a layer here: the canvas draws it as a gradient
            layer of its own, on the surface it is actually visible on. The card
            is opaque paper above it. */}
          <PaperSurface asChild>
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
                      // The paper card keeps its whole perimeter in both pin states.
                      "border border-border",
                      !contentMotion.layoutPinned && "rounded-xl shadow-card",
                    ),
              )}
            >
              {content}
              {/* The connection Island (VC-576): floats over the card's foot while
              the project's host has something blocking to say. Nothing with
              the `cloud` flag off. */}
              <HostIsland />
            </SidebarInset>
          </PaperSurface>
          <div ref={setInspectorHost} className="contents" data-inspector-host="" />

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

            The oversized overflow clip lets all three free edges cast their
            shadows. CLIP_SPILL keeps those cuts 60px away from the pane.
            Regular fake frost paints inside the pane without a backdrop root
            or an extra blur pass during the reveal.

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
            data-pane-clip=""
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
              data-pane-withdrawn={!panelShown || undefined}
              inert={!panelShown}
              onTransitionEnd={(event) => {
                if (event.target === event.currentTarget)
                  event.currentTarget.removeAttribute("data-glass-blur");
                if (event.target === event.currentTarget && !panelShown) {
                  setFloatingOverlayExiting(false);
                }
              }}
              onClickCapture={() => {
                if (!pinned && peekProjectId !== null && reveal.visible)
                  useProjectsStore.getState().select(peekProjectId);
              }}
              onClick={reveal.onPanelClick}
              onFocus={reveal.onPanelFocus}
              onBlur={reveal.onPanelBlur}
              data-pane-side="left"
              data-shown={panelShown || undefined}
              className={cn(
                "absolute flex rounded-floating text-sidebar-foreground",
                panelShown ? "pointer-events-auto" : "pointer-events-none",
                terminalFocused && "invisible",
              )}
              style={
                {
                  // Inset INSIDE the wall, not placed against the row: the wrapper
                  // already stands at `panelLeft`, so what is left here is the
                  // difference between the two arrangements — plus the wall's own
                  // vertical overhang, which the panel has to give back or it
                  // would hang CLIP_SPILL px above the row it belongs to.
                  top: CLIP_SPILL,
                  bottom: SHELL_INSET + CLIP_SPILL,
                  left: floatingInset,
                  width: `calc(var(--panel-w) - ${floatingInset}px)`,
                  "--panel-hidden-shift": `${hiddenShift}px`,
                } as React.CSSProperties
              }
            >
              {/* One regular-material pane for pinned and floating navigation.
                The data hook also owns the existing seam geometry. */}
              <GlassSurface asChild tint>
                <Sidebar collapsible="none" data-volli-sidebar className="min-w-0 flex-1">
                  {paneContent}
                </Sidebar>
              </GlassSurface>
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
            problem itself; a hint there is not worth
            the ink. A hint, not a handle. */}
          {!pinned && !terminalFocused && !projectRailHidden ? (
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute z-30 transition-opacity duration-(--duration-menu-in) ease-swift",
                reveal.visible ? "opacity-0" : "opacity-100",
              )}
              style={{ top: 0, bottom: 0, left: panelLeft, width: SLIVER_WIDTH }}
            >
              <div
                className={cn(
                  "absolute inset-y-2 left-[2px] w-[2px] rounded-full transition-colors duration-(--duration-menu-in)",
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
              width: projectRailHidden ? ZONE_WIDTH + RAIL_OFF_ZONE_EXTRA : ZONE_WIDTH,
            }}
          />
        </div>
        {contentMotion.decoration}
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
        <SessionShareDialog />
        <HarnessTrustDialog />
        {/* Window-level for the same reason, and NOT inside the rail (VC-430):
          both doors into adding a project raise the same "is this one you
          already have?" question, the claim that holds it lives in the store,
          and the rail itself goes inert when it is hidden. Renders nothing
          until there is a question to answer. */}
        <FolderClaimDialog />
        <CloudMovesRoot />
        <UpdateInstallDialog />
      </SidebarProvider>
    </InspectorHostContext.Provider>
  );
}
