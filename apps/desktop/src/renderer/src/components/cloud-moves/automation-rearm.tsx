import {
  TICKET_STATUS_LABELS,
  type CloudMoveRearmTarget,
  type CloudMoveStatus,
} from "@volli/shared";
import { Button } from "@renderer/components/ui/button";

/** Only project records are actionable; personal definitions are displayed once by the result. */
export function MoveAutomationRearm({
  move,
  busy,
  onRearm,
  onRefresh,
}: {
  move: CloudMoveStatus;
  busy: boolean;
  onRearm(target: CloudMoveRearmTarget): void;
  onRefresh(): void;
}) {
  const rearm = move.automationRearm;
  if (rearm === undefined) return null;
  const items = [
    ...rearm.columns.map((item) => ({
      key: `column:${item.status}:${item.automationId}`,
      label: `${item.name} · ${TICKET_STATUS_LABELS[item.status]}`,
      accessibleName: `Re-arm ${item.name} on this Mac (${TICKET_STATUS_LABELS[item.status]})`,
      target: { kind: "column" as const, automationId: item.automationId, status: item.status },
    })),
    ...rearm.schedules.map((item) => ({
      key: `schedule:${item.automationId}`,
      label: `${item.name} · Schedule`,
      accessibleName: `Re-arm ${item.name} schedule on this Mac`,
      target: { kind: "schedule" as const, automationId: item.automationId },
    })),
  ];
  if (items.length === 0 && rearm.unavailable === null) return null;
  return (
    <details>
      <summary>Paused Automations{rearm.retryable ? "" : ` (${items.length})`}</summary>
      {rearm.unavailable !== null ? <p role="status">{rearm.unavailable}</p> : null}
      {rearm.retryable ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRefresh}>
          Try again
        </Button>
      ) : null}
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center justify-between gap-2">
            <span>{item.label}</span>
            <Button
              size="sm"
              variant="outline"
              aria-label={item.accessibleName}
              disabled={busy || !rearm.canRearmOnThisMac || !move.actions.includes("re-arm")}
              onClick={() => onRearm(item.target)}
            >
              Re-arm on this Mac
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
