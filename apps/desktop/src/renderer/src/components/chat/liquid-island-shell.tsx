import * as React from "react";
import { motion } from "motion/react";
import { middleTruncatePayload, type TurnActivity } from "@renderer/chat/turn-activity";
import type { IslandFlash } from "@volli/session-presentation";
import { liquidIslandGeometry } from "./liquid-island-geometry";
import { GLASS_MOTION } from "@renderer/lib/glass-motion";
import "./liquid-island.css";

/** The approved lively material: k=130, damping ratio=.66, unit mass. */
export const LIQUID_SPRING = {
  type: "spring",
  stiffness: 130,
  damping: 2 * 0.66 * Math.sqrt(130),
  mass: 1,
} as const;

class Spring {
  x: number;
  target: number;
  velocity = 0;
  constructor(value: number) {
    this.x = this.target = value;
  }
  snap(value: number) {
    this.x = this.target = value;
    this.velocity = 0;
  }
  step(dt: number) {
    this.velocity += (-130 * (this.x - this.target) - LIQUID_SPRING.damping * this.velocity) * dt;
    this.x += this.velocity * dt;
  }
}

function clonePicture(nodes: (Element | null)[]): HTMLDivElement {
  const picture = document.createElement("div");
  Object.assign(picture.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  picture.setAttribute("aria-hidden", "true");
  picture.inert = true;
  for (const node of nodes) if (node) picture.append(node.cloneNode(true));
  return picture;
}

interface BeadContent {
  key: string;
  word: string;
  preposition?: string;
  payload: string | null;
  waiting: boolean;
  flash: boolean;
}

/** One caption as measured: the text the bead must hold, never another's. */
interface FittedCaption {
  signature: string;
  payload: string | null;
  /** The caption's own width; the bead adds its padding. */
  textWidth: number;
  width: number;
  /** False when measured outside layout (a hidden pane); measured again once laid out. */
  laidOut: boolean;
}

/** A caption on screen: its words and the measurement taken for exactly those words. */
interface ShownCaption {
  content: BeadContent;
  fitted: FittedCaption;
}

const CAPTION_BUDGET = 226;
const BEAD_PADDING = 24;

const captionSignature = (content: BeadContent) =>
  JSON.stringify([content.key, content.word, content.preposition, content.payload, content.flash]);

/** Crossfades happen between verbs; a payload under the same verb updates in place. */
const captionIdentity = (content: BeadContent) => `${content.key}-${content.word}`;

/** How much of a caption may show in a bead this wide: none until the bead holds it. */
const captionFit = (beadWidth: number, textWidth: number | null) =>
  textWidth === null ? 0 : Math.max(0, Math.min(1, (beadWidth - textWidth - 4) / 8));

const separatorFor = (content: BeadContent) =>
  content.payload
    ? content.flash
      ? " · "
      : ` ${content.preposition ? `${content.preposition} ` : ""}`
    : "";

/**
 * Fit one caption in the hidden measuring line. The line's text is written
 * here and only here — React renders it empty — and widths are layout widths
 * (`offsetWidth`), so a transformed ancestor such as the island's entrance
 * scale cannot shrink the measurement.
 */
function fitCaption(node: HTMLElement, content: BeadContent): FittedCaption {
  const [word, separator, pay] = Array.from(node.children) as HTMLElement[];
  word!.textContent = content.word;
  separator!.textContent = separatorFor(content);
  pay!.textContent = "";
  let payload = content.payload || null;
  if (payload) {
    payload = middleTruncatePayload(payload, CAPTION_BUDGET, (candidate) => {
      pay!.textContent = candidate;
      return node.offsetWidth;
    });
    pay!.textContent = payload;
  }
  const textWidth = node.offsetWidth;
  return {
    signature: captionSignature(content),
    payload,
    textWidth,
    width: Math.min(250, Math.max(54, textWidth + BEAD_PADDING)),
    laidOut: node.getClientRects().length > 0,
  };
}

/** Keep the shell mounted long enough to drain, or draw and snap the syrup thread. */
export function useLingeringTurn(active: boolean): boolean {
  const [lingering, setLingering] = React.useState(active);
  React.useEffect(() => {
    if (active) {
      setLingering(true);
      return;
    }
    const timer = window.setTimeout(() => setLingering(false), 1100);
    return () => window.clearTimeout(timer);
  }, [active]);
  return active || lingering;
}

export function LiquidIslandShell({
  activity,
  flash,
  populated,
  exitKind,
  reduce,
  children,
}: {
  activity: TurnActivity | null;
  flash: IslandFlash | null;
  populated: boolean;
  exitKind: "done" | "abort";
  reduce: boolean;
  children: React.ReactNode;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const clusters = React.useRef<HTMLDivElement>(null);
  const svg = React.useRef<SVGSVGElement>(null);
  const shell = React.useRef<SVGPathElement>(null);
  const mask = React.useRef<SVGPathElement>(null);
  const border = React.useRef<SVGPathElement>(null);
  const drop = React.useRef<SVGPathElement>(null);
  const dropMask = React.useRef<SVGPathElement>(null);
  const dropBorder = React.useRef<SVGPathElement>(null);
  const label = React.useRef<HTMLDivElement>(null);
  const measure = React.useRef<HTMLSpanElement>(null);
  const maskId = React.useId().replaceAll(":", "");
  const previousPicture = React.useRef<HTMLDivElement | null>(null);
  // Keyed on the words, not the objects: a streamed chunk hands the island a
  // new `activity` object with the same words, and that must not re-measure,
  // re-render the caption or wake the draw loop.
  const flashId = flash?.id;
  const flashEvent = flash?.event;
  const flashPayload = flash?.payload;
  const activityKey = activity?.key;
  const activityWord = activity?.word;
  const activityPreposition = activity?.preposition;
  const activityPayload = activity?.payload;
  const activityWaiting = activity?.waiting;
  const current = React.useMemo<BeadContent | null>(
    () =>
      flashId !== undefined
        ? {
            key: `flash-${flashId}`,
            word: flashEvent ?? "",
            payload: (flashPayload ?? "").replace(/\s+/gu, " ").trim(),
            waiting: false,
            flash: true,
          }
        : activityKey !== undefined
          ? {
              key: activityKey,
              word: activityWord ?? "",
              ...(activityPreposition ? { preposition: activityPreposition } : {}),
              payload: activityPayload?.replace(/\s+/gu, " ").trim() ?? null,
              waiting: activityWaiting ?? false,
              flash: false,
            }
          : null,
    [
      flashId,
      flashEvent,
      flashPayload,
      activityKey,
      activityWord,
      activityPreposition,
      activityPayload,
      activityWaiting,
    ],
  );
  // An exiting turn keeps its last words, but not its shimmer. This is only
  // ephemeral drawing state; a new event always replaces it immediately.
  const [last, setLast] = React.useState<BeadContent | null>(current);
  React.useEffect(() => {
    if (current) setLast(current);
  }, [current]);
  const content = current ?? last;
  const signature = content ? captionSignature(content) : null;
  const [fitted, setFitted] = React.useState<FittedCaption | null>(null);
  const latestContent = React.useRef(content);
  const latestFitted = React.useRef(fitted);
  const refit = React.useCallback(() => {
    const node = measure.current;
    const next = latestContent.current;
    if (!node || !next) return;
    const caption = fitCaption(node, next);
    latestFitted.current = caption;
    setFitted((prior) =>
      prior &&
      prior.signature === caption.signature &&
      prior.payload === caption.payload &&
      prior.textWidth === caption.textWidth &&
      prior.laidOut === caption.laidOut
        ? prior
        : caption,
    );
  }, []);
  React.useLayoutEffect(() => {
    latestContent.current = content;
    if (signature !== null && latestFitted.current?.signature !== signature) refit();
  }, [content, signature, refit]);
  // Measured again when the line itself changes size without new words: a
  // hidden pane laid out at last, or the face swapping in after a font load.
  React.useLayoutEffect(() => {
    const node = measure.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const prior = latestFitted.current;
      if (prior && (!prior.laidOut || node.offsetWidth !== prior.textWidth)) refit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [refit]);

  // The caption on screen. It changes verb only after the previous one has
  // faded out (or at once, the first time), and it always carries the
  // measurement taken for its own words. The fade's completion swaps it, and a
  // timer backs that up: an exit that never reports completion (as Motion's
  // `AnimatePresence mode="wait"` did when a verb changed within a frame of
  // the next caption mounting) must not freeze the caption for the turn.
  const fade = reduce ? GLASS_MOTION.menuOutSeconds : GLASS_MOTION.inspectorLabelSeconds;
  const target = React.useMemo<ShownCaption | null>(
    () => (content && fitted && fitted.signature === signature ? { content, fitted } : null),
    [content, fitted, signature],
  );
  const [shown, setShown] = React.useState<ShownCaption | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const latestTarget = React.useRef(target);
  // A caption present when the shell mounts appears with it, as the shell does.
  const [quietFirstCaption, setQuietFirstCaption] = React.useState(content !== null);
  React.useLayoutEffect(() => {
    latestTarget.current = target;
    if (!target) return;
    if (!shown || captionIdentity(shown.content) === captionIdentity(target.content)) {
      if (shown?.content !== target.content || shown.fitted !== target.fitted) setShown(target);
      setLeaving(false);
    } else setLeaving(true);
  }, [target, shown]);
  const leavingNow = React.useRef(leaving);
  const finishLeaving = React.useCallback(() => {
    if (!leavingNow.current) return;
    leavingNow.current = false;
    if (latestTarget.current) setShown(latestTarget.current);
    setLeaving(false);
    setQuietFirstCaption(false);
  }, []);
  React.useLayoutEffect(() => {
    leavingNow.current = leaving;
  }, [leaving]);
  React.useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(finishLeaving, fade * 1000 + 50);
    return () => window.clearTimeout(timer);
  }, [leaving, fade, finishLeaving]);

  const drawing = React.useRef<{
    presence: Spring;
    width: Spring;
    cluster: Spring;
    island: Spring;
    stretch: Spring;
    gulp: Spring;
    mode: "hidden" | "attached" | "absorbing" | "pinching" | "detached" | "dropping";
    pinchTime: number;
    fade: number;
    previousKey: string | null;
    active: boolean;
    /** The bead width and caption presence last drawn, for gating a caption between frames. */
    drawnWidth: number;
    drawnPresence: number;
  } | null>(null);
  if (drawing.current === null)
    drawing.current = {
      presence: new Spring(0),
      width: new Spring(70),
      cluster: new Spring(populated ? 1 : 0),
      island: new Spring(32),
      stretch: new Spring(0),
      gulp: new Spring(0),
      mode: "hidden",
      pinchTime: 0,
      fade: 1,
      previousKey: null,
      active: false,
      drawnWidth: 0,
      drawnPresence: 0,
    };
  const beadActive = activity !== null || flash !== null;
  const wake = React.useRef<(() => void) | null>(null);
  const inputs = React.useRef({
    active: activity !== null || flash !== null,
    populated,
    exitKind,
    reduce,
    fitted,
    content,
    shownTextWidth: shown?.fitted.textWidth ?? null,
  });
  React.useLayoutEffect(() => {
    const next = {
      active: activity !== null || flash !== null,
      populated,
      exitKind,
      reduce,
      fitted,
      content,
      shownTextWidth: shown?.fitted.textWidth ?? null,
    };
    const prior = inputs.current;
    inputs.current = next;
    // Only a changed input can move the drawing; a render that changed
    // nothing the drawing reads (a streamed chunk) requests no frame.
    if ((Object.keys(next) as (keyof typeof next)[]).every((key) => next[key] === prior[key]))
      return;
    // A new caption may commit after this frame's draw. Gate it against the
    // bead already on screen now, so no painted frame shows it uncontained.
    const s = drawing.current!;
    if (label.current && next.shownTextWidth !== prior.shownTextWidth)
      label.current.style.opacity = String(
        s.drawnPresence * captionFit(s.drawnWidth, next.shownTextWidth),
      );
    wake.current?.();
  });

  React.useLayoutEffect(() => {
    if (!reduce || !svg.current) return;
    // Crossfade the whole picture, including text, rather than teleporting the
    // verb between the plain pill and the rim. The clone is inert and temporary.
    // The last drawn frame was captured BEFORE React removed outgoing controls.
    const ghost = previousPicture.current?.cloneNode(true) as HTMLDivElement | undefined;
    if (!ghost) return;
    ghost.inert = true;
    ghost.setAttribute("data-liquid-island-ghost", "");
    // The clone needs its own mask id so it cannot resolve the live mask.
    ghost.querySelectorAll("mask").forEach((entry) => {
      const id = entry.id;
      entry.id = `${id}-ghost`;
      ghost.querySelectorAll("[mask]").forEach((node) => {
        if (node.getAttribute("mask") === `url(#${id})`)
          node.setAttribute("mask", `url(#${id}-ghost)`);
      });
    });
    root.current?.prepend(ghost);
    const animation = ghost.animate?.([{ opacity: 1 }, { opacity: 0 }], {
      duration: GLASS_MOTION.menuIn,
      fill: "forwards",
    });
    if (animation) animation.onfinish = () => ghost.remove();
    else ghost.remove();
    const arrivals = [svg.current, clusters.current, label.current].map((node) =>
      node?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: GLASS_MOTION.menuIn }),
    );
    return () => {
      animation?.cancel();
      arrivals.forEach((arrival) => arrival?.cancel());
      ghost.remove();
    };
  }, [populated, reduce, beadActive]);

  React.useLayoutEffect(() => {
    let frame = 0;
    let previous = performance.now();
    const draw = (now: number) => {
      frame = 0;
      const s = drawing.current!;
      const input = inputs.current;
      const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previous = now;
      const active = input.active;
      if (active && !s.active) {
        s.mode = "attached";
        s.fade = 1;
        s.pinchTime = 0;
        s.stretch.snap(0);
        s.presence.target = 1;
      } else if (!active && s.active) {
        s.mode =
          input.reduce || input.exitKind === "done"
            ? "absorbing"
            : s.cluster.x < 0.5
              ? "dropping"
              : "pinching";
        s.pinchTime = 0;
        s.presence.target = 0;
        // The thread holds the bead's volume until the snap.
        if (s.mode === "pinching") s.presence.snap(1);
      }
      s.active = active;
      const nextWidth = input.fitted?.width ?? 70;
      if (input.content?.key !== s.previousKey) {
        s.previousKey = input.content?.key ?? null;
        s.width.target = nextWidth;
        if (!input.reduce) s.stretch.velocity += input.content?.flash ? 70 : 40;
      }
      s.width.target = nextWidth;
      s.cluster.target = input.populated ? 1 : 0;
      const measured = clusters.current?.getBoundingClientRect().width ?? 0;
      if (input.populated && measured > 0) s.island.target = measured;
      if (input.reduce) {
        s.width.snap(nextWidth);
        s.cluster.snap(input.populated ? 1 : 0);
        s.island.snap(s.island.target);
        // The previous picture fades above this one; geometry changes instantly.
        s.presence.snap(active ? 1 : 0);
      } else {
        const steps = Math.max(1, Math.ceil(dt * 240));
        for (let i = 0; i < steps; i++) {
          for (const sp of [s.presence, s.width, s.cluster, s.island, s.stretch, s.gulp])
            sp.step(dt / steps);
        }
      }
      if (s.mode === "pinching") {
        s.pinchTime = Math.min(1, s.pinchTime + dt / 0.55);
        s.stretch.snap(s.pinchTime ** 2 * 110);
        if (s.pinchTime >= 1) {
          s.mode = "detached";
          s.gulp.velocity += 1.4;
        }
      }
      if (s.mode === "detached") s.fade = Math.max(0, s.fade - dt * 3.4);
      if (s.mode === "dropping") s.fade = Math.max(0, s.fade - dt / 0.16);
      if ((s.mode === "detached" || s.mode === "dropping") && s.fade === 0) {
        s.mode = "hidden";
        s.presence.snap(0);
      }
      if (s.mode === "absorbing" && s.presence.x < 0.03 && Math.abs(s.presence.velocity) < 0.5) {
        s.mode = "hidden";
        s.presence.snap(0);
        if (input.populated && !input.reduce) s.gulp.velocity += 1.1;
      }
      const g = liquidIslandGeometry({
        islandWidth: s.island.x,
        cluster: s.cluster.x,
        width: s.width.x,
        presence: s.presence.x,
        stretch: s.stretch.x,
        pinch: s.pinchTime ** 2,
        detached: s.mode === "detached",
        fade: s.fade,
        dropping: s.mode === "dropping",
        squash: s.width.velocity * 0.0011,
        gulp: s.gulp.x,
        reduce: input.reduce,
      });
      const standaloneFade = input.reduce
        ? Math.min(1, s.presence.x)
        : s.fade * (s.cluster.x < 0.01 ? Math.min(1, s.presence.x) : 1);
      // A single fill of the union prevents translucent material darkening at
      // overlaps. The outside-only outline suppresses buried capsule seams.
      const combined = g.shell + (s.mode !== "detached" ? g.bead : "");
      shell.current?.setAttribute("d", combined);
      mask.current?.setAttribute("d", combined);
      border.current?.setAttribute("d", combined);
      if (shell.current && border.current) {
        const alpha = input.populated ? 1 : standaloneFade;
        shell.current.style.opacity = String(alpha);
        border.current.style.opacity = String(alpha);
      }
      drop.current?.setAttribute("d", s.mode === "detached" ? g.bead : "");
      dropMask.current?.setAttribute("d", s.mode === "detached" ? g.bead : "");
      dropBorder.current?.setAttribute("d", s.mode === "detached" ? g.bead : "");
      if (drop.current && dropBorder.current) {
        drop.current.style.opacity = String(s.fade);
        dropBorder.current.style.opacity = String(s.fade);
      }
      if (root.current)
        root.current.style.width = `${Math.max(0, s.island.x * Math.min(1, s.cluster.x) + g.width * (1 - Math.min(1, s.cluster.x)))}px`;
      if (clusters.current) clusters.current.style.opacity = String(g.clusterOpacity);
      if (label.current) {
        // Gate on the caption actually drawn, not the one the bead is heading
        // for: a caption shows only while the bead holds it.
        s.drawnWidth = g.width;
        s.drawnPresence = Math.max(0, Math.min(1, (s.presence.x - 0.55) / 0.45)) * standaloneFade;
        const fit = captionFit(g.width, input.shownTextWidth);
        Object.assign(label.current.style, {
          width: `${g.width}px`,
          height: `${g.height}px`,
          top: `${g.top}px`,
          opacity: String(s.drawnPresence * fit),
          visibility: s.mode === "hidden" ? "hidden" : "visible",
        });
      }
      if (input.reduce)
        previousPicture.current = clonePicture([svg.current, clusters.current, label.current]);
      const moving = [s.presence, s.width, s.cluster, s.island, s.stretch, s.gulp].some(
        (sp) => Math.abs(sp.x - sp.target) > 0.01 || Math.abs(sp.velocity) > 0.02,
      );
      if (
        moving ||
        s.mode === "absorbing" ||
        s.mode === "pinching" ||
        s.mode === "detached" ||
        s.mode === "dropping"
      )
        frame = requestAnimationFrame(draw);
    };
    wake.current = () => {
      if (!frame) {
        previous = performance.now();
        frame = requestAnimationFrame(draw);
      }
    };
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => wake.current?.());
    if (clusters.current) observer?.observe(clusters.current);
    draw(previous);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      wake.current = null;
    };
  }, []);

  return (
    <div
      ref={root}
      className="liquid-island-shell"
      data-liquid-island={populated ? "bead" : "pill"}
      data-turn-exit={activity ? undefined : exitKind}
    >
      <svg
        ref={svg}
        aria-hidden
        className="liquid-island-surface"
        width="1"
        height="32"
        viewBox="-0.5 0 1 32"
      >
        <defs>
          <mask
            id={maskId}
            style={{ maskType: "luminance" }}
            maskUnits="userSpaceOnUse"
            x="-1000"
            y="-500"
            width="2000"
            height="1000"
          >
            <rect x="-1000" y="-500" width="2000" height="1000" fill="white" />
            <path ref={mask} fill="black" />
          </mask>
          <mask
            id={`${maskId}-drop`}
            style={{ maskType: "luminance" }}
            maskUnits="userSpaceOnUse"
            x="-1000"
            y="-500"
            width="2000"
            height="1000"
          >
            <rect x="-1000" y="-500" width="2000" height="1000" fill="white" />
            <path ref={dropMask} fill="black" />
          </mask>
        </defs>
        <g className="liquid-island-material">
          <path
            ref={border}
            fill="none"
            stroke="var(--border)"
            strokeWidth="2"
            mask={`url(#${maskId})`}
          />
          <path ref={shell} fill="var(--card)" />
          <path
            ref={dropBorder}
            fill="none"
            stroke="var(--border)"
            strokeWidth="2"
            mask={`url(#${maskId}-drop)`}
          />
          <path ref={drop} fill="var(--card)" />
        </g>
      </svg>
      <div
        ref={clusters}
        className="liquid-island-clusters"
        aria-hidden={!populated}
        style={{ pointerEvents: populated ? undefined : "none" }}
      >
        {children}
      </div>
      <div
        ref={label}
        aria-hidden
        className="liquid-island-label text-ui"
        data-island-verb={activity ? "" : undefined}
        data-island-flash={flash ? "" : undefined}
      >
        {shown ? (
          <motion.span
            key={captionIdentity(shown.content)}
            className={
              shown.content.waiting
                ? "liquid-island-waiting"
                : activity && !shown.content.flash && !reduce
                  ? "liquid-island-shimmer"
                  : undefined
            }
            initial={quietFirstCaption ? false : { opacity: 0 }}
            animate={{ opacity: leaving ? 0 : 1 }}
            transition={{ duration: fade }}
            onAnimationComplete={leaving ? finishLeaving : undefined}
          >
            <span className="liquid-island-word">{shown.content.word}</span>
            {shown.fitted.payload ? (
              <>
                <span>{separatorFor(shown.content)}</span>
                <strong>{shown.fitted.payload}</strong>
              </>
            ) : null}
          </motion.span>
        ) : null}
      </div>
      {/* Written only by `fitCaption`; React keeps these three nodes empty. */}
      <span ref={measure} aria-hidden className="liquid-island-measure text-ui">
        <span className="liquid-island-word" />
        <span />
        <strong />
      </span>
    </div>
  );
}
