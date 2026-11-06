/** Authored palette choices; Custom is a real SV pad, hue strip and hex field. */
import * as React from "react";
import {
  CANVAS_SWATCH_PAGES,
  normalizeStopHex,
} from "@renderer/components/theme/canvas-editor-model";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { PaletteIcon } from "@renderer/components/ui/icon";
import { toHsv, hsvHex } from "./colour-model";

const PRESETS = [
  ["Blue", CANVAS_SWATCH_PAGES[0][7]],
  ["Purple", CANVAS_SWATCH_PAGES[0][2]],
  ["Pink", CANVAS_SWATCH_PAGES[0][1]],
  ["Red", CANVAS_SWATCH_PAGES[0][3]],
  ["Orange", CANVAS_SWATCH_PAGES[0][4]],
  ["Yellow", CANVAS_SWATCH_PAGES[0][5]],
  ["Green", CANVAS_SWATCH_PAGES[0][6]],
] as const;

export function AccentChoice({
  value,
  canvasColour,
  onPick,
  onPreview,
  onCommit,
  onCancel,
  children,
}: {
  value: string;
  canvasColour: string;
  onPick(value: string): void;
  onPreview(value: string): void;
  onCommit(): void;
  onCancel(): void;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [hex, setHex] = React.useState(value);
  const [hue, saturation, brightness] = toHsv(value);
  // Grey/black retain the hue being edited instead of snapping it to zero.
  const [chosenHue, setChosenHue] = React.useState(hue);
  const editingHex = React.useRef(false);
  React.useEffect(() => {
    if (!editingHex.current) setHex(value);
    if (saturation > 0) setChosenHue(hue);
  }, [value, hue, saturation]);
  const dragging = React.useRef(false);
  const cancelled = React.useRef(false);
  const preview = (s: number, v: number, h = chosenHue) => onPreview(hsvHex(h, s, v));
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width && box.height)
      preview(
        Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)),
        Math.max(0, Math.min(100, 100 - ((event.clientY - box.top) / box.height) * 100)),
      );
  };
  const commitHex = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const parsed = normalizeStopHex(hex);
    if (parsed) {
      onPreview(parsed);
      onCommit();
      setHex(parsed);
    } else setHex(value);
  };
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Accent colour">
      <button
        type="button"
        className="accent-swatch accent-canvas"
        style={{ background: canvasColour }}
        aria-label="Canvas colour"
        aria-pressed={value === canvasColour}
        onClick={() => onPick(canvasColour)}
      >
        <PaletteIcon className="size-3.5" />
      </button>
      {PRESETS.map(([name, colour]) => (
        <button
          key={name}
          type="button"
          className="accent-swatch"
          style={{ background: colour }}
          aria-label={`${name} accent`}
          aria-pressed={value === colour}
          onClick={() => onPick(colour)}
        />
      ))}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onCancel();
        }}
      >
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="Custom accent colour">
            Custom
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="flex w-64 flex-col gap-3"
          onEscapeKeyDown={() => {
            // The field is about to unmount before blur can clear this flag.
            // Let the restored accepted value replace its abandoned draft.
            editingHex.current = false;
            cancelled.current = true;
            onCancel();
            setHex(value);
          }}
        >
          <div
            role="slider"
            tabIndex={0}
            aria-label="Saturation and brightness"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(saturation)}
            aria-valuetext={`${Math.round(saturation)}% saturation, ${Math.round(brightness)}% brightness`}
            className="relative h-36 w-full touch-none rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{
              background: `linear-gradient(to top, ${hsvHex(0, 0, 0)}, transparent), linear-gradient(to right, ${hsvHex(0, 0, 100)}, transparent), ${hsvHex(chosenHue, 100, 100)}`,
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragging.current = true;
              point(event);
            }}
            onPointerMove={(event) => {
              if (dragging.current) point(event);
            }}
            onPointerUp={() => {
              dragging.current = false;
              onCommit();
            }}
            onPointerCancel={() => {
              dragging.current = false;
              onCancel();
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 10 : 1;
              const delta: Record<string, readonly [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, step],
                ArrowDown: [0, -step],
              };
              const change = delta[event.key];
              if (!change) return;
              event.preventDefault();
              preview(
                Math.max(0, Math.min(100, saturation + change[0])),
                Math.max(0, Math.min(100, brightness + change[1])),
              );
            }}
            onKeyUp={onCommit}
            onBlur={onCommit}
          >
            <span
              aria-hidden
              className="absolute size-3 -translate-1/2 rounded-full border-2 shadow-glass-small outline-1"
              style={{
                left: `${saturation}%`,
                top: `${100 - brightness}%`,
                borderColor: hsvHex(0, 0, 100),
                outlineColor: hsvHex(0, 0, 0),
              }}
            />
          </div>
          <input
            type="range"
            aria-label="Hue"
            min={0}
            max={360}
            value={chosenHue}
            className="accent-hue w-full"
            style={{
              background: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((h) => hsvHex(h, 100, 100)).join(",")})`,
            }}
            onChange={(event) => {
              const h = Number(event.target.value);
              setChosenHue(h);
              preview(saturation, brightness, h);
            }}
            onPointerUp={onCommit}
            onKeyUp={onCommit}
            onBlur={onCommit}
          />
          <Input
            aria-label="Primary colour hex"
            value={hex}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => {
              setHex(event.target.value);
              const parsed = normalizeStopHex(event.target.value);
              if (parsed) onPreview(parsed);
            }}
            onFocus={() => {
              editingHex.current = true;
            }}
            onBlur={() => {
              editingHex.current = false;
              commitHex();
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                commitHex();
              }
            }}
          />
          {children}
        </PopoverContent>
      </Popover>
    </div>
  );
}
