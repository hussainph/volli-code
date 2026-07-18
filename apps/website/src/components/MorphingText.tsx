import { useEffect, useRef, useSyncExternalStore } from "react";

interface MorphingTextProps {
  texts: string[];
}

const subscribeReducedMotion = (onChange: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};

const getReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const getServerReducedMotion = () => false;

const setWordStyle = (element: HTMLSpanElement, fraction: number) => {
  const safeFraction = Math.max(0.001, fraction);
  const blur = Math.min(8 / safeFraction - 8, 80);
  element.style.filter = `blur(${blur}px)`;
  element.style.opacity = `${Math.pow(fraction, 0.42)}`;
};

export default function MorphingText({ texts }: MorphingTextProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const nextRef = useRef<HTMLSpanElement>(null);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    getServerReducedMotion,
  );

  useEffect(() => {
    const root = rootRef.current;
    const current = currentRef.current;
    const next = nextRef.current;
    if (!root || !current || !next || texts.length < 2 || reducedMotion) return;

    const holdTime = 1800;
    const morphTime = 900;
    const cycleTime = holdTime + morphTime;
    let animationFrame = 0;
    let startTime = 0;
    let visible = false;
    let renderedIndex = -1;

    const render = (now: number) => {
      if (!startTime) startTime = now;
      const elapsed = now - startTime;
      const cycle = Math.floor(elapsed / cycleTime);
      const index = cycle % texts.length;
      const nextIndex = (index + 1) % texts.length;

      if (renderedIndex !== index) {
        current.textContent = texts[index];
        next.textContent = texts[nextIndex];
        renderedIndex = index;
      }

      const cycleProgress = elapsed % cycleTime;
      const fraction = cycleProgress < holdTime ? 0 : (cycleProgress - holdTime) / morphTime;
      setWordStyle(current, 1 - fraction);
      setWordStyle(next, fraction);
      animationFrame = requestAnimationFrame(render);
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      cancelAnimationFrame(animationFrame);
      if (visible) {
        startTime = 0;
        renderedIndex = -1;
        animationFrame = requestAnimationFrame(render);
      }
    });

    observer.observe(root);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
    };
  }, [reducedMotion, texts]);

  const firstText = texts[0] ?? "the workspace";

  return (
    <>
      <span ref={rootRef} className="morphing-text" aria-hidden="true">
        <span ref={currentRef} className="morphing-text__word">
          {firstText}
        </span>
        <span ref={nextRef} className="morphing-text__word morphing-text__word--next">
          {texts[1] ?? firstText}
        </span>
      </span>
      <span className="visually-hidden">{texts.join(", ")}</span>
    </>
  );
}
