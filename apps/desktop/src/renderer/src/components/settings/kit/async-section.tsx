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
import { type IconComponent, WarningIcon } from "@renderer/components/ui/icon";

import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { loadingRegionProps } from "@renderer/components/ui/loading-region";
import { Notice } from "@renderer/components/ui/notice";
import { Skeleton } from "@renderer/components/ui/skeleton";

import { PrefSection } from "./pref-section";

/** What a fetched collection can be. Exhaustive by construction. */
export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string; onRetry: () => void }
  | { status: "ready"; data: T };

/** The skeleton a first read draws. Uses the repo's primitive. */
function LoadingRows({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="flex flex-col divide-y divide-border" {...loadingRegionProps(label)}>
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex min-h-16 items-center justify-between gap-6 px-4 py-4">
          <div className="w-2/3 space-y-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <Skeleton className="h-6 w-20" />
        </div>
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
    <Notice
      tone="error"
      icon={WarningIcon}
      title={message}
      className="m-4"
      announce
      actions={
        <Button size="xs" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className={`${EMPTY_INLINE} px-4`}>{children}</p>;
}

export function AsyncSection<T>({
  title,
  icon,
  action,
  before,
  fill,
  state,
  isEmpty,
  empty,
  children,
}: {
  title: string;
  icon?: IconComponent;
  action?: React.ReactNode;
  /** Content that stays useful while this fetched collection changes state. */
  before?: React.ReactNode;
  /**
   * Passed through to {@link PrefSection}. Only the READY branch fills — a
   * spinner or an error stretched down a tall column reads as a broken page,
   * and all in-flow states stay left-aligned in their section column.
   */
  fill?: boolean;
  state: AsyncState<T>;
  isEmpty?: (data: T) => boolean;
  empty?: string;
  children: (data: T) => React.ReactNode;
}) {
  return (
    <PrefSection
      title={title}
      icon={icon}
      action={action}
      fill={fill && state.status === "ready" && !isEmpty?.(state.data)}
    >
      {before}
      {state.status === "loading" ? <LoadingRows label={title} /> : null}
      {state.status === "error" ? (
        <ErrorRow message={state.message} onRetry={state.onRetry} />
      ) : null}
      {state.status === "ready" ? (
        isEmpty?.(state.data) ? (
          <Empty>{empty ?? "Nothing yet"}</Empty>
        ) : (
          children(state.data)
        )
      ) : null}
    </PrefSection>
  );
}
