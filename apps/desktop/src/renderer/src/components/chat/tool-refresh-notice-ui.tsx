import * as React from "react";
import { ChevronRightIcon } from "@renderer/components/ui/icon";

import type { TranscriptToolRefresh } from "@volli/session-presentation";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";

const triggerLabels: Record<string, string> = {
  "cold-turn": "Cold turn",
  "warm-turn": "Warm turn",
  compaction: "Compaction",
  "model-switch": "Model switch",
  "code-mode": "Code Mode",
};

/**
 * A quiet durable fact; declarations stay on the host, names expand here.
 *
 * The shared Collapsible owns the disclosure, so the row behaves like every
 * other transcript row: the arrow cursor and no selection on the trigger, a
 * visible keyboard ring, and a caret that turns in place. The caret's 12px and
 * its gap are the body's indent, so the names start under the label. Tool names
 * are machine values that can run long without a break; they wrap anywhere
 * rather than widen the transcript.
 */
export const ToolRefreshNotice = React.memo(function ToolRefreshNotice({
  refresh,
  defaultOpen = false,
}: {
  refresh: TranscriptToolRefresh;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="not-prose min-w-0 text-ui text-muted-foreground"
    >
      <CollapsibleTrigger className="group/refresh flex w-full min-w-0 cursor-default items-center gap-1 rounded-row py-1 text-left font-medium outline-none select-none transition-colors duration-(--duration-menu-in) ease-swift hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none">
        <ChevronRightIcon
          aria-hidden
          className="size-3 shrink-0 transition-transform duration-(--duration-menu-in) ease-swift group-data-[state=open]/refresh:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 wrap-anywhere">
          Tools updated:{" "}
          {refresh.added.length > 0
            ? `${refresh.added.length} added`
            : `${refresh.changed.length} updated`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1 pb-1 pl-4">
          <p>{triggerLabels[refresh.trigger] ?? refresh.trigger}</p>
          <ul className="space-y-0.5">
            {refresh.added.map((name) => (
              <li key={name} className="min-w-0 wrap-anywhere">
                <span className="font-mono">{name}</span>
              </li>
            ))}
            {refresh.changed.map((name) => (
              <li key={`changed:${name}`} className="min-w-0 wrap-anywhere">
                <span className="font-mono">{name}</span> (updated)
              </li>
            ))}
          </ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
