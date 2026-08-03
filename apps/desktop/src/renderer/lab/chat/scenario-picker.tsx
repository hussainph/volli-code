/**
 * The dev control that puts a scripted Session state on screen.
 *
 * Lab chrome, not product chrome: it is plainly not part of the app, and it
 * sits above the shell's own Lab link in the corner the app leaves empty. The
 * app's bottom-left is the sidebar's pinned Settings row, and a lab control on
 * top of a real affordance is one you will eventually mistake for one.
 *
 * A select rather than a row of pills because there are a dozen states and a
 * pill rail that wide would be a second navigation bar competing with the
 * surface it exists to show.
 */
import * as React from "react";

import { LAB_SCENARIOS } from "../../../lab-scenarios";

export interface LabScenarioPickerProps {
  /** Null is the live harness. */
  value: string | null;
  onChange(next: string | null): void;
}

export function LabScenarioPicker({ value, onChange }: LabScenarioPickerProps) {
  const id = React.useId();
  return (
    <div className="fixed right-3 bottom-12 z-50 flex items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-label text-muted-foreground shadow-[var(--shadow-raised)] backdrop-blur">
      <label htmlFor={id}>Scenario</label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange(event.currentTarget.value || null)}
        className="bg-transparent text-foreground outline-none"
      >
        <option value="">Live OpenCode</option>
        {LAB_SCENARIOS.map((scenario) => (
          <option key={scenario.id} value={scenario.id}>
            {scenario.label}
          </option>
        ))}
      </select>
    </div>
  );
}
