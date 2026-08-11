import * as React from "react";

import { ChromeBar } from "@renderer/components/chrome-bar";
import { HarnessTrustDialog } from "@renderer/components/harness/harness-trust-dialog";
import { NewTicketDialog } from "@renderer/components/board/new-ticket-dialog";
import { MainContent } from "@renderer/components/pages/main-content";
import { ProjectRail } from "@renderer/components/rail/project-rail";
import {
  armRevealClock,
  useEdgeReveal,
  ZONE_TOP_DEAD_BAND,
  ZONE_WIDTH,
} from "@renderer/components/sidebar/edge-reveal";
import { PrimarySidebar } from "@renderer/components/sidebar/primary-sidebar";
import { SidebarResizeHandle } from "@renderer/components/sidebar/sidebar-resize-handle";
import { Sidebar, SidebarInset, SidebarProvider } from "@renderer/components/ui/sidebar";
import { Toaster } from "@renderer/components/ui/sonner";
import { takeBootNotice } from "@renderer/lib/boot-notice";
import { takeCliLaunchNotice } from "@renderer/lib/cli-launch-notice";
import { toastError } from "@renderer/lib/toast";
import { useFullScreen } from "@renderer/hooks/use-fullscreen";
import { useNavHistory } from "@renderer/hooks/use-nav-history";
import { useNewTicketShortcut } from "@renderer/hooks/use-new-ticket-shortcut";
import { useProjectShortcuts } from "@renderer/hooks/use-project-shortcuts";
import { cn } from "@renderer/lib/utils";
import { errorMessage } from "@volli/shared";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { toast } from "sonner";

const WORKSPACE_RAIL_WIDTH = 60;
/** globals.css `--shell-inset`, in the one place TS has to agree with it. */
const SHELL_INSET = 8;
/** The standing hint, in the canvas gutter the framed card already leaves bare. */
const SLIVER_WIDTH = 6;
/** How far past its own width the panel travels, so `--shadow-overlay` clears the edge too. */
const SHADOW_ALLOWANCE = 32;

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
 * the visible card on the same rectangle, so nothing about the sidebar moves on
 * ⌘B — only the content slides out from under it, and only the spacer animates.
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
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const workspaceRailHidden = useUiStore((state) => state.workspaceRailHidden);
  const pinned = useUiStore((state) => state.sidebarPinned);
  const setSidebarPinned = useUiStore((state) => state.setSidebarPinned);
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const uiScale = useUiStore((state) => state.uiScale);
  const fullScreen = useFullScreen();
  const [resizing, setResizing] = React.useState(false);
  const [geometryInstant, setGeometryInstant] = React.useState(false);
  const terminalFocused = terminalFocusTarget !== null;

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
  // `sidebarWidth` stores the full two-tier width; the panel is always what is
  // left after the rail's fixed 60, whether or not the rail is on screen.
  const panelWidth = sidebarWidth - WORKSPACE_RAIL_WIDTH;
  const panelLeft = railWidth;
  const floatingInset = pinned ? 0 : SHELL_INSET;
  const panelShown = !terminalFocused && (pinned || reveal.visible);
  // The spacer holds ONLY the panel's width. The rail is a flow sibling and
  // already occupies its own 60px; adding it here too would reserve it twice and
  // leave a 60px band of bare canvas between the rail and the card.
  const gapWidth = pinned && !terminalFocused ? panelWidth : 0;
  // How far the panel must travel to be gone. `-100%` is its own width, which
  // clears the viewport only from left:0 — from left:68 it parks the panel's
  // right edge at +36, which is a strip of sidebar sitting over the rail rather
  // than a hidden sidebar. Its distance from the edge has to come too.
  const hiddenShift = panelLeft + floatingInset + SHADOW_ALLOWANCE;

  // Showing or hiding the switcher moves the spacer and the panel's box by the
  // same 60px, but only the spacer can transition — the panel's box is inline
  // geometry that snaps, and half of a move animating is worse than none of it.
  // A timed sidebar-width transition also sends a cascade of intermediate PTY
  // resizes while entering/exiting terminal focus. Both hold the shell's
  // data-motion=instant escape hatch through the first frame of the change,
  // producing one settled resize instead.
  const previousGeometry = React.useRef({ railWidth, terminalFocused });
  React.useLayoutEffect(() => {
    const previous = previousGeometry.current;
    if (previous.railWidth === railWidth && previous.terminalFocused === terminalFocused) return;
    previousGeometry.current = { railWidth, terminalFocused };
    setGeometryInstant(true);
    const frame = window.requestAnimationFrame(() => setGeometryInstant(false));
    return () => window.cancelAnimationFrame(frame);
  }, [railWidth, terminalFocused]);

  /* Fullscreen infers the pin state in ONE direction and remembers rather than
   * overwrites. Entering fullscreen is an explicit "give me the content", so
   * unpinning is reading the room. Leaving it is not a request for chrome, so
   * the pre-fullscreen value comes back — unless a deliberate ⌘B inside
   * fullscreen already answered the question, in which case that answer wins. */
  const pinBeforeFullScreen = React.useRef<boolean | null>(null);
  const pinTouchedInFullScreen = React.useRef(false);
  const fullScreenRef = React.useRef(fullScreen);
  const previousFullScreen = React.useRef(fullScreen);
  fullScreenRef.current = fullScreen;

  React.useEffect(() => {
    if (previousFullScreen.current === fullScreen) return;
    previousFullScreen.current = fullScreen;
    if (fullScreen) {
      pinBeforeFullScreen.current = pinned;
      pinTouchedInFullScreen.current = false;
      setSidebarPinned(false);
      return;
    }
    const remembered = pinBeforeFullScreen.current;
    pinBeforeFullScreen.current = null;
    if (!pinTouchedInFullScreen.current && remembered !== null) setSidebarPinned(remembered);
    pinTouchedInFullScreen.current = false;
  }, [fullScreen, pinned, setSidebarPinned]);

  const setPinned = React.useCallback(
    (next: boolean) => {
      if (fullScreenRef.current) pinTouchedInFullScreen.current = true;
      // Told rather than measured: a pin toggle is never an interruption. The
      // panel is parked at rest and makes the whole journey or none of it, and
      // the hook's own reset runs in an effect — by which time the DOM already
      // shows the answer instead of the question.
      armRevealClock(panelRef.current, next, true);
      setSidebarPinned(next);
    },
    [setSidebarPinned],
  );

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
      className="relative h-svh flex-col"
      // Arms the seam's geometry (globals.css). The framed arrangement — one
      // inset unit with the canvas running around it — is what terminal focus
      // takes away and what unpinning trades for a floating card; the seam's
      // rules are unlayered author CSS, so a Tailwind `m-0` on the card cannot
      // switch them off from the other side. One attribute, read by every rule
      // that participates.
      data-volli-shell={terminalFocused ? "focused" : pinned ? "framed" : "ephemeral"}
      data-motion={terminalFocused || geometryInstant ? "instant" : undefined}
      data-resizing={resizing || undefined}
      style={
        {
          // The panel's own box. Floating, it insets itself by the shell's 8px,
          // so the pane inside has that much less to fill.
          "--sidebar-width": `${panelWidth - floatingInset}px`,
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
        <ChromeBar />
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
          <ProjectRail />
        </Sidebar>

        {/* The entire docked-vs-floating difference, expressed as one width.
            Nothing else in the row knows which mode it is in.

            `data-motion=instant` suspends it (one frame across a rail toggle or
            a terminal-focus change) and so does `data-resizing`, which is a real
            1:1 tracking requirement rather than a taste. */}
        <div
          aria-hidden
          className="shrink-0 transition-[width] duration-200 ease-swift group-data-[motion=instant]/sidebar-wrapper:transition-none group-data-[resizing]/sidebar-wrapper:transition-none motion-reduce:transition-none"
          style={{ width: gapWidth }}
        />

        {/* The framed content surface (docs/DESIGN.md): every page — sessions
            layer included — renders inside this one card. overflow-hidden clips
            full-bleed children (tab strips, terminals) to the rounded corners. */}
        {/* Grain is no longer a layer here: the canvas draws it as a gradient
            layer of its own, on the surface it is actually visible on. The card
            is opaque paper above it. */}
        <SidebarInset
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
                  // draws on its own outer edges. Floating, the seam's selector
                  // does not match and the card becomes a whole card again —
                  // four corners, its own left border, standing on the canvas.
                  "border border-border",
                  !pinned && "m-2 rounded-xl shadow-[var(--shadow-card)]",
                ),
          )}
        >
          <MainContent override={mainContent} />
        </SidebarInset>

        {/* The panel. Its BOX is set per pin state and never transitions: docked
            it is full-bleed with the seam inset drawn inside it, floating it is
            itself inset and the pane sits flush. Both put the visible card on
            the same rectangle, so the only thing left to animate is the reveal —
            and that is transform alone. */}
        <div
          ref={panelRef}
          data-slot="sidebar"
          aria-hidden={!panelShown || undefined}
          inert={!panelShown}
          onClick={reveal.onPanelClick}
          onFocus={reveal.onPanelFocus}
          onBlur={reveal.onPanelBlur}
          className={cn(
            "absolute z-20 flex transform-gpu text-sidebar-foreground",
            // `translate` FIRST, and it is the one that does the work. Tailwind
            // v4 compiles `translate-x-*` to the standalone `translate`
            // property, not into `transform` — so a transition list naming only
            // `transform` covers a property nothing is changing, and the panel
            // teleports at full opacity instead of sliding. `transform` stays
            // because `transform-gpu` writes it, and neither costs anything.
            "transition-[translate,transform,opacity] ease-swift [transition-duration:var(--reveal-duration,200ms)]",
            // Promoted a beat before it moves rather than for the whole time it
            // sits idle: `arming` leads the open by the dwell delay, which is
            // exactly the lead time the hint is worth.
            !pinned && (reveal.arming || reveal.visible) && "will-change-transform",
            !pinned &&
              // The floating card's own surface. It lives on the WRAPPER, not on
              // `[data-volli-sidebar]`, because that selector is unconditional
              // in globals.css and forces `background-color: transparent` for
              // its lift overlay — a fill declared on the pane would be overruled
              // in every mode. The lift then composites over this glass, which is
              // the correct order anyway: material first, tier on top.
              "overflow-hidden rounded-xl border border-border bg-sidebar/90 shadow-[var(--shadow-overlay)] backdrop-blur-2xl",
            panelShown
              ? "translate-x-0"
              : // Reduced motion: the surface arrives where it will rest instead
                // of travelling 250px across the reader's field of view. Opacity
                // is the only thing left moving, and briefly.
                "translate-x-[calc(-100%-var(--panel-hidden-shift))] motion-reduce:translate-x-0 motion-reduce:opacity-0",
            // Terminal focus is not a reveal: the canvas is being handed to a
            // PTY, so the panel leaves without a journey to watch.
            terminalFocused && "invisible",
          )}
          style={
            {
              top: floatingInset,
              bottom: floatingInset,
              left: panelLeft + floatingInset,
              width: panelWidth - floatingInset,
              "--panel-hidden-shift": `${hiddenShift}px`,
            } as React.CSSProperties
          }
        >
          {/* The lifted half of the seam, and the one on-canvas tier that moves
              (globals.css § ELEVATION). It carries no fill of its own: `--lift-2`
              composites over the gradient as a background IMAGE, and a veil
              underneath would be a second mechanism pushing the same way.

              `data-volli-sidebar` rather than a utility class, because the seam
              has to name this element specifically: it is one of three
              `data-slot="sidebar"` roots in this tree, and selecting it by a
              fill it no longer has was how the lab did it. */}
          <Sidebar collapsible="none" data-volli-sidebar className="min-w-0 flex-1">
            <PrimarySidebar />
          </Sidebar>
          {/* The grip sets the panel's width in both modes, and one width serves
              both. Safe mid-drag because pointer-down suspends every open/close
              rule. */}
          <SidebarResizeHandle onResizingChange={setResizing} />
        </div>

        {/* The standing evidence that any of this exists, in the 8px canvas
            gutter between the rail and the card — and ONLY there. With the rail
            hidden the whole window edge is the target and needs no hint; with it
            standing the remaining strip is thin enough that the user has to aim,
            and this is what they aim at. A hint, not a handle. */}
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
                reveal.arming ? "bg-foreground/35" : "bg-foreground/12",
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
          style={{ top: ZONE_TOP_DEAD_BAND, bottom: 0, left: panelLeft, width: ZONE_WIDTH }}
        />
      </div>
      <Toaster />
      <NewTicketDialog />
      <HarnessTrustDialog />
    </SidebarProvider>
  );
}

/**
 * Bridges the native View-menu zoom items (⌘+/⌘-/⌘0) to the ui store. The
 * menu handlers live in the main process (menu.ts) because global accelerators
 * must; they only fire an event, and the store — not Electron's page zoom —
 * owns UI scale so the chrome band stays at native scale (see the zoom
 * invariant on the content row above).
 */
function useZoomCommands() {
  React.useEffect(() => {
    return window.api.window.onZoomCommand((cmd) => {
      const { stepUiScale, resetUiScale } = useUiStore.getState();
      if (cmd === "in") stepUiScale(1);
      else if (cmd === "out") stepUiScale(-1);
      else resetUiScale();
    });
  }, []);
}

/**
 * Surfaces a one-shot boot notice (e.g. a failed legacy import) as a toast on
 * mount. boot() runs before the Toaster mounts, so it stashes the message
 * rather than toasting directly (see lib/boot-notice.ts). `takeBootNotice`
 * clears as it reads, so StrictMode's double-invoke surfaces it exactly once.
 */
function useBootNotice() {
  React.useEffect(() => {
    const notice = takeBootNotice();
    if (notice !== null) toastError(notice);
  }, []);
}

function useCliLaunchNotice() {
  React.useEffect(() => {
    const notice = takeCliLaunchNotice(window.api.app.launchedByCli);
    if (notice !== null) toast.info(notice);
  }, []);
}

/** Mirrors tracked project paths into the main process's fs-root allowlist. */
function useProjectRootsSync() {
  // Key on the SET of paths, not the array identity: a rail reorder churns a
  // fresh projects array on every pointer-cross (live shuffle) yet never
  // changes the allowlist, so an order-independent digest keeps a single drag
  // from firing a burst of redundant syncRoots IPC round-trips.
  const rootsKey = useProjectsStore((state) =>
    state.projects
      .map((project) => project.path)
      .toSorted()
      .join("\n"),
  );

  React.useEffect(() => {
    const paths = useProjectsStore.getState().projects.map((project) => project.path);
    window.api.projects.syncRoots(paths).catch((error: unknown) => {
      toastError(`Couldn't sync project roots: ${errorMessage(error)}`);
    });
  }, [rootsKey]);
}
