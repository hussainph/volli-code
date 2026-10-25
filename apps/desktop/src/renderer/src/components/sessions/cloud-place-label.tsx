/**
 * Where a cloud Session runs, drawn (VC-895): the header pill ("Running on
 * hp-mac", "Waiting for hp-mac — asleep since 14:02"), and the line above
 * the composer in a cloud launch. The words are
 * `sessionPlaceState` in `@volli/shared/cloud`; the facts are
 * `lib/cloud-places.ts`'s. Nothing here draws in a local launch: the store
 * is empty there, and nothing is watched.
 */
import * as React from "react";

import { StatusDot } from "@renderer/components/ui/status-dot";
import {
  availabilityDotState,
  useOpenSessionPlace,
  useSessionPendingLine,
  type FailedCommand,
} from "@renderer/lib/cloud-places";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/** The Session header's corner: nothing for a Session running on this Mac. */
export function CloudPlaceLabel({
  sessionId,
  turnActive,
  className,
}: {
  sessionId: string | null;
  turnActive: boolean | undefined;
  className?: string;
}) {
  const place = useOpenSessionPlace(sessionId, turnActive);
  if (place === null || place.kind === "here") return null;
  return (
    <span
      data-slot="cloud-place"
      data-place={place.kind}
      title={place.label}
      className={cn(
        "flex w-fit max-w-[60%] shrink-0 items-center gap-1 rounded-full border border-border px-2 text-ui leading-5 text-muted-foreground",
        className,
      )}
    >
      {/* The runner's state, not the Session's. */}
      <StatusDot state={availabilityDotState(place)} />
      <span className="truncate">{place.label}</span>
    </span>
  );
}

/**
 * The line above a cloud Session's composer: commands queued for a runner
 * that is not running the Session ("Sent — waiting for hp-mac", with the
 * messages among them, from the backend's own list so a reload keeps them),
 * else the Place when it is not running it ("Paused — hp-mac is asleep"),
 * else nothing. The composer below stays, so a message can be queued for a
 * runner that is away.
 */
export function CloudComposerStatus({
  sessionId,
  turnActive,
}: {
  sessionId: string | null;
  turnActive: boolean | undefined;
}) {
  const place = useOpenSessionPlace(sessionId, turnActive);
  const pending = useSessionPendingLine(sessionId);
  const away = place !== null && (place.kind === "waiting" || place.kind === "removed");
  const line = pending.label ?? (away ? place.label : null);
  useToastFailures(sessionId, pending.answered, pending.failures);
  if (line === null && pending.failures.length === 0) return null;
  return (
    <div data-slot="cloud-composer-status" className="flex flex-col items-end gap-1 px-4 pb-2">
      {pending.failures.map((failure) => (
        <p
          key={failure.commandId}
          role="alert"
          data-slot="cloud-failed-command"
          className="max-w-[80%] truncate text-ui text-destructive"
        >
          {failure.text === null
            ? `Not carried out: ${failure.reason}`
            : `Not delivered: “${failure.text}” — ${failure.reason}`}
        </p>
      ))}
      {pending.messages.map((message) => (
        <p
          key={message.commandId}
          data-slot="cloud-pending-message"
          className="max-w-[80%] truncate rounded-lg bg-muted px-3 py-1 text-ui text-muted-foreground"
        >
          {message.text}
        </p>
      ))}
      {line === null ? null : (
        <p role="status" className="self-start text-ui text-muted-foreground">
          {line}
        </p>
      )}
    </div>
  );
}

/**
 * Each command that ended undone is said once, as it is first seen: a
 * Session's first answer (a reload, or another Session drawn here) is
 * history, shown in the line and not announced again.
 */
function useToastFailures(
  sessionId: string | null,
  answered: boolean,
  failures: readonly FailedCommand[],
): void {
  const seen = React.useRef<{ sessionId: string | null; ids: Set<string> } | null>(null);
  React.useEffect(() => {
    if (!answered) return;
    if (seen.current === null || seen.current.sessionId !== sessionId) {
      seen.current = { sessionId, ids: new Set(failures.map((failure) => failure.commandId)) };
      return;
    }
    for (const failure of failures) {
      if (seen.current.ids.has(failure.commandId)) continue;
      seen.current.ids.add(failure.commandId);
      toastError(
        failure.text === null
          ? `Command not carried out: ${failure.reason}`
          : `Message not delivered: ${failure.reason}`,
      );
    }
  }, [answered, failures, sessionId]);
}
