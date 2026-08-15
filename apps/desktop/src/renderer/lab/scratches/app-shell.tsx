/**
 * The whole window: the app's real `AppShell`, seeded with the demo project.
 *
 * Chrome band, project rail, two-tier sidebar, Active Sessions, the framed
 * content card floating on the theme canvas, grain, and the board inside it —
 * all the actual components, laid out by the actual shell. It is the answer to
 * "what does this change do to the window", which a component scratch
 * structurally cannot show you: proportion between panes, how the card's margin
 * reads against the rail, whether the sidebar's tiers crowd the nav.
 *
 * Imported rather than recomposed. Standing the shell's layout up by hand here
 * would produce something that agrees with the app until the day it doesn't,
 * and a lab that quietly disagrees with the app is worse than no lab — so the
 * one thing this file must never do is describe a layout.
 *
 * The honest limit: `MainContent` always mounts `SessionsLayer`, which owns
 * every terminal. With no sessions seeded it mounts empty and boots no engine,
 * so the shell is real — but a terminal is the one surface in here that cannot
 * be. Judge chrome, layout, and navigation here; judge terminals in the app.
 */
import * as React from "react";

import { AppShell } from "@renderer/components/app-shell";

import { appApi, seedApp } from "../seed";

export const title = "App shell";
export const note = "Real shell with live control-density and chrome-geometry comparisons";
export const viewport = "window" as const;

export const seed = seedApp;
export const api = appApi;

type ControlContract = "current" | "roomy" | "compact-first";
type Density = "normal" | "compact";
type Geometry = "current" | "narrow";

const CONTRACTS = [
  { value: "current", label: "Current" },
  { value: "roomy", label: "36 / 28" },
  { value: "compact-first", label: "28 / 24" },
] as const satisfies readonly { value: ControlContract; label: string }[];

const DENSITIES = [
  { value: "normal", label: "Normal" },
  { value: "compact", label: "Compact" },
] as const satisfies readonly { value: Density; label: string }[];

const GEOMETRIES = [
  { value: "current", label: "Current chrome" },
  { value: "narrow", label: "Narrow chrome" },
] as const satisfies readonly { value: Geometry; label: string }[];

const comparisonCss = `
  [data-lab-control-contract="roomy"][data-lab-density="normal"] {
    --lab-control-height: 36px;
    --lab-control-font: 13px;
    --lab-control-icon: 16px;
    --lab-control-padding: 12px;
    --lab-control-gap: 8px;
  }

  [data-lab-control-contract="roomy"][data-lab-density="compact"] {
    --lab-control-height: 28px;
    --lab-control-font: 12px;
    --lab-control-icon: 14px;
    --lab-control-padding: 10px;
    --lab-control-gap: 4px;
  }

  [data-lab-control-contract="compact-first"][data-lab-density="normal"] {
    --lab-control-height: 28px;
    --lab-control-font: 13px;
    --lab-control-icon: 14px;
    --lab-control-padding: 10px;
    --lab-control-gap: 6px;
  }

  [data-lab-control-contract="compact-first"][data-lab-density="compact"] {
    --lab-control-height: 24px;
    --lab-control-font: 12px;
    --lab-control-icon: 12px;
    --lab-control-padding: 8px;
    --lab-control-gap: 4px;
  }

  [data-lab-control-contract]:not([data-lab-control-contract="current"]) :is(
    [data-slot="input"],
    [data-slot="select-trigger"][data-size="default"],
    [data-slot="button"][data-size="default"],
    [data-slot="button"][data-size="icon"]
  ) {
    height: var(--lab-control-height) !important;
    min-height: var(--lab-control-height) !important;
    font-size: var(--lab-control-font) !important;
    gap: var(--lab-control-gap) !important;
  }

  [data-lab-control-contract]:not([data-lab-control-contract="current"]) :is(
    [data-slot="input"],
    [data-slot="select-trigger"][data-size="default"],
    [data-slot="button"][data-size="default"]
  ) {
    padding-inline: var(--lab-control-padding) !important;
  }

  [data-lab-control-contract]:not([data-lab-control-contract="current"]) :is(
    [data-slot="button"][data-size="default"],
    [data-slot="button"][data-size="icon"],
    [data-slot="select-trigger"]
  ) svg {
    width: var(--lab-control-icon) !important;
    height: var(--lab-control-icon) !important;
  }

  [data-lab-geometry="narrow"] [data-volli-shell="framed"] {
    --sidebar-width: 280px !important;
    --sidebar-width-icon: 101px !important;
    --rail-width: 52px !important;
  }

  [data-lab-geometry="narrow"] aside:has([data-testid="ticket-rail"]) {
    width: 240px !important;
  }
`;

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <span className="mr-1 font-mono text-[10px] uppercase text-muted-foreground">{label}</span>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="rounded-full px-2.5 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40 aria-pressed:bg-foreground aria-pressed:text-background"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function AppShellDensityScratch() {
  const [contract, setContract] = React.useState<ControlContract>("current");
  const [density, setDensity] = React.useState<Density>("compact");
  const [geometry, setGeometry] = React.useState<Geometry>("current");

  // The proposed production seam lives on html so portalled controls inherit
  // the same variables as their triggers. Mirror the scratch state there and
  // clean it up on exit so the next Lab page never inherits this experiment.
  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.labControlContract = contract;
    root.dataset.labDensity = density;
    return () => {
      delete root.dataset.labControlContract;
      delete root.dataset.labDensity;
    };
  }, [contract, density]);

  return (
    <div
      className="h-svh w-full"
      data-lab-control-contract={contract}
      data-lab-density={density}
      data-lab-geometry={geometry}
    >
      <style>{comparisonCss}</style>
      <AppShell />
      <div className="fixed top-12 left-1/2 z-[9999] flex max-w-[calc(100vw-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-xl border border-border bg-background/94 p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl">
        <span className="rounded-full bg-primary/15 px-2 py-1 font-mono text-[10px] uppercase text-primary-text">
          Lab · size decision
        </span>
        <ChoiceGroup<ControlContract>
          label="Controls"
          value={contract}
          options={CONTRACTS}
          onChange={setContract}
        />
        <ChoiceGroup<Density>
          label="Density"
          value={density}
          options={DENSITIES}
          onChange={setDensity}
          disabled={contract === "current"}
        />
        <ChoiceGroup<Geometry>
          label="Geometry"
          value={geometry}
          options={GEOMETRIES}
          onChange={setGeometry}
        />
      </div>
    </div>
  );
}

export default AppShellDensityScratch;
