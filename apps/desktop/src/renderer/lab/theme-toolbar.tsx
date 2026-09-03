/**
 * Lab-only controls for auditing every scratch against the real Canvas +
 * Appearance pipeline.
 *
 * This is intentionally a controller over the production theme store, not a
 * second theme model. It owns the authored `Canvas` + `Appearance` for the Lab
 * shell's lifetime and sends both through the store's memory-only preview seam.
 * Nothing is persisted and nothing under the shipped renderer imports this file.
 */
import * as React from "react";
import { DEFAULT_CANVAS, resolveAppearance, type Appearance, type Canvas } from "@volli/shared";

import { AppearanceModeChoice, CanvasEditor } from "@renderer/components/theme/canvas-editor";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";
import { useThemeStore, type ThemeScope } from "@renderer/stores/theme";

const LAB_SCOPE: ThemeScope = { kind: "global" };
const SYSTEM_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export interface LabThemeController {
  appearance: Appearance;
  canvas: Canvas;
  setAppearance(appearance: Appearance): void;
  setCanvas(canvas: Canvas): void;
  reapply(): void;
}

/**
 * Owns one audit choice for the lifetime of the Lab shell, so navigating to a
 * new scratch never silently resets the comparison. The shell calls `reapply`
 * after scratch setup because an app-level scratch may reset singleton stores
 * while seeding.
 */
export function useLabThemeController(): LabThemeController {
  const [appearance, setAppearance] = React.useState<Appearance>("auto");
  const [canvas, setCanvas] = React.useState<Canvas>(DEFAULT_CANVAS);

  const reapply = React.useCallback(() => {
    const store = useThemeStore.getState();
    // Electron asks nativeTheme for this. The browser-only Lab has no main
    // process, so its honest equivalent is the browser media query. Record the
    // answer before resolving `auto`; never read the generic fake bridge here,
    // whose unstubbed method result is an async failure object rather than a
    // boolean.
    store.startPreview(canvas);
    store.noteSystemAppearance(window.matchMedia(SYSTEM_SCHEME_QUERY).matches);
    store.startAppearancePreview(appearance);
  }, [appearance, canvas]);

  React.useLayoutEffect(reapply, [reapply]);

  React.useEffect(() => {
    const query = window.matchMedia(SYSTEM_SCHEME_QUERY);
    const followSystem = (event: MediaQueryListEvent): void => {
      useThemeStore.getState().noteSystemAppearance(event.matches);
    };
    query.addEventListener("change", followSystem);
    return () => query.removeEventListener("change", followSystem);
  }, []);

  return { appearance, canvas, setAppearance, setCanvas, reapply };
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
  const systemPrefersDark = useThemeStore((state) => state.systemPrefersDark);
  const resolved = resolveAppearance(controller.appearance, systemPrefersDark);
  const primaryHex = controller.canvas.stops[controller.canvas.primaryIndex].hex;

  return (
    <div
      data-testid="lab-theme-toolbar"
      className={cn(
        "flex shrink-0 items-center justify-end",
        floating &&
          "fixed top-px right-3 z-[10000] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-background/94 p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl",
      )}
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label="Lab theme"
            className="rounded-full bg-background/70 px-2.5 text-label"
          >
            <CanvasSwatch hex={primaryHex} />
            <span>Lab theme</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {controller.canvas.stops.length}{" "}
              {controller.canvas.stops.length === 1 ? "colour" : "colours"} ·{" "}
              {controller.appearance}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Lab theme editor"
          align="end"
          className="z-[10001] w-[44rem] max-w-[calc(100vw-24px)] p-3"
        >
          <CanvasEditor
            scope={LAB_SCOPE}
            canvas={controller.canvas}
            resolved={resolved}
            onCanvasChange={controller.setCanvas}
            mode={
              <AppearanceModeChoice
                iconOnly
                value={controller.appearance}
                testId="lab-appearance-choice"
                onChange={controller.setAppearance}
              />
            }
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
