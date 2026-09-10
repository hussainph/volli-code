/**
 * A headline, the faults actually present, and the detail behind a disclosure.
 *
 * The shape About wants. The pane it replaces listed every check it ran, pass
 * and fail alike, at equal weight — so "everything is fine" and "two things
 * are broken" were the same wall of rows, and a reader had to audit it to
 * learn which. Here the healthy case is one line, and anything wrong is a
 * fault with a remedy next to it.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";

import { Button } from "@renderer/components/ui/button";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

/** One thing that is wrong, and — where there is one — the button that fixes it. */
export interface Fault {
  id: string;
  headline: string;
  detail: string;
  remedy?: { label: string; onAct: () => void };
}

/**
 * How much the panel actually knows, in ascending order of confidence.
 *
 * A boolean was the bug (VC-293): `healthy` had to be either true or false
 * while the reads behind it were still in flight or had failed, and "not yet"
 * has no honest side of that line to fall on. Four states means the panel can
 * only claim health when something established it.
 */
export type HealthPanelState = "checking" | "unavailable" | "attention" | "healthy";

/**
 * The dot, decided here rather than at each call site.
 *
 * `checking` is neutral — the same grey `starting` gives a Session that is
 * connecting: nothing is wrong and nothing is known. `unavailable` shares the
 * attention tone with `attention` because both want the same thing from the
 * person reading them, and only the headline can say whether the install is
 * faulty or the check simply never finished. Green is reachable from one state
 * alone.
 */
const HEALTH_DOT: Record<HealthPanelState, StatusDotState> = {
  checking: "starting",
  unavailable: "waiting",
  attention: "waiting",
  healthy: "ready",
};

export function HealthPanel({
  state,
  headline,
  faults,
  actions,
  children,
}: {
  state: HealthPanelState;
  headline: string;
  faults: readonly Fault[];
  actions?: React.ReactNode;
  /** The facts behind the headline. Collapsed — a reader asks for these. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const detailsId = React.useId();

  return (
    <section className="rounded-lg bg-card px-4 py-4" data-health-state={state}>
      <header className="flex items-center gap-2 py-1">
        <StatusDot state={HEALTH_DOT[state]} size="md" />
        <h2 className="min-w-0 flex-1 text-ui font-medium">{headline}</h2>
        {actions}
      </header>

      {faults.length > 0 ? (
        <div className="mt-2 flex flex-col">
          {faults.map((fault) => (
            <div key={fault.id} className="flex items-start gap-4 border-t border-border/50 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-ui">{fault.headline}</p>
                <p className="text-ui text-muted-foreground">{fault.detail}</p>
              </div>
              {fault.remedy ? (
                <Button size="xs" variant="outline" onClick={fault.remedy.onAct}>
                  {fault.remedy.label}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {children ? (
        <div className="mt-2 border-t border-border/50">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((current) => !current)}
            className="flex w-full items-center gap-1 py-2 text-ui text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none"
          >
            <CaretDownIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", open && "rotate-180")}
            />
            {open ? "Hide details" : "Details"}
          </button>
          <div id={detailsId} hidden={!open} className="pb-2">
            {children}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** One fact inside {@link HealthPanel}'s disclosure. */
export function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border/50 py-2 first:border-t-0">
      <span className="text-ui text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-ui" title={value}>
        {value}
      </span>
    </div>
  );
}
