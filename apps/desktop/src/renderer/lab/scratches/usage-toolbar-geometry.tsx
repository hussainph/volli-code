/** Simulated wiring: fixed quota readings, real shipped glyph/control and toolbar
 * CSS. No provider, account or credential is contacted. This probes layout,
 * not quota retrieval, native traffic lights or Electron font rasterisation. */
import * as React from "react";
import { Button } from "@renderer/components/ui/button";
import { ControlShapeProvider } from "@renderer/components/ui/control-shape";
import {
  UsageLimitsIcon,
  USAGE_ICON_BUTTON_PX,
} from "@renderer/components/usage-limits/usage-limits-icon";
import type {
  UsageIconReading,
  UsageWindowReading,
} from "@renderer/components/usage-limits/icon-reading";

export const title = "Usage numbers at toolbar scale";
export const note = "Simulated readings · production 20px glyph, 28px control and 46px title bar";

function reading(count: number, remaining: number): UsageIconReading {
  const windows: UsageWindowReading[] = Array.from({ length: count }, (_, index) => ({
    id: `window-${index}`,
    kind: index === 0 ? "session" : "weekly",
    label: index === 0 ? "Session" : "Weekly",
    remaining,
    tone: "normal",
    pace: null,
  }));
  return {
    kind: "read",
    lead: { providerId: "anthropic", label: "Anthropic", windows, binding: windows[0]! },
    reported: windows[0]!,
    pinned: [],
    others: [],
  };
}

export default function UsageToolbarGeometry() {
  const root = React.useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = React.useState<string>("");
  const [summary, setSummary] = React.useState<string[]>([]);
  const measure = React.useCallback(() => {
    const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-usage-case]") ?? [])].map(
      (band) => {
        const button = band.querySelector("button")!;
        const svg = button.querySelector("svg")!;
        const control = button.getBoundingClientRect();
        const frame = band.getBoundingClientRect();
        const glyph = svg.getBoundingClientRect();
        const figures = [...svg.querySelectorAll("text")].map((text) => {
          const box = text.getBoundingClientRect();
          return {
            value: text.textContent,
            controlClearance: [
              box.left - control.left,
              box.top - control.top,
              control.right - box.right,
              control.bottom - box.bottom,
            ].map((n) => +n.toFixed(2)),
            glyphClearance: [
              box.left - glyph.left,
              box.top - glyph.top,
              glyph.right - box.right,
              glyph.bottom - box.bottom,
            ].map((n) => +n.toFixed(2)),
          };
        });
        return {
          case: band.dataset.usageCase,
          bandHeight: frame.height,
          controlSize: [control.width, control.height],
          glyphSize: [glyph.width, glyph.height],
          glyphOverflow: getComputedStyle(svg).overflow,
          figures,
        };
      },
    );
    setMeasurements(JSON.stringify(rows, null, 2));
    setSummary(
      rows.map((row) => {
        const clearance = Math.min(...row.figures.flatMap((figure) => figure.controlClearance));
        return `${row.case}: ${row.bandHeight}px band, ${row.controlSize.join("×")}px control, ${row.glyphSize.join("×")}px glyph; minimum numeral clearance ${clearance}px; SVG overflow ${row.glyphOverflow}.`;
      }),
    );
  }, []);
  React.useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
    };
  }, [measure]);
  return (
    <div ref={root} className="flex flex-col gap-4 p-6">
      <p className="text-ui text-muted-foreground">
        Simulated wiring — real glyph and title-bar geometry. Clearance order: left, top, right,
        bottom (CSS px).
      </p>
      <ControlShapeProvider context="toolbar">
        {[
          [1, 22],
          [2, 22],
          [2, 99],
        ].map(([count, remaining]) => (
          <section key={`${count}-${remaining}`} className="flex flex-col gap-2">
            <h2 className="text-ui">
              {count} window(s), {remaining}% remaining
            </h2>
            <div
              data-slot="chrome-bar"
              data-usage-case={`${count}-${remaining}`}
              className="flex h-(--spacing-titlebar) items-center gap-2 border-y border-border px-4"
            >
              <Button
                variant="toolbar"
                size="icon-sm"
                className="app-region-no-drag shrink-0"
                aria-label={`${count} window(s), ${remaining}% remaining`}
                style={{ width: USAGE_ICON_BUTTON_PX, height: USAGE_ICON_BUTTON_PX }}
              >
                <UsageLimitsIcon reading={reading(count!, remaining!)} />
              </Button>
            </div>
          </section>
        ))}
      </ControlShapeProvider>
      <Button onClick={measure}>Measure glyphs</Button>
      {summary.map((line) => (
        <p key={line} className="text-ui">
          {line}
        </p>
      ))}
      <pre className="overflow-auto text-ui" aria-label="Glyph bounds">
        {measurements}
      </pre>
    </div>
  );
}
