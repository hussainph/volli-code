import * as React from "react";
import type { TranscriptToolRefresh } from "@volli/session-presentation";

const triggerLabels: Record<string, string> = {
  "cold-turn": "Cold turn",
  "warm-turn": "Warm turn",
  compaction: "Compaction",
  "model-switch": "Model switch",
  "code-mode": "Code Mode",
};

/** A quiet durable fact; declarations stay on the host, names expand here. */
export const ToolRefreshNotice = React.memo(function ToolRefreshNotice({
  refresh,
}: {
  refresh: TranscriptToolRefresh;
}) {
  return (
    <details className="not-prose min-w-0 text-ui text-muted-foreground">
      <summary className="cursor-pointer">
        Tools updated:{" "}
        {refresh.added.length > 0
          ? `${refresh.added.length} added`
          : `${refresh.changed.length} updated`}
      </summary>
      <div className="mt-2 pl-4">
        <p>{triggerLabels[refresh.trigger] ?? refresh.trigger}</p>
        <ul>
          {refresh.added.map((name) => (
            <li key={name}>{name}</li>
          ))}
          {refresh.changed.map((name) => (
            <li key={`changed:${name}`}>{name} (updated)</li>
          ))}
        </ul>
      </div>
    </details>
  );
});
