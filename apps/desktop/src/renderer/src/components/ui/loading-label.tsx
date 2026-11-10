import type { ReactNode } from "react";
import { Spinner } from "./spinner";

/** In-progress copy has a mark, never a punctuation animation. */
export function LoadingLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 align-middle">
      <Spinner aria-hidden role="presentation" className="shrink-0" />
      <span>{children}</span>
    </span>
  );
}
