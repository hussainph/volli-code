/** Membership, column arming and machine permission are independent commands. */
import * as React from "react";
import { toast } from "sonner";
import {
  armedAutomationFor,
  automationTriggerColumns,
  TICKET_STATUS_LABELS,
  type Automation,
  type TicketStatus,
} from "@volli/shared";
import { PrefRow } from "@renderer/components/settings/kit/pref-row";
import { Switch } from "@renderer/components/ui/switch";
import {
  useAutomationsStore,
  selectArmings,
  selectAutomations,
} from "@renderer/stores/automations";
import { automationSourceIsCloud } from "@renderer/stores/automation-source";
import { guardWrite } from "@renderer/components/hosts/use-hosts";
import { toastError } from "@renderer/lib/toast";
import { CloudAutomationControls } from "./cloud-automation-controls";

export function AutomationTriggerState({
  projectId,
  automation,
  disabled,
}: {
  projectId: string;
  automation: Automation;
  disabled: boolean;
}) {
  const enabled = useAutomationsStore((s) => s.enabledIds.includes(automation.id));
  const [pending, setPending] = React.useState(false);
  const lock = React.useRef(false);
  if (automationSourceIsCloud())
    return (
      <div>
        <CloudAutomationControls projectId={projectId} automation={automation} />
      </div>
    );
  if (automation.trigger.kind === "none") return null;
  return (
    <>
      {automationTriggerColumns(automation.trigger).map((status) => (
        <ArrivalRow
          key={status}
          projectId={projectId}
          automation={automation}
          status={status}
          disabled={disabled}
        />
      ))}
      <PrefRow label="Automatic triggers">
        <span className="text-ui text-muted-foreground">This Mac</span>
        <Switch
          checked={enabled}
          disabled={disabled || pending}
          aria-label={`Automatic triggers on this Mac: ${automation.name}`}
          onCheckedChange={(value) => {
            if (lock.current || disabled || !guardWrite(projectId)) return;
            lock.current = true;
            setPending(true);
            void useAutomationsStore
              .getState()
              .setEnabled(automation.id, value)
              .finally(() => {
                lock.current = false;
                setPending(false);
              });
          }}
        />
      </PrefRow>
    </>
  );
}
function ArrivalRow({
  projectId,
  automation,
  status,
  disabled,
}: {
  projectId: string;
  automation: Automation;
  status: TicketStatus;
  disabled: boolean;
}) {
  const rows = useAutomationsStore((s) => selectAutomations(s, projectId));
  const armings = useAutomationsStore((s) => selectArmings(s, projectId));
  const holder = armedAutomationFor(rows, armings, status);
  const armed = holder?.id === automation.id;
  const [pending, setPending] = React.useState(false);
  const lock = React.useRef(false);
  const column = TICKET_STATUS_LABELS[status];
  return (
    <PrefRow label={column}>
      {!armed && holder ? (
        <span className="text-ui wrap-anywhere text-muted-foreground">Armed · {holder.name}</span>
      ) : null}
      <span className="text-ui text-muted-foreground">Arrival</span>
      <Switch
        checked={armed}
        disabled={disabled || pending}
        aria-label={`Run ${automation.name} on arrival in ${column}`}
        onCheckedChange={(value) => {
          if (lock.current || disabled || !guardWrite(projectId)) return;
          lock.current = true;
          setPending(true);
          void useAutomationsStore
            .getState()
            .arm({ projectId, status, automationId: value ? automation.id : null })
            .then((refusal) => {
              if (refusal !== null) toastError(`Couldn’t arm ${column}: ${refusal}`);
              else
                toast(
                  value
                    ? `${column} armed with ${automation.name}${holder && !armed ? `; replaced ${holder.name}` : ""}`
                    : `${column} disarmed`,
                );
            })
            .finally(() => {
              lock.current = false;
              setPending(false);
            });
        }}
      />
    </PrefRow>
  );
}
