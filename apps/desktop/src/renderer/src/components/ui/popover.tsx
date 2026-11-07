import { useOverlayLayer } from "./overlay-layer";
import { GlassSurface } from "./surface";

import * as React from "react";
import { ControlShapeProvider } from "./control-shape";
import { Popover as PopoverPrimitive } from "radix-ui";

import { SectionHeading } from "@renderer/components/ui/section-heading";

import { cn } from "@renderer/lib/utils";
import { MotionOriginRoot, useMotionOriginProps } from "./motion-origin";

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return (
    <MotionOriginRoot scope="popover" deferClosedGesture {...props}>
      {(motion) => <PopoverPrimitive.Root data-slot="popover" {...props} {...motion} />}
    </MotionOriginRoot>
  );
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const motion = useMotionOriginProps("popover", props);
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} {...motion} />;
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

/* --------------------------------------------------------- wheel gestures */

/**
 * Claims the wheel for an open popover — the fix for searchable dropdowns that
 * could not be scrolled while a dialog was open underneath (VC-138).
 *
 * A non-modal `Popover` portals its content to `document.body`, OUTSIDE the DOM
 * of whatever modal surface it was opened over. Radix's `Dialog` locks page
 * scroll while open through `react-remove-scroll`, which listens for `wheel`
 * on `document` (non-passive, bubble) and `preventDefault`s every event whose
 * target is not inside one of its shards — and the dialog's only shard is its
 * own content. A picker floating over that dialog therefore has its wheel
 * events cancelled before the browser can scroll the list: search still
 * worked, the scrollbar still worked, the gesture did not.
 *
 * `DropdownMenu`, `ContextMenu` and `Select` never had the bug — their content
 * is modal and mounts a scroll lock of its own, which takes the top of the
 * lock stack and explicitly permits scrolling inside itself. The popover is
 * the one floating surface that stays outside every lock, so the popover is
 * where the boundary belongs.
 *
 * `stopPropagation`, never `preventDefault`: the listener only ends the
 * gesture's trip up the DOM at the surface it landed on, and the browser still
 * performs the default action — scrolling whatever scroller is under the
 * cursor inside the popover, natively, with full trackpad momentum. The lock
 * on `document` simply never hears about the gesture, so it has nothing to
 * cancel. Explicitly passive, so this can never itself become a scroll
 * blocker.
 *
 * Nothing legitimate is silenced by the stop. The app's other wheel consumers
 * are the board canvas (`use-board-canvas-pan`, listening on its own element —
 * never an ancestor of a portal) and the transcript's read-back detector
 * (`ai-elements/conversation.tsx`, whose walk over a portal target already
 * concludes "not reading back" by design — see `scroll-chaining.ts`). And the
 * gesture cannot leak past the popover either: past a body portal the only
 * scrollers left are `body`/`html`, which the shell keeps unscrollable
 * (`h-svh`), so a list scrolled to its end just stops, as it should.
 */

/** The one claim currently attached, so a new mount replaces rather than stacks. */
interface WheelClaim {
  off(): void;
}

/**
 * The ref callback that attaches (and, on the next call, detaches) the claim.
 *
 * Attachment lives in a ref callback rather than an effect because Radix's
 * `Presence` mounts the content DOM only while the popover is open — an effect
 * on this wrapper would run before any node exists and never again. React
 * calls a stable ref callback with the node on mount and `null` on unmount,
 * which is exactly the pair the listener's lifetime should have. The current
 * claim is held so a re-invocation replaces it instead of stacking a second
 * listener on the same node (dev StrictMode double-mounts; a future composed
 * ref). A listener on an unmounted node is unreachable either way, but pairing
 * the attach with a real detach keeps that true by construction rather than by
 * garbage collection.
 */
function usePopoverWheelClaim(): React.RefCallback<HTMLDivElement> {
  const claim = React.useRef<WheelClaim | null>(null);
  return React.useCallback((node) => {
    claim.current?.off();
    claim.current = null;
    if (node === null) return;
    const claimWheel = (event: WheelEvent) => event.stopPropagation();
    node.addEventListener("wheel", claimWheel, { passive: true });
    claim.current = {
      off: () => {
        node.removeEventListener("wheel", claimWheel);
      },
    };
  }, []);
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  tint = false,
  blur = true,
  showArrow = true,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  tint?: boolean;
  blur?: boolean;
  showArrow?: boolean;
}) {
  const claimWheel = usePopoverWheelClaim();
  const motion = useMotionOriginProps("popover", props, false, true);
  return (
    <PopoverPrimitive.Portal container={useOverlayLayer()}>
      <GlassSurface asChild tier={blur ? "full" : "pane"}>
        <PopoverPrimitive.Content
          data-slot="popover-content"
          data-tint={tint}
          data-glass-blur={blur ? undefined : "off"}
          align={align}
          sideOffset={sideOffset}
          avoidCollisions
          collisionPadding={8}
          className={cn(
            // `animate-none!` is important on purpose: the reduced-motion gate
            // loses the specificity fight with `data-[state=open]:animate-in`
            // without it. The full argument is on MENU_SURFACE_FADE in
            // `ui/menu-classes.ts`, which every overlay in this folder follows.
            "material-floating z-50 max-h-(--radix-popover-content-available-height) w-72 max-w-[calc(100vw-2rem)] overflow-visible origin-(--radix-popover-content-transform-origin) rounded-container border bg-popover p-4 text-ui text-foreground shadow-overlay ease-out outline-hidden [&>div:has(>[data-slot=popover-header])]:gap-2 motion-reduce:animate-none! data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            className,
          )}
          {...props}
          {...motion}
          // AFTER the spread, so a caller's `ref` riding the rest props cannot
          // clobber the composition: both halves are forwarded by hand below.
          // (The declared prop type is `ComponentProps` of Radix's forwardRef
          // component, which does not name `ref` — but React 19 delivers it
          // through props to function components regardless, so the composition
          // is live rather than theoretical.)
          ref={(node) => {
            claimWheel(node);
            const forwarded = (props as { ref?: React.Ref<HTMLDivElement | null> }).ref;
            if (typeof forwarded === "function") forwarded(node);
            else if (forwarded) forwarded.current = node;
          }}
        >
          <ControlShapeProvider context="popover">
            <div
              data-slot="popover-body"
              className="min-h-0 max-h-[calc(var(--radix-popover-content-available-height)-2rem)] overflow-y-auto overscroll-contain"
            >
              {children}
            </div>
          </ControlShapeProvider>
          {showArrow ? (
            <PopoverPrimitive.Arrow
              data-slot="popover-arrow"
              width={12}
              height={6}
              className="fill-popover stroke-border [stroke-width:0.5]"
            />
          ) : null}
        </PopoverPrimitive.Content>
      </GlassSurface>
    </PopoverPrimitive.Portal>
  );
}

/** Bind the heading to its content; the panel still owns the 16px edge inset. */
function PopoverHeader({ className, ...props }: React.ComponentProps<typeof SectionHeading>) {
  return (
    <SectionHeading
      as="h3"
      data-slot="popover-header"
      className={cn("mb-2", className)}
      {...props}
    />
  );
}

/** Bleed the scroll box, not its rows, to the panel edge. */
function PopoverScrollBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-scroll-body"
      className={cn(
        "-mx-4 -mb-4 max-h-60 overflow-y-auto overscroll-contain px-4 pb-4 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&>div]:gap-1 [&>div>div]:gap-2",
        className,
      )}
      {...props}
    />
  );
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent, PopoverHeader, PopoverScrollBody };
