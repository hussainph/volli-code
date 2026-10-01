/** The identity mark's material is local; notification tokens never enter it. */
import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { TreeIcon } from "@phosphor-icons/react/dist/csr/Tree";
import { LeafIcon } from "@phosphor-icons/react/dist/csr/Leaf";
import { MountainsIcon } from "@phosphor-icons/react/dist/csr/Mountains";
import { FlameIcon } from "@phosphor-icons/react/dist/csr/Flame";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { PlanetIcon } from "@phosphor-icons/react/dist/csr/Planet";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { RocketIcon } from "@phosphor-icons/react/dist/csr/Rocket";
import { PaperPlaneIcon } from "@phosphor-icons/react/dist/csr/PaperPlane";
import { ScrollIcon } from "@phosphor-icons/react/dist/csr/Scroll";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { PackageIcon } from "@phosphor-icons/react/dist/csr/Package";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { CircuitryIcon } from "@phosphor-icons/react/dist/csr/Circuitry";
import { AtomIcon } from "@phosphor-icons/react/dist/csr/Atom";
import { MusicNotesIcon } from "@phosphor-icons/react/dist/csr/MusicNotes";
import { WavesIcon } from "@phosphor-icons/react/dist/csr/Waves";
import { CoffeeIcon } from "@phosphor-icons/react/dist/csr/Coffee";
import { BirdIcon } from "@phosphor-icons/react/dist/csr/Bird";
import { FlowerIcon } from "@phosphor-icons/react/dist/csr/Flower";
import { CompassIcon } from "@phosphor-icons/react/dist/csr/Compass";
import { DiamondIcon } from "@phosphor-icons/react/dist/csr/Diamond";
import {
  canvasBackground,
  canvasInk,
  deriveCanvasTokens,
  monogram,
  type Canvas,
} from "@volli/shared";

import { useThemeStore } from "@renderer/stores/theme";
import { resolveActiveTheme } from "@renderer/theme/apply";

import { proceduralStamp, type GlyphName, type IdentityChoice } from "./model";

export const GLYPH_COMPONENTS = {
  code: CodeIcon,
  tree: TreeIcon,
  leaf: LeafIcon,
  mountains: MountainsIcon,
  flame: FlameIcon,
  sparkle: SparkleIcon,
  planet: PlanetIcon,
  moon: MoonIcon,
  rocket: RocketIcon,
  "paper-plane": PaperPlaneIcon,
  scroll: ScrollIcon,
  "book-open": BookOpenIcon,
  archive: ArchiveIcon,
  package: PackageIcon,
  "git-branch": GitBranchIcon,
  circuitry: CircuitryIcon,
  atom: AtomIcon,
  "music-notes": MusicNotesIcon,
  waves: WavesIcon,
  coffee: CoffeeIcon,
  bird: BirdIcon,
  flower: FlowerIcon,
  compass: CompassIcon,
  diamond: DiamondIcon,
} satisfies Record<GlyphName, typeof CodeIcon>;

export type StudioChoice = IdentityChoice;
export type StudioSurface = "etched" | "porcelain" | "orbit" | "letterpress";
export type MonogramStyle = "editorial" | "architect" | "woven";
export const SURFACES: Record<StudioSurface, string> = {
  etched: "Etched",
  porcelain: "Porcelain",
  orbit: "Orbit",
  letterpress: "Letterpress",
};

export function useMarkMaterial(
  canvasOverride: Canvas | null,
  appearanceOverride: "light" | "dark" | "auto" | null = null,
): React.CSSProperties {
  const canvas = useThemeStore((state) => state.preview ?? state.globalCanvas);
  const appearance = useThemeStore((state) => state.previewAppearance ?? state.globalAppearance);
  const prefersDark = useThemeStore((state) => state.systemPrefersDark);
  return React.useMemo(() => {
    const active = resolveActiveTheme(
      canvas,
      appearance,
      {
        canvas: canvasOverride,
        appearance: appearanceOverride,
        terminalThemeName: null,
      },
      prefersDark,
    );
    const tokens = deriveCanvasTokens(active.canvas.value, active.resolved);
    return {
      "--mark-canvas": canvasBackground(active.canvas.value, active.resolved),
      "--mark-ink": canvasInk(active.canvas.value, active.resolved).ink,
      "--mark-paper": tokens["--card"],
      "--mark-paper-ink": tokens["--foreground"],
    } as React.CSSProperties;
  }, [canvas, appearance, prefersDark, canvasOverride, appearanceOverride]);
}

function Stamp({ seed, variant }: { seed: string; variant: number }) {
  // Spatial coordinates, not array order, are the identity of a printed cell.
  const pixels = proceduralStamp(seed, variant).flatMap((row, y) =>
    row.flatMap((filled, x) => (filled ? [{ id: `pixel-${x}-${y}`, x, y }] : [])),
  );
  return (
    <svg className="studio-stamp" viewBox="0 0 50 50" aria-hidden>
      {pixels.map((pixel) => (
        <rect
          key={pixel.id}
          x={pixel.x * 10 + 1}
          y={pixel.y * 10 + 1}
          width="8"
          height="8"
          rx="2"
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

export function IdentityMark({
  choice,
  name,
  surface = "etched",
  size = "sample",
  monogramStyle = "editorial",
  canvas = null,
  appearance = null,
  onImageError,
}: {
  choice: StudioChoice;
  name: string;
  surface?: StudioSurface;
  size?: "hero" | "sample" | "rail";
  monogramStyle?: MonogramStyle;
  canvas?: Canvas | null;
  appearance?: "light" | "dark" | "auto" | null;
  onImageError?: () => void;
}) {
  const material = useMarkMaterial(canvas, appearance);
  const Glyph = choice.kind === "glyph" ? GLYPH_COMPONENTS[choice.name] : null;
  const letters = monogram(name);
  return (
    <span
      className="studio-mark"
      style={material}
      data-surface={surface}
      data-size={size}
      data-monogram={monogramStyle}
      data-identity-kind={choice.kind}
      data-glyph={choice.kind === "glyph" ? choice.name : undefined}
      data-stamp-variant={choice.kind === "stamp" ? choice.variant : undefined}
      aria-hidden
    >
      <span className="studio-mark-rim" />
      <span className="studio-mark-orbit" />
      <span className="studio-mark-face">
        {Glyph ? (
          <Glyph className="studio-glyph" weight={surface === "porcelain" ? "fill" : "regular"} />
        ) : null}
        {choice.kind === "initials" && (
          <span className="studio-monogram">
            {monogramStyle === "woven" ? (
              <>
                <span>{letters[0]}</span>
                {letters[1] && <span>{letters[1]}</span>}
              </>
            ) : (
              letters
            )}
          </span>
        )}
        {choice.kind === "stamp" && <Stamp seed={choice.seed} variant={choice.variant} />}
        {choice.kind === "custom" && (
          <img className="studio-custom" src={choice.dataUrl} alt="" onError={onImageError} />
        )}
      </span>
      <span className="studio-mark-glint" />
    </span>
  );
}

/** Rare onboarding delight, never a moving target on the navigation rail.
 * Pointer-only tilt uses a gesture spring; keyboard and reduced-motion stay still.
 * The full transform string keeps Motion's accelerated animation path available.
 */
export function HeroMark(
  props: React.ComponentProps<typeof IdentityMark> & {
    motionEnabled: boolean;
    animateReveal: boolean;
    revision: number;
  },
) {
  const reduce = useReducedMotion();
  const [tilt, setTilt] = React.useState({ x: 0, y: 0 });
  const canTilt = props.motionEnabled && !reduce;
  React.useEffect(() => {
    if (!canTilt) setTilt({ x: 0, y: 0 });
  }, [canTilt]);
  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (
      !canTilt ||
      event.pointerType !== "mouse" ||
      !window.matchMedia("(hover: hover) and (pointer: fine)").matches
    )
      return;
    const box = event.currentTarget.getBoundingClientRect();
    setTilt({
      x: ((event.clientY - box.top) / box.height - 0.5) * -12,
      y: ((event.clientX - box.left) / box.width - 0.5) * 16,
    });
  }
  return (
    <div
      className="studio-hero-stage"
      onPointerMove={move}
      onPointerLeave={() => setTilt({ x: 0, y: 0 })}
    >
      <span className="studio-orbit-track" aria-hidden />
      <span className="studio-orbit-track studio-orbit-track-secondary" aria-hidden />
      <span className="studio-hero-star studio-hero-star-one" aria-hidden>
        <SparkleIcon />
      </span>
      <span className="studio-hero-star studio-hero-star-two" aria-hidden>
        <SparkleIcon />
      </span>
      <motion.div
        className="studio-hero-object"
        animate={{
          transform: canTilt
            ? `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`
            : "rotateX(0deg) rotateY(0deg)",
        }}
        transition={canTilt ? { type: "spring", duration: 0.5, bounce: 0.2 } : { duration: 0 }}
      >
        <span
          key={props.revision}
          className="studio-hero-reveal"
          data-animate={props.motionEnabled && props.animateReveal && !reduce}
        >
          <IdentityMark {...props} size="hero" />
        </span>
      </motion.div>
    </div>
  );
}
