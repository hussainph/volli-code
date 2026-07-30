/**
 * The Instructions editor: a real textarea with a painted highlight layer
 * behind it, so skill references read as objects and stray `{{braces}}` read as
 * the mistake they now are.
 *
 * WHY THIS SHAPE. The first version of this form had a plain textarea plus a
 * separate "what gets sent" preview panel underneath. That panel was a
 * confession: it existed only because the editor could not show what the editor
 * was for. #82's claim is that chips are first-class things you move, demote and
 * remove deliberately — rendered as literal braces, they are a template
 * language, which is the thing the decision explicitly is not. So the preview is
 * gone and the editor does its own job.
 *
 * WHY NOT contenteditable OR Monaco. Both give truly atomic chips — one
 * backspace removes a whole chip — and both mean owning caret placement, paste,
 * undo, and IME composition. A textarea gets all of that for free from the
 * platform, and the only thing lost is atomic deletion. That trade is right for
 * a lab whose question is "does this read correctly", not "is this the final
 * editing model". (The shipped version inherits the composer's Monaco editor,
 * where a chip is a decoration and atomicity comes back.)
 *
 * `/` opens an inline skill menu at the caret — see {@link SlashMenu}. The
 * corner overflow that used to bury skills is gone.
 *
 * ── THE ONE RULE ──────────────────────────────────────────────────────────
 * The two layers must lay out IDENTICALLY, character for character. Any style
 * that changes metrics — padding, font-size, font-weight, letter-spacing,
 * border-width — must either be on BOTH layers or on NEITHER.
 *
 * That is why {@link LAYER_CLASS} exists and why the chip spans below carry
 * background and colour but no padding: a chip with real horizontal padding
 * reflows the highlight layer while the textarea underneath does not move, and
 * the caret drifts further from its glyph with every chip on the line. Visual
 * breathing room around a chip comes from `box-shadow` spread instead, which
 * paints outside the box without occupying any.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";

import { cn } from "@renderer/lib/utils";

import { tokenizeInstructions, type InstructionToken, type Skill } from "./model";
import { SlashMenu, slashQueryAt, type SlashQuery } from "./slash-menu";

/**
 * Every metric-affecting style, in one place, applied to both layers. Editing
 * this is safe; adding a metric-affecting class to only one layer is not.
 */
const LAYER_CLASS =
  "w-full px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words font-sans";

/** Painted outside the box, so a chip gets visual padding without taking layout space. */
function haloShadow(color: string): string {
  return `0 0 0 2px ${color}`;
}

function TokenSpan({ token }: { token: InstructionToken }) {
  if (token.kind === "text") return <span>{token.value}</span>;

  if (token.kind === "brace") {
    return (
      <span className="rounded bg-destructive/20 text-destructive">
        <span className="opacity-35">{"{{"}</span>
        {token.token}
        <span className="opacity-35">{"}}"}</span>
      </span>
    );
  }

  return token.known ? (
    <span
      className="rounded bg-accent text-foreground"
      style={{ boxShadow: haloShadow("var(--accent)") }}
    >
      {token.name}
    </span>
  ) : (
    <span className="text-muted-foreground underline decoration-dotted underline-offset-4">
      {token.name}
    </span>
  );
}

export interface ChipEditorHandle {
  /** Insert at the caret, keeping the caret after what was inserted. */
  insert: (snippet: string) => void;
  focus: () => void;
}

/**
 * Rough caret coordinates inside a textarea. Good enough to park a menu near
 * the slash — not a full caret-metrics library. Uses a mirror element so wrap
 * and padding match {@link LAYER_CLASS}.
 */
/** Viewport coordinates so the menu can `position: fixed` above overflow parents. */
function caretAnchor(
  field: HTMLTextAreaElement,
  caret: number,
): { top: number; left: number } {
  const mirror = document.createElement("div");
  const style = window.getComputedStyle(field);
  const props = [
    "boxSizing",
    "width",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "textTransform",
    "lineHeight",
    "whiteSpace",
    "wordWrap",
    "wordBreak",
  ] as const;
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.overflow = "auto";
  for (const prop of props) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.height = "auto";
  const text = field.value.slice(0, caret);
  mirror.textContent = text;
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const fieldRect = field.getBoundingClientRect();
  const top = fieldRect.top + marker.offsetTop - field.scrollTop + 22;
  const left = Math.min(
    fieldRect.left + marker.offsetLeft - field.scrollLeft,
    window.innerWidth - 300,
  );
  document.body.removeChild(mirror);
  return { top: Math.max(8, top), left: Math.max(8, left) };
}

export const ChipEditor = React.forwardRef<
  ChipEditorHandle,
  {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
  }
>(function ChipEditor({ value, onChange, placeholder, className }, ref) {
  const areaRef = React.useRef<HTMLTextAreaElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [slash, setSlash] = React.useState<{
    query: SlashQuery;
    anchor: { top: number; left: number };
  } | null>(null);
  const instantRef = React.useRef(false);

  const syncSlash = React.useCallback((field: HTMLTextAreaElement) => {
    const caret = field.selectionStart;
    const query = slashQueryAt(field.value, caret);
    if (query === null) {
      setSlash(null);
      return;
    }
    setSlash({ query, anchor: caretAnchor(field, query.from) });
  }, []);

  React.useImperativeHandle(ref, () => ({
    focus: () => areaRef.current?.focus(),
    insert: (snippet: string) => {
      const field = areaRef.current;
      if (field === null) {
        onChange(value + snippet);
        return;
      }
      const { selectionStart, selectionEnd } = field;
      onChange(value.slice(0, selectionStart) + snippet + value.slice(selectionEnd));
      requestAnimationFrame(() => {
        const at = selectionStart + snippet.length;
        field.focus();
        field.setSelectionRange(at, at);
      });
    },
  }));

  function commitSkill(skill: Skill) {
    const field = areaRef.current;
    if (field === null || slash === null) return;
    const { from, to } = slash.query;
    const next = `${value.slice(0, from)}${skill.name}${value.slice(to)}`;
    onChange(next);
    instantRef.current = true;
    setSlash(null);
    requestAnimationFrame(() => {
      const at = from + skill.name.length;
      field.focus();
      field.setSelectionRange(at, at);
    });
  }

  const tokens = tokenizeInstructions(value);

  React.useLayoutEffect(() => {
    const field = areaRef.current;
    if (field === null) return;

    function fit() {
      if (field === null) return;
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    }
    fit();

    const observer = new ResizeObserver(fit);
    observer.observe(field);
    return () => observer.disconnect();
  }, [value]);

  return (
    <div
      ref={wrapRef}
      className={cn(
        "relative overflow-auto rounded-lg border border-border bg-card",
        "focus-within:border-ring",
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(LAYER_CLASS, "pointer-events-none absolute inset-x-0 top-0 text-foreground")}
      >
        {tokens.map((token) => (
          <TokenSpan key={token.at} token={token} />
        ))}
        {value.endsWith("\n") ? <span>{"​"}</span> : null}
      </div>

      <textarea
        ref={areaRef}
        rows={1}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          requestAnimationFrame(() => {
            if (areaRef.current) syncSlash(areaRef.current);
          });
        }}
        onClick={(event) => syncSlash(event.currentTarget)}
        onKeyUp={(event) => {
          if (event.key === "Escape") return;
          syncSlash(event.currentTarget);
        }}
        onBlur={() => {
          // Let mousedown on a menu row commit before we tear the menu down.
          window.setTimeout(() => setSlash(null), 120);
        }}
        spellCheck={false}
        aria-label="Instructions"
        placeholder={placeholder}
        className={cn(
          LAYER_CLASS,
          "relative block resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none",
          "selection:bg-primary/30 selection:text-transparent",
          "placeholder:text-muted-foreground",
        )}
      />

      {slash === null ? null : (
        <SlashMenu
          query={slash.query}
          anchor={slash.anchor}
          instant={instantRef.current}
          onSelect={commitSkill}
          onDismiss={() => setSlash(null)}
        />
      )}
    </div>
  );
});
