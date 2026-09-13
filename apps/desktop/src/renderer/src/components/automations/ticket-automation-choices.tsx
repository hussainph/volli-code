import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import type { Automation } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import type { AutomationGroup } from "./ticket-rail-automations-model";

/** Visible run choices: columns describe where work is usually offered, not
 * a prerequisite the person must discover by changing the ticket's status. */
export function TicketAutomationChoices({
  groups,
  onRun,
}: {
  groups: readonly AutomationGroup[];
  onRun(automation: Automation): void;
}) {
  if (groups.length === 0) return null;
  return (
    <div
      aria-label="Run on this ticket"
      className="flex max-h-64 flex-col gap-2 overflow-y-auto px-2"
    >
      {groups.map((group) => (
        <section key={group.status} className="flex flex-col gap-1">
          <h3 className="text-label text-muted-foreground">
            {group.label}
            {group.current ? " · current column" : ""}
          </h3>
          {group.automations.map((automation) => (
            <Button
              key={automation.id}
              variant="ghost"
              size="sm"
              aria-label={`Run ${automation.name} on this ticket`}
              onClick={() => onRun(automation)}
              className="w-full justify-between gap-2 text-left"
            >
              <span className="min-w-0 truncate">{automation.name}</span>
              <PlayIcon className="shrink-0" />
            </Button>
          ))}
        </section>
      ))}
    </div>
  );
}
