/**
 * Harness chrome for the remote-host scratches: the variant picker (the
 * emil-prototype spec, verbatim — it must never read as part of the design)
 * and a small "lab bar" for the scripted conditions a real backend would
 * produce (an outcome, a speed). Neither is product UI.
 */
import * as React from "react";

import { cn } from "@renderer/lib/utils";

/* ── The picker ─────────────────────────────────────────────────────────── */

const PICKER_CSS = `
.proto-picker {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(10, 10, 10, 0.82);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  backdrop-filter: blur(12px) saturate(1.4);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08) inset,
    0 8px 24px rgba(0, 0, 0, 0.24),
    0 2px 6px rgba(0, 0, 0, 0.12);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
}
.proto-picker-highlight {
  position: absolute;
  top: 4px;
  left: 0;
  height: 28px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  will-change: transform;
}
.proto-picker[data-ready] .proto-picker-highlight {
  transition:
    transform 250ms cubic-bezier(0.23, 1, 0.32, 1),
    width 250ms cubic-bezier(0.23, 1, 0.32, 1);
}
@media (prefers-reduced-motion: reduce) {
  .proto-picker[data-ready] .proto-picker-highlight { transition: none; }
}
.proto-picker-item {
  position: relative;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  font: inherit;
  cursor: pointer;
  transition: color 150ms ease-out;
}
.proto-picker-item:hover { color: rgba(255, 255, 255, 0.85); }
.proto-picker-item:active { transform: scale(0.97); }
.proto-picker-item:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.4);
  outline-offset: 2px;
}
.proto-picker-item[data-active] { color: #fff; }
.proto-picker-divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: rgba(255, 255, 255, 0.12);
}
.proto-picker-replay { padding: 0 10px; font-size: 14px; }
.proto-picker[data-position="top"] { bottom: auto; top: 24px; }
`;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
}

/**
 * Variant state with the picker's contract: `?v=N` persistence, 1–N and ←/→
 * to switch, R to replay. `mountKey` changes on every switch and replay, so a
 * keyed variant re-runs its entrance.
 */
export function useVariants(count: number) {
  const [current, setCurrent] = React.useState(() => {
    const parsed = Number.parseInt(new URLSearchParams(window.location.search).get("v") ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= count ? parsed - 1 : 0;
  });
  const [replays, setReplays] = React.useState(0);

  const select = React.useCallback(
    (index: number) => {
      if (index < 0 || index >= count) return;
      setCurrent(index);
      const url = new URL(window.location.href);
      url.searchParams.set("v", String(index + 1));
      window.history.replaceState(null, "", url);
    },
    [count],
  );
  const replay = React.useCallback(() => setReplays((value) => value + 1), []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const number = Number.parseInt(event.key, 10);
      if (number >= 1 && number <= count) select(number - 1);
      else if (event.key === "ArrowRight") select((current + 1) % count);
      else if (event.key === "ArrowLeft") select((current - 1 + count) % count);
      else if (event.key === "r" || event.key === "R") replay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, current, replay, select]);

  return { current, select, replay, mountKey: `${current}:${replays}` };
}

export function ProtoPicker({
  names,
  current,
  onSelect,
  onReplay,
  position = "bottom",
}: {
  names: readonly string[];
  current: number;
  onSelect: (index: number) => void;
  onReplay?: () => void;
  position?: "bottom" | "top";
}) {
  const nav = React.useRef<HTMLElement>(null);
  const highlight = React.useRef<HTMLSpanElement>(null);
  const items = React.useRef<(HTMLButtonElement | null)[]>([]);
  const [ready, setReady] = React.useState(false);

  React.useLayoutEffect(() => {
    const move = () => {
      const element = items.current[current];
      if (!element || !highlight.current) return;
      highlight.current.style.width = `${element.offsetWidth}px`;
      highlight.current.style.transform = `translateX(${element.offsetLeft}px)`;
    };
    move();
    window.addEventListener("resize", move);
    return () => window.removeEventListener("resize", move);
  }, [current, names]);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <>
      <style>{PICKER_CSS}</style>
      <nav
        ref={nav}
        className="proto-picker"
        aria-label="Prototype variants"
        data-ready={ready ? "" : undefined}
        data-position={position === "top" ? "top" : undefined}
      >
        <span ref={highlight} className="proto-picker-highlight" aria-hidden="true" />
        {names.map((name, index) => (
          <button
            key={name}
            ref={(element) => {
              items.current[index] = element;
            }}
            type="button"
            className="proto-picker-item"
            data-active={index === current ? "" : undefined}
            aria-current={index === current ? "true" : undefined}
            onClick={() => onSelect(index)}
          >
            {name}
          </button>
        ))}
        {onReplay ? (
          <>
            <span className="proto-picker-divider" aria-hidden="true" />
            <button
              type="button"
              className="proto-picker-item proto-picker-replay"
              aria-label="Replay animation (R)"
              onClick={onReplay}
            >
              ↻
            </button>
          </>
        ) : null}
      </nav>
    </>
  );
}

/* ── The lab bar ────────────────────────────────────────────────────────── */

/**
 * The scripted conditions, parked top-centre. Deliberately lab-looking (mono
 * caps, the app-shell scratch's idiom) so no one mistakes it for a control
 * the product would ship.
 */
export function LabBar({
  children,
  className,
  fixed = true,
}: {
  children: React.ReactNode;
  className?: string;
  fixed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex max-w-[calc(100vw-24px)] flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-xl border border-border bg-background/94 p-1.5 shadow-overlay backdrop-blur-xl",
        fixed && "fixed top-3 left-1/2 z-[9998] -translate-x-1/2",
        className,
      )}
    >
      <span className="rounded-full bg-primary/15 px-2 py-1 font-mono text-[10px] uppercase text-primary-text">
        Lab
      </span>
      {children}
    </div>
  );
}

export function LabPills<Key extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Key;
  options: readonly { value: Key; label: string }[];
  onChange: (value: Key) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label={label}>
      <span className="mr-1 font-mono text-[10px] uppercase text-muted-foreground">{label}</span>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className="rounded-full px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:bg-foreground aria-pressed:text-background"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A long list of scripted conditions, folded into one native menu. */
export function LabSelect<Key extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Key;
  options: readonly { value: Key; label: string }[];
  onChange: (value: Key) => void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="mr-1 font-mono text-[10px] uppercase text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as Key)}
        className="h-6 rounded-full border border-border bg-background px-2 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export const SPEEDS = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "6", label: "6×" },
] as const;

export type Speed = (typeof SPEEDS)[number]["value"];
