import * as React from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** Live `prefers-reduced-motion` flag; drives JS-side animation opt-outs. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(() => window.matchMedia(QUERY).matches);

  React.useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
