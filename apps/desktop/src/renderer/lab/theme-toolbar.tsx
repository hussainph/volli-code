/**
 * Lab-only controls for auditing every scratch against the real Canvas +
 * Appearance pipeline.
 *
 * This is intentionally a controller over the production theme store, not a
 * second theme model. A canvas choice becomes a normal `Canvas` through
 * `withPrimaryHex`, then both it and the appearance travel through the store's
 * memory-only preview seam. Nothing is persisted and nothing under the shipped
 * renderer imports this file.
 */
import * as React from "react";
import { DEFAULT_CANVAS, withPrimaryHex, type Appearance, type Canvas } from "@volli/shared";

import { AppearanceModeChoice } from "@renderer/components/theme/canvas-editor";
import { CANVAS_SWATCH_PAGES } from "@renderer/components/theme/canvas-editor-model";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { cn } from "@renderer/lib/utils";
import { useThemeStore } from "@renderer/stores/theme";

const DEFAULT_CANVAS_HEX = DEFAULT_CANVAS.stops[DEFAULT_CANVAS.primaryIndex].hex;
const SYSTEM_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export interface LabThemeController {
  appearance: Appearance;
  canvasHex: string;
  setAppearance(appearance: Appearance): void;
  setCanvasHex(hex: string): void;
}

/**
 * Owns one audit choice for the lifetime of the Lab shell, so navigating to a
 * new scratch never silently resets the comparison. `scratchKey` is still a
 * dependency: an app-level scratch may reset singleton stores while seeding,
 * and the Lab choice must be re-applied immediately afterwards.
 */
export function useLabThemeController(scratchKey: string | null): LabThemeController {
  const [appearance, setAppearance] = React.useState<Appearance>("auto");
  const [canvasHex, setCanvasHex] = React.useState(DEFAULT_CANVAS_HEX);
  const canvas = React.useMemo<Canvas>(
    () => withPrimaryHex(DEFAULT_CANVAS, canvasHex),
    [canvasHex],
  );

  React.useLayoutEffect(() => {
    const store = useThemeStore.getState();
    // Electron asks nativeTheme for this. The browser-only Lab has no main
    // process, so its honest equivalent is the browser media query. Record the
    // answer before resolving `auto`; never read the generic fake bridge here,
    // whose unstubbed method result is an async failure object rather than a
    // boolean.
    store.startPreview(canvas);
    store.noteSystemAppearance(window.matchMedia(SYSTEM_SCHEME_QUERY).matches);
    store.startAppearancePreview(appearance);
  }, [appearance, canvas, scratchKey]);

  React.useEffect(() => {
    const query = window.matchMedia(SYSTEM_SCHEME_QUERY);
    const followSystem = (event: MediaQueryListEvent): void => {
      useThemeStore.getState().noteSystemAppearance(event.matches);
    };
    query.addEventListener("change", followSystem);
    return () => query.removeEventListener("change", followSystem);
  }, []);

  return { appearance, canvasHex, setAppearance, setCanvasHex };
}

function CanvasSwatch({ hex }: { hex: string }) {
  return (
    <span
      aria-hidden
      className="size-3.5 shrink-0 rounded-full border border-black/15 shadow-xs"
      style={{ background: hex }}
    />
  );
}

export function LabThemeToolbar({
  controller,
  floating = false,
}: {
  controller: LabThemeController;
  floating?: boolean;
}) {
  return (
    <div
      data-testid="lab-theme-toolbar"
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-end gap-2",
        floating &&
          "fixed top-px right-3 z-[10000] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-background/94 p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase text-muted-foreground">Canvas</span>
        <Select value={controller.canvasHex} onValueChange={controller.setCanvasHex}>
          <SelectTrigger
            size="sm"
            aria-label="Lab canvas"
            className="min-w-32 rounded-full bg-background/70 px-2.5 text-label"
          >
            <SelectValue>
              <CanvasSwatch hex={controller.canvasHex} />
              <span>{controller.canvasHex}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" align="end" className="z-[10001] max-h-80 min-w-44">
            {CANVAS_SWATCH_PAGES.map((page, pageIndex) => (
              <React.Fragment key={page.join(":")}>
                {pageIndex > 0 ? <SelectSeparator /> : null}
                <SelectGroup>
                  <SelectLabel>{pageIndex === 0 ? "Light seeds" : "Deep seeds"}</SelectLabel>
                  {page.map((hex) => (
                    <SelectItem key={hex} value={hex}>
                      <CanvasSwatch hex={hex} />
                      <span className="font-mono text-xs">{hex}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </React.Fragment>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase text-muted-foreground">Appearance</span>
        <AppearanceModeChoice
          value={controller.appearance}
          testId="lab-appearance-choice"
          onChange={controller.setAppearance}
        />
      </div>
    </div>
  );
}
