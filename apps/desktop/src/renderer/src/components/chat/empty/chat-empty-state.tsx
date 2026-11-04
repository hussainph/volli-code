/** Empty chat context, with alternate readings one disclosure away. */
import * as React from "react";

import {
  EMPTY_VISUAL_LABELS,
  resolveEmptyVisual,
  visualsForScope,
  type ChatScope,
} from "@renderer/components/chat/empty-visual";
import { BoardVisual } from "@renderer/components/chat/empty/board-visual";
import { StreakVisual } from "@renderer/components/chat/empty/streak-visual";
import { WorkingCopyChips } from "@renderer/components/chat/empty/working-copy-chips";
import { WorkingCopyVisual } from "@renderer/components/chat/empty/working-copy-visual";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { useUiStore } from "@renderer/stores/ui";
import {
  useWorkingCopyStore,
  workingCopyKey,
  type WorkingCopyEntry,
} from "@renderer/stores/working-copy";

/**
 * Memoised because of where it sits: an empty chat is a Draft being typed
 * into, and its plane re-renders for reasons that are not this drawing's
 * (VC-1079). Its props are two ids, so the memo is exact.
 */
export const ChatEmptyState = React.memo(function ChatEmptyState({
  projectId,
  ticketId,
}: {
  projectId: string;
  /** `null` for a Board Session — the scope, not a missing value. */
  ticketId: string | null;
}) {
  const scope: ChatScope = ticketId === null ? "project" : "ticket";
  const chosen = useUiStore((state) => state.homeEmptyVisual);
  const setVisual = useUiStore((state) => state.setHomeEmptyVisual);
  const visual = resolveEmptyVisual(scope, chosen);
  const offered = visualsForScope(scope);

  const workingCopy = useWorkingCopyStore(
    (state) => state.byScope[workingCopyKey(projectId, ticketId)],
  );
  const refreshWorkingCopy = useWorkingCopyStore((state) => state.refresh);
  // Re-read on every open rather than once per app run: an empty chat is what
  // you see right after starting a Session, and the tree it is standing in has
  // been moving while nobody was asking. Whatever was last read stays on screen
  // until this answers.
  //
  // Nothing more is subscribed to here (VC-286). A ticket that GAINS a worktree
  // while this chat is open is not this surface's event to notice: the store is
  // told at the one boundary every ticket working copy reader shares (`lib/boot.ts`,
  // on a `worktree` data-changed), and this redraws because it reads the store.
  React.useEffect(() => {
    void refreshWorkingCopy(projectId, ticketId);
  }, [projectId, ticketId, refreshWorkingCopy]);

  return (
    <div className="flex flex-col items-center gap-6">
      {visual === "streak" ? <StreakVisual /> : null}
      {visual === "board" ? <BoardVisual projectId={projectId} /> : null}
      {visual === "venue" ? <WorkingCopyDrawing workingCopy={workingCopy} /> : null}
      <WorkingCopyCaption workingCopy={workingCopy} />
      {offered.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Empty chat visual"
              data-testid="empty-visual-picker"
              className="text-muted-foreground"
            >
              {EMPTY_VISUAL_LABELS[visual]}
              <CaretDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuRadioGroup
              value={visual}
              onValueChange={(value) => {
                const next = offered.find((key) => key === value);
                if (next) setVisual(next);
              }}
            >
              {offered.map((key) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {EMPTY_VISUAL_LABELS[key]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
});

/**
 * The working copy drawing, or the space it will take.
 *
 * A working copy that cannot be read draws NOTHING — not an error, not a zeroed bar.
 * The error is a git message about a directory, and this surface is a chat
 * somebody is about to type into; the rail is where a failure has room to be
 * named. A zeroed bar would be worse than either: it is a measurement, and it
 * would be a false one.
 *
 * A ticket still RESOLVING its checkout draws the same waiting shape, and that
 * is the whole of VC-286's fix on this surface: the alternative it replaces was
 * a complete, believable drawing of the main checkout — branch, path and change
 * count — for a Session that will never run there. `data-working-copy-state` puts the
 * state on the element so the wait is legible while it lasts.
 */
function WorkingCopyDrawing({ workingCopy }: { workingCopy: WorkingCopyEntry | undefined }) {
  if (workingCopy?.status === "ready")
    return <WorkingCopyVisual workingCopy={workingCopy.workingCopy} />;
  // The waiting shape is the real one with nothing in it, rather than a height
  // somebody measured once: an empty track and an invisible caption reserve
  // exactly what the drawing will take, and stay right when it changes.
  return (
    <div
      className="flex w-80 flex-col gap-3"
      aria-hidden
      data-working-copy-state={workingCopy?.status ?? "loading"}
    >
      <div className="h-8 rounded-control bg-muted" />
      <div className="invisible flex items-baseline justify-center gap-3">
        <span className="text-title">0</span>
        <span className="text-ui">files changed</span>
      </div>
    </div>
  );
}

/** The chips, once there is a working copy to name. */
function WorkingCopyCaption({ workingCopy }: { workingCopy: WorkingCopyEntry | undefined }) {
  if (workingCopy?.status !== "ready") return null;
  return <WorkingCopyChips workingCopy={workingCopy.workingCopy} />;
}
