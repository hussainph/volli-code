/**
 * The redesigned composer, at every stop count its effort control has to hold.
 *
 * Three things are being judged here and only one of them is a picture.
 *
 * **The proportions.** The composer is the most-looked-at surface in the app
 * and it was 45% chrome; then it was 52% chrome — a 40.54px control band under
 * a 36px message line, split by a hairline sitting at 47.1% of the shell, which
 * is a rule announcing two co-equal halves over a box that has a primary and a
 * secondary. The line is gone and the controls stepped to the ladder's 20px
 * rung, so the band is 32px under a 36px line and the message is the taller
 * object. The readout below the frame is the real measured height of the
 * `<form>` — not a claim, the number a `ResizeObserver` reports — so 77.65 → 69
 * is checkable rather than asserted.
 *
 * **The chrome at rest.** The footer sits at 70% until the box has focus. That
 * is the state the effort chip lives in most of the time, so judge it there
 * first, click into the box second. It is also what replaced the separator: two
 * bands at different ink strengths are already told apart, and 12px of air
 * between them against 8px at the card's edges is what makes the grouping read
 * without a line drawn across it.
 *
 * **The elastic ends.** Open the effort chip and drag the pill *past* either
 * end. There is a dead zone first — a band where overshooting costs nothing and
 * the value simply stays put — and then the pill itself starts to give, less
 * the harder it is pulled, and springs back when released. Nothing about the
 * value changes out there; the point is that the end of the range is something
 * the hand finds before the eye checks.
 *
 * Switch models to change the stop set. That is the same event that re-clamps
 * effort in the app (a model that cannot run the current level rewrites it), so
 * the rig has no separate "level count" control — you change models, and the
 * chip re-clamps the way it would in production.
 */
import * as React from "react";

import { SessionComposer, type ComposerModel } from "@renderer/components/chat/composer-ui";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";
import { useMeasuredHeight } from "@renderer/hooks/use-measured-height";
import { cn } from "@renderer/lib/utils";

export const title = "Composer · effort, height, resting chrome";
export const note = "The redesigned footer: elastic notched effort, 70% at rest, one control band";
export const viewport = "stage" as const;

/**
 * Four real stop-set shapes, because the control has to survive all of them.
 * `off` is in one of them on purpose: an empty pill at the left end is coherent
 * for a track in a way it never was for a row of words.
 */
const MODELS: readonly ComposerModel[] = [
  {
    id: "anthropic/sonnet-4.5",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "sonnet-4.5",
    label: "sonnet-4.5",
    reasoningLevels: ["low", "medium", "high"],
  },
  {
    id: "anthropic/haiku-4.5",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "haiku-4.5",
    label: "haiku-4.5",
    reasoningLevels: ["off", "low", "medium", "high"],
  },
  {
    id: "openai/gpt-5.6-luna",
    providerId: "openai",
    providerLabel: "OpenAI",
    modelId: "gpt-5.6-luna",
    label: "gpt-5.6-luna",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
  },
  {
    id: "anthropic/opus-4.6",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "opus-4.6",
    label: "opus-4.6",
    reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    // The one that pins its own effort: the chip must not render at all, rather
    // than render disabled or render one option.
    id: "openai/o5-mini",
    providerId: "openai",
    providerLabel: "OpenAI",
    modelId: "o5-mini",
    label: "o5-mini",
    reasoningLevels: ["medium"],
  },
];

/* -------------------------------------------------------------------- play */

/**
 * What is left of the play rack after the review.
 *
 * It held three variants and two of them graduated. **Grip** (the handle
 * swelling and taking a halo while held) and **Cascade** (the notches dealt in
 * left to right on open) are shipped behavior in
 * `components/chat/composer-effort-ui.tsx` now, so they are no longer toggles —
 * you cannot turn them off here because you cannot turn them off in the app.
 * **Ignite** stayed, and stayed a toggle: it fires on a *sweep*, so dragging
 * through five stops sets off five flares in a row, and a control that sparkles
 * while you use it is decorating the gesture rather than reporting it. It is
 * kept switchable rather than deleted because that verdict is a judgement about
 * a feel, and a feel is cheaper to re-check than to re-describe.
 *
 * The rack's rule survives the graduation: variants are CSS ONLY, hanging off
 * attributes the shipping control already publishes for its own reasons —
 * `data-dragging` on the rail, `data-passed` on a tick, the `data-slot` names.
 * Nothing here has ever needed a prop, a flag or a branch in the component,
 * which is what let two of them port as a class on the element they already
 * targeted. House rules apply to a variant too: `--ease-out`,
 * `transform`/`opacity` only, nothing that moves layout, and a reduced-motion
 * block that switches the idea off rather than shortening it.
 *
 * NOTE WHAT IGNITE NOW COLLIDES WITH. It drives a tick's `animation`, which is
 * the channel Cascade ships on — so switching Ignite on replaces the entrance
 * for as long as it is on. That is the honest cost of keeping it around, and it
 * is also the clearest evidence for why only one of the two could ever ship.
 */
type PlayId = "ignite";

interface PlayVariant {
  id: PlayId;
  name: string;
  claim: string;
  css: string;
}

const PLAY: readonly PlayVariant[] = [
  {
    id: "ignite",
    name: "Ignite",
    claim: "Each notch flares as the wash crosses it — the sweep leaves a wake.",
    // Fires on the ATTRIBUTE, not on a timer: `data-passed` arrives the moment
    // the wash reaches that stop, and a CSS animation restarts every time the
    // attribute comes back — so sweeping down and up again re-lights them in
    // order, for free.
    css: `
@keyframes effort-ignite {
  0%   { scale: 1 1; }
  30%  { scale: 1 3.5; }
  100% { scale: 1 1; }
}
[data-slot="effort-tick"][data-passed] {
  transform-origin: top center;
  animation: effort-ignite 220ms var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  [data-slot="effort-tick"][data-passed] { animation: none !important; }
}`,
  },
];

export default function ComposerRedesignScratch() {
  const [value, setValue] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);
  const [play, setPlay] = React.useState<ReadonlySet<PlayId>>(() => new Set());
  const [selection, setSelection] = React.useState({
    providerId: "openai",
    modelId: "gpt-5.6-luna",
    reasoningLevel: "medium",
  });
  const composer = useMeasuredHeight<HTMLDivElement>();

  const toggle = (id: PlayId): void =>
    setPlay((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-6 pb-16">
      {/* Each toggle mounts ONE stylesheet, and nothing else changes. The
          composer below is the shipping component either way — every variant
          here is CSS hanging off attributes the real control already publishes
          (`data-dragging`, `data-passed`, its `data-slot` names), so nothing
          lab-only reaches production and turning them all off leaves exactly
          what the PR ships. Two of the three variants ARE the PR now; what is
          left is the one that lost. */}
      {PLAY.filter((variant) => play.has(variant.id)).map((variant) => (
        <style key={variant.id}>{variant.css}</style>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={working ? "default" : "outline"}
          onClick={() => setWorking((live) => !live)}
        >
          {working ? "Turn is live" : "Idle"}
        </Button>
        <span className="text-ui text-muted-foreground">
          Collapsed height{" "}
          <span data-composer-height className="text-foreground tabular-nums">
            {composer.height}
          </span>
          px
        </span>
      </div>

      {/* Off by default, on purpose: the question is whether each one earns its
          place against the control as it stands, and a variant you have to turn
          OFF to compare is a variant that has already won the argument. */}
      <div className="flex flex-col gap-2">
        <div className="text-label text-muted-foreground uppercase">
          Play · Grip and Cascade shipped · what is left lost
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {PLAY.map((variant) => (
            <button
              key={variant.id}
              type="button"
              aria-pressed={play.has(variant.id)}
              onClick={() => toggle(variant.id)}
              className={cn(
                "flex max-w-64 flex-col gap-0.5 rounded-row border px-3 py-2 text-left",
                "transition-colors duration-150 ease-out outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring/45",
                play.has(variant.id)
                  ? "border-border-strong bg-accent text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="text-ui font-medium">{variant.name}</span>
              <span className="text-label text-muted-foreground normal-case">{variant.claim}</span>
            </button>
          ))}
        </div>
      </div>

      <ContentColumn>
        <div ref={composer.ref}>
          <SessionComposer
            value={value}
            onValueChange={setValue}
            models={MODELS}
            selection={selection}
            onSelectionChange={setSelection}
            modelChoiceDisabled={working}
            working={working}
            ready
            queued={[]}
            onQueuedChange={() => undefined}
            onSteerQueued={() => undefined}
            onSubmit={(text) => {
              setSent(text);
              setValue("");
            }}
            onStop={() => setWorking(false)}
          />
        </div>
      </ContentColumn>

      {sent === null ? null : (
        <ContentColumn>
          <pre className="rounded-row border border-border bg-muted/40 p-3 text-ui whitespace-pre-wrap text-muted-foreground">
            {sent}
          </pre>
        </ContentColumn>
      )}
    </div>
  );
}
