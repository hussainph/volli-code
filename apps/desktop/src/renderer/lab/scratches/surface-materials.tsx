/** VC-617: material authoring only. No production imports point back at this scratch. */
import * as React from "react";
import { DialRoot, useDialKitController } from "dialkit";
import dialStyles from "dialkit/styles.css?inline";
import { resolveAppearance, type Appearance } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Segmented } from "@renderer/components/ui/segmented";
import { studyColourHex } from "../surface/colour";
import {
  SURFACE_CONFIG,
  SURFACE_PRESETS,
  INSPECTOR_PRESETS,
  WORK_PANE_PRESETS,
  studyCanvas,
  surfaceStyle,
  type SurfacePreset,
} from "../surface/model";
import { SurfacePreview } from "../surface/preview";
import { MACOS27_STOPS, resolveStudyValues } from "../surface/macos27";
import "../surface/surface.css";

export const title = "Surface · material tuning (DialKit)";
export const note =
  "Matte / satin / lens — live theme-derived materials, not a shipped design decision";
export const viewport = "window";

// The package requests Google Fonts. The lab already has licensed local fonts;
// mount its prefixed CSS only while active, with that remote request removed.
const LOCAL_DIAL_STYLES = dialStyles.replace(/@import[^;]*;/g, "");
const PRESETS = [
  { key: "flat", label: "Flat" },
  { key: "borrowed", label: "Borrowed light" },
  { key: "aqua", label: "Modern Aqua" },
  { key: "glass", label: "All glass" },
  { key: "sculpted", label: "Sculpted Aqua" },
] as const;
const APPEARANCES = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "auto", label: "System" },
] as const;

// Browser-only lab convention: matchMedia, not the desktop's main-process OS
// appearance feed. The lab shell/root colour-scheme can constrain this query.
function useSystemDark(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
}

export default function SurfaceMaterialsScratch() {
  // Browser-local versions are useful while crafting; no app setting is written.
  const dial = useDialKitController("Surface", SURFACE_CONFIG, {
    id: "volli-lab-surface-v1",
    persist: true,
  });
  const values = dial.values;
  const systemDark = useSystemDark();
  const appearance: Appearance =
    values.canvas.appearance === "system"
      ? "auto"
      : values.canvas.appearance === "dark"
        ? "dark"
        : "light";
  const resolved = resolveAppearance(appearance, systemDark);
  const filterId = `surface-refraction-${React.useId().replaceAll(":", "")}`;
  const colourResult = React.useMemo(() => {
    try {
      return {
        colours: [
          studyColourHex(values.canvas.keyColour),
          studyColourHex(values.canvas.returnColour),
        ] as const,
        error: null,
      };
    } catch (error) {
      return {
        colours: ["#808080", "#808080"] as const,
        error: error instanceof Error ? error.message : "Colour conversion failed.",
      };
    }
  }, [values.canvas.keyColour, values.canvas.returnColour]);
  const canvas = studyCanvas(values, colourResult.colours);
  const reference = values.reference.treatment === "macos27";
  const renderedValues = resolveStudyValues(values);
  const style = surfaceStyle(renderedValues, canvas, resolved, filterId);
  const [selectedPreset, setSelectedPreset] = React.useState<SurfacePreset>("aqua");
  const [copyStatus, setCopyStatus] = React.useState("");
  const presetMatches = Object.entries(SURFACE_PRESETS[selectedPreset]).every(([group, fields]) =>
    Object.entries(fields).every(
      ([key, value]) =>
        (values[group as keyof typeof values] as Record<string, unknown>)[key] === value,
    ),
  );

  return (
    <div
      className={`surface-study h-svh overflow-hidden${reference ? " surface-reference" : ""}`}
      style={style}
      data-testid="surface-study"
      data-appearance={resolved}
      data-treatment={values.reference.treatment}
      data-reference-active={values.reference.active}
    >
      <style>{LOCAL_DIAL_STYLES}</style>
      <header
        data-surface-controls
        className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-4"
      >
        <div>
          <h1 className="text-heading font-medium">Surface</h1>
          <p className="text-ui text-muted-foreground">Materials lab · fixture interactions only</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Material study"
            value={values.reference.treatment}
            options={[
              { key: "surface", label: "Surface" },
              { key: "macos27", label: "macOS 27" },
            ]}
            onChange={(key) => dial.setValue("reference.treatment", key)}
          />
          {!reference && (
            <Segmented
              ariaLabel="Material starting point"
              value={presetMatches ? selectedPreset : "custom"}
              options={PRESETS}
              onChange={(key) => {
                if (key === "custom") return;
                setSelectedPreset(key);
                dial.setValues(SURFACE_PRESETS[key]);
              }}
            />
          )}
          <Segmented
            ariaLabel="Study appearance"
            value={appearance}
            options={APPEARANCES}
            onChange={(key) => dial.setValue("canvas.appearance", key === "auto" ? "system" : key)}
          />
        </div>
      </header>
      <main className="surface-study-layout">
        <div
          className="surface-preview-scroll flex min-w-0 flex-col gap-4"
          role="region"
          aria-label="Component preview"
          tabIndex={0}
        >
          <SurfacePreview
            style={style}
            values={renderedValues}
            onLightPlacement={(placement) => dial.setValues({ placement })}
          />
          <p className="text-ui text-muted-foreground">
            <span id="surface-light-help">
              Move K / R lights by dragging or arrow keys (Shift: finer). Move the rail to test
              placement.{" "}
              {reference
                ? "Placement dials retain the light arrangement."
                : "Angle resets the light arrangement."}
            </span>{" "}
            {reference
              ? "macOS 27 reference study: Balance couples transmission, diffusion and tint; authored Surface recipes are preserved. CSS approximation, not native glass or pixel-calibrated optics. "
              : "Lens tunes the inspector; Work Pane tunes the reading surface. "}
            Face opacity never fades text. Canvas → Backdrop Detail reveals transmission; large-pane
            blur costs more than a rim or shadow. Measured bounds + elevation drive the shared
            lighting. Backdrop displacement is experimental, not physical refraction.
          </p>
          {colourResult.error ? (
            <p role="alert" className="text-ui text-destructive">
              {colourResult.error}
            </p>
          ) : null}
        </div>
        <aside
          className="surface-dials flex flex-col gap-4"
          data-surface-controls
          aria-label="Material tuning controls"
          tabIndex={0}
          data-testid="surface-dial-scroll"
        >
          {reference && (
            <div className="flex flex-col gap-2" data-testid="macos27-controls">
              <span className="text-label text-muted-foreground">macOS 27 · appearance</span>
              <Segmented
                ariaLabel="macOS 27 appearance stops"
                value={
                  MACOS27_STOPS.find(
                    (stop) => Math.abs(stop.balance - values.reference.balance) < 0.001,
                  )?.key ?? "custom"
                }
                options={MACOS27_STOPS}
                onChange={(key) => {
                  const stop = MACOS27_STOPS.find((entry) => entry.key === key);
                  if (stop) dial.setValue("reference.balance", stop.balance);
                }}
              />
              <Segmented
                ariaLabel="Reference window activity"
                value={values.reference.active ? "active" : "inactive"}
                options={[
                  { key: "active", label: "Active" },
                  { key: "inactive", label: "Inactive" },
                ]}
                onChange={(key) => dial.setValue("reference.active", key === "active")}
              />
              <p className="text-ui text-muted-foreground">
                Balance couples transmission, diffusion and tint. Surface-only dials are hidden.
              </p>
            </div>
          )}
          {!reference && (
            <>
              <div role="group" aria-label="Inspector finish" className="flex flex-col gap-2">
                <span className="text-label text-muted-foreground">Inspector finish</span>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(INSPECTOR_PRESETS).map(([name, recipe]) => (
                    <Button
                      key={name}
                      variant="outline"
                      size="sm"
                      onClick={() => dial.setValues({ lens: recipe })}
                    >
                      {name.charAt(0).toUpperCase() + name.slice(1)}
                    </Button>
                  ))}
                </div>
              </div>
              <div
                role="group"
                aria-label="Work pane starting point"
                className="flex flex-col gap-2"
              >
                <span className="text-label text-muted-foreground">Work pane</span>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(WORK_PANE_PRESETS).map(([name, recipe]) => (
                    <Button
                      key={name}
                      variant="outline"
                      size="sm"
                      onClick={() => dial.setValues({ workPane: recipe })}
                    >
                      {name.charAt(0).toUpperCase() + name.slice(1)}
                    </Button>
                  ))}
                </div>
              </div>
            </>
          )}
          <DialRoot mode="inline" theme={resolved} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                dial.resetValues();
                setSelectedPreset("aqua");
              }}
            >
              Reset study
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    JSON.stringify(
                      {
                        canvas,
                        appearance: values.canvas.appearance,
                        materials: values,
                        renderedMaterials: renderedValues,
                      },
                      null,
                      2,
                    ),
                  );
                  setCopyStatus("Study copied");
                } catch {
                  setCopyStatus("Copy failed. Use DialKit’s version menu to copy the controls.");
                }
              }}
            >
              Copy study
            </Button>
          </div>
          <p role="status" className="text-ui text-muted-foreground">
            {copyStatus ||
              "Versions stay in this browser only. Colour-picker alpha is flattened over neutral; the theme engine receives sRGB stops."}
          </p>
        </aside>
      </main>
      <svg width="0" height="0" aria-hidden className="absolute pointer-events-none">
        <defs>
          <filter
            id={filterId}
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.012 0.016"
              numOctaves="2"
              seed="3"
              result="noise"
            />
            <feGaussianBlur in="noise" stdDeviation="2" result="smoothNoise" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="smoothNoise"
              scale={values.opticalExperiment.displacement}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>
    </div>
  );
}
