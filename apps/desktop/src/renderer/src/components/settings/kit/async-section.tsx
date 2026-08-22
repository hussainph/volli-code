/**
 * The vocabulary for a section whose body is fetched.
 *
 * Every collection on these surfaces declares four states — loading, error,
 * empty, no-results — because the happy path is the 20% of a settings surface
 * that is easy. The pane this replaces drew only that 20%: a failed read and a
 * genuinely empty list rendered the same pixels, which meant "No orphaned
 * worktrees" (the one sentence that makes leftover work safe to forget about)
 * was also what a broken read said.
 */
import type * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { Button } from "@renderer/components/ui/button";
import { Skeleton } from "@renderer/components/ui/skeleton";

import { PrefSection } from "./pref-section";

/** What a fetched collection can be. Exhaustive by construction. */
export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string; onRetry: () => void }
  | { status: "ready"; data: T };

/** The skeleton a first read draws. Uses the repo's primitive. */
function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 py-4" aria-live="polite" aria-busy>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full rounded-lg" />
      ))}
    </div>
  );
}

/**
 * A failed read, with its recovery beside it.
 *
 * The retry lives here rather than in a toast for the reason the audit found
 * the hard way: a failure whose Retry is in a dismissed toast is a failure
 * with no way back.
 */
function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2 py-4 text-ui">
      <WarningIcon aria-hidden className="size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 text-muted-foreground">{message}</span>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-ui text-muted-foreground">{children}</p>;
}

export function AsyncSection<T>({
  title,
  icon,
  hint,
  action,
  before,
  state,
  isEmpty,
  empty,
  children,
}: {
  title: string;
  icon?: PhosphorIcon;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  /** Content that stays useful while this fetched collection changes state. */
  before?: React.ReactNode;
  state: AsyncState<T>;
  isEmpty?: (data: T) => boolean;
  empty?: string;
  children: (data: T) => React.ReactNode;
}) {
  return (
    <PrefSection title={title} icon={icon} hint={hint} action={action}>
      {before}
      {state.status === "loading" ? <LoadingRows /> : null}
      {state.status === "error" ? (
        <ErrorRow message={state.message} onRetry={state.onRetry} />
      ) : null}
      {state.status === "ready" ? (
        isEmpty?.(state.data) ? (
          <Empty>{empty ?? "Nothing here yet."}</Empty>
        ) : (
          children(state.data)
        )
      ) : null}
    </PrefSection>
  );
}
