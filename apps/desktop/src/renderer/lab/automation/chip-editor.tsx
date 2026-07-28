/**
 * The Instructions editor: a real textarea with a painted highlight layer
 * behind it, so Context chips and harness commands read as objects instead of
 * as `{{double_brace}}` ASCII.
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
 *
 * The same rule is why a chip renders its own source text (`brief`) rather than
 * its label ("Runtime Brief") — a substitution of a different length would
 * desynchronise the layers on that line. The braces are dimmed rather than
 * hidden, which gets most of the way to a label while staying honest about what
 * is really in the field.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import type { HarnessId } from "@volli/shared";

import { cn } from "@renderer/lib/utils";

import { chipFor, tokenizeInstructions, type InstructionToken } from "./model";

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

  if (token.kind === "chip") {
    const known = chipFor(token.token) !== undefined;
    // The braces stay — they are in the textarea — but drop to a third of the
    // opacity so the eye reads the token name and treats the syntax as framing.
    return (
      <span
        className={cn(
          "rounded",
          known ? "bg-primary/20 text-primary-text" : "bg-destructive/20 text-destructive",
        )}
        style={{
          boxShadow: haloShadow(
            known ? "color-mix(in oklab, var(--primary) 20%, transparent)" : "transparent",
          ),
        }}
      >
        <span className="opacity-35">{"{{"}</span>
        {token.token}
        <span className="opacity-35">{"}}"}</span>
      </span>
    );
  }

  // A command this harness knows reads as a solid object; one it does not is
  // never blocked, only marked — a dotted underline, which #82 calls a "quiet
  // unverified affordance" and which costs no metrics.
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

export const ChipEditor = React.forwardRef<
  ChipEditorHandle,
  {
    value: string;
    onChange: (value: string) => void;
    harnessId: HarnessId;
    placeholder?: string;
    className?: string;
  }
>(function ChipEditor({ value, onChange, harnessId, placeholder, className }, ref) {
  const areaRef = React.useRef<HTMLTextAreaElement>(null);
  const paintRef = React.useRef<HTMLDivElement>(null);

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
      // Next frame: the value prop has not landed yet, and setting the range
      // against the stale text would put the caret in the wrong place.
      requestAnimationFrame(() => {
        const at = selectionStart + snippet.length;
        field.focus();
        field.setSelectionRange(at, at);
      });
    },
  }));

  const tokens = tokenizeInstructions(value, harnessId);

  /**
   * Grow the textarea to fit its own content, every time the content changes.
   *
   * This is not a nicety — it is what keeps the two layers in sync, and it
   * replaces an earlier version that let the textarea scroll internally. That
   * version had two bugs, both measured:
   *
   *  • A scrolling textarea reserves a scrollbar gutter, so its content box was
   *    10px narrower than the paint layer's. Same text, two different wrap
   *    widths — every line after the first overflow wrapped in a different place
   *    in each layer, and the highlight slid off the words underneath it.
   *  • `h-full` on the textarea resolved against an auto-height parent, so the
   *    real control was 66px tall inside a 318px box. Four fifths of the editor
   *    looked editable and was not clickable.
   *
   * With the textarea always exactly as tall as its content and never scrolling,
   * neither can happen: one width, one height, and the WRAPPER does the
   * scrolling for both. The paint layer is absolutely positioned inside that
   * wrapper, so it scrolls with the content for free — which is also why there
   * is no scroll-sync handler here any more.
   */
  React.useLayoutEffect(() => {
    const field = areaRef.current;
    if (field === null) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [value]);

  return (
    <div
      className={cn(
        "relative overflow-auto rounded-lg border border-border bg-card",
        // The focus ring lives on the wrapper, not the textarea: the textarea is
        // transparent and sits above the paint layer, so its own ring would draw
        // over the highlighted text.
        "focus-within:border-ring",
        className,
      )}
    >
      {/* The paint layer. aria-hidden and inert — the textarea above is the real
          control and the only thing assistive tech or a pointer should reach.
          `inset-x-0 top-0` rather than `inset-0`: it must take its HEIGHT from
          its own content so it can outgrow the wrapper and scroll with it. */}
      <div
        ref={paintRef}
        aria-hidden
        className={cn(LAYER_CLASS, "pointer-events-none absolute inset-x-0 top-0 text-foreground")}
      >
        {tokens.map((token) => (
          <TokenSpan key={token.at} token={token} />
        ))}
        {/* A trailing newline collapses in a <div> but not in a textarea, so the
            paint layer would come up one line short while typing at the end. */}
        {value.endsWith("\n") ? <span>{"​"}</span> : null}
      </div>

      <textarea
        ref={areaRef}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label="Instructions"
        placeholder={placeholder}
        className={cn(
          LAYER_CLASS,
          // `block` so no inline baseline gap creeps in under it, and
          // `overflow-hidden` so it can never reserve a scrollbar gutter and
          // reintroduce the width mismatch described above.
          "relative block resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none",
          // Selection must stay visible even though the glyphs are transparent —
          // without this, selecting text looks like selecting nothing.
          "selection:bg-primary/30 selection:text-transparent",
          "placeholder:text-muted-foreground",
        )}
      />
    </div>
  );
});
