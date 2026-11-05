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
import { type IconComponent } from "@renderer/components/ui/icon";

import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { loadingRegionProps } from "@renderer/components/ui/loading-region";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import { PanelEmptyState, type EmptyIllustration } from "@renderer/components/ui/empty-state";

import { PrefSection } from "./pref-section";

/** What a fetched collection can be. Exhaustive by construction. */
export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string; onRetry: () => void }
  | { status: "ready"; data: T };

/** A held loading region; never a successful empty state. */
function LoadingRows({ label }: { label: string }) {
  return (
    <div className="min-h-16 p-4" {...loadingRegionProps(label)}>
      <LoadingLabel>Loading {label.toLowerCase()}</LoadingLabel>
    </div>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <PanelEmptyState
      illustration="failed"
      status="failed"
      title={message}
      action={{ label: "Try again", onAction: onRetry }}
    />
  );
}

/** Legacy collection adapter; pending/status nodes are deliberately not empties. */
export function Empty({
  children,
  illustration = "file",
  line,
  action,
  plain = false,
}: {
  children: React.ReactNode;
  illustration?: EmptyIllustration;
  line?: string;
  action?: React.ComponentProps<typeof PanelEmptyState>["action"];
  plain?: boolean;
}) {
  return !plain && typeof children === "string" ? (
    <PanelEmptyState illustration={illustration} title={children} line={line} action={action} />
  ) : (
    <div className={`${EMPTY_INLINE} px-4`}>{children}</div>
  );
}

export function AsyncSection<T>({
  title,
  titleHidden,
  icon,
  action,
  before,
  fill,
  state,
  isEmpty,
  empty,
  emptyIllustration = "file",
  emptyLine,
  emptyAction,
  children,
}: {
  title: string;
  titleHidden?: boolean;
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
  emptyIllustration?: EmptyIllustration;
  emptyLine?: string;
  emptyAction?: React.ComponentProps<typeof PanelEmptyState>["action"];
  children: (data: T) => React.ReactNode;
}) {
  return (
    <PrefSection
      title={title}
      titleHidden={titleHidden}
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
          <Empty illustration={emptyIllustration} line={emptyLine} action={emptyAction}>
            {empty ?? `No ${title.toLowerCase()}`}
          </Empty>
        ) : (
          children(state.data)
        )
      ) : null}
    </PrefSection>
  );
}
