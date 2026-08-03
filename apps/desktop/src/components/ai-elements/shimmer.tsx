"use client";

import { cn } from "@renderer/lib/utils";
import type { MotionProps } from "motion/react";
import { motion } from "motion/react";
import type { CSSProperties, ElementType, JSX } from "react";
import { memo, useMemo } from "react";

type MotionHTMLProps = MotionProps & Record<string, unknown>;

// Cache motion components at module level to avoid creating during render
const motionComponentCache = new Map<
  keyof JSX.IntrinsicElements,
  React.ComponentType<MotionHTMLProps>
>();

const getMotionComponent = (element: keyof JSX.IntrinsicElements) => {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
};

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

/**
 * The sweep. `--shimmer-highlight` carries a literal fallback because this
 * gradient is the *decoration* layer: if the token ever fails to resolve the
 * declaration is dropped and the overlay simply paints nothing.
 */
const SWEEP =
  "bg-[length:250%_100%] bg-clip-text text-transparent [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--shimmer-highlight),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat]";

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const MotionComponent = getMotionComponent("span");

  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  // Two layers, and the order matters. The words below are painted by ordinary
  // `color`, inherited from the row; the sweep above is an aria-hidden copy that
  // exists only to be clipped to the glyphs. A single-element version has to set
  // `color: transparent` so the clip shows through, which makes the gradient the
  // sole source of colour — and then any unresolvable token in it (a pruned
  // `--color-*`, or `currentColor`, which by then *is* the transparency) drops
  // the whole declaration and the text renders as nothing at full width. Split
  // this way the worst case is a line that does not shimmer.
  return (
    <Component className={cn("relative inline-block", className)}>
      {children}
      <MotionComponent
        aria-hidden
        animate={{ backgroundPosition: "0% center" }}
        // `select-none` as well as `aria-hidden`: the overlay is a second copy
        // of the same words, so without it a drag-select would carry the line
        // twice into the clipboard.
        className={cn("pointer-events-none absolute inset-0 select-none", className, SWEEP)}
        initial={{ backgroundPosition: "100% center" }}
        style={
          {
            "--spread": `${dynamicSpread}px`,
            "--shimmer-highlight": "var(--foreground, #fff)",
            backgroundImage: "var(--bg)",
          } as CSSProperties
        }
        transition={{
          duration,
          ease: "linear",
          repeat: Number.POSITIVE_INFINITY,
        }}
      >
        {children}
      </MotionComponent>
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
