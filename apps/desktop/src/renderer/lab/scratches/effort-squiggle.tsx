/**
 * The effort slider's SQUIGGLE — the Arc-lineage wave the vibrancy pass
 * (VC-26) was always headed for, landed by VC-57.
 *
 * This scratch is deliberately thin: it mounts the REAL shipped control
 * (`composer-effort-ui.tsx`'s `EffortPill`), because the squiggle is not a
 * variant being judged against siblings — it is one addition to a control
 * whose every other decision (the ramp, the halo, the comb, the elastic ends)
 * has already been measured and shipped. What the rig exists to check is the
 * addition against the real neighbours it has to live with, at every stop
 * count the app actually serves.
 *
 * THE DESIGN, in one paragraph so the feel-check knows what it is checking: a
 * hairline wave rides the pill's free bottom band, clipped at the same seam as
 * the wash, and its AMPLITUDE is the value — absent at the lowest stop (the
 * empty share clips it away), standing taller stop by stop to full wave at
 * `max`. It is a redundant channel on purpose (the seam and the
 * grip already carry the value), so it is quieter than the comb (`/40` against
 * `/50`) and it does not drift: the only motion is the amplitude changing, and
 * only because the value changed. Ignite's rejection is the precedent — a
 * control must report the gesture, not decorate it.
 *
 * WHAT TO WATCH
 *
 *  1. **Drag from `off`/`minimal` to `max` slowly.** The wave should stand up
 *     under the seam as it sweeps — one substance getting agitated, never a
 *     second object arriving. The second stop is the real floor of the ramp
 *     (index 0 is clipped away with its empty share) — judge whether it
 *     separates from the third.
 *  2. **Descenders.** The wave's peaks reach ~3px into the tail of the
 *     labels' line box — descender space. Watch the `g` in `High` and
 *     `Extra high` at the stops where the seam has crossed them.
 *  3. **Seven stops** (`opus-4.6`): adjacent stops should still differ — the
 *     amplitude ramp is linear for the same reason the mix's is.
 *  4. **Reduced motion**: the wave still STANDS (it is state, not motion); only
 *     its transitions go instant.
 */
import * as React from "react";

import { REASONING_LEVELS, type ReasoningLevel } from "@volli/shared";

import { EffortPill } from "@renderer/components/chat/composer-effort-ui";

export const title = "Effort squiggle · amplitude as magnitude";
export const note =
  "The shipped effort slider wearing the VC-57 squiggle: wave height is the value";
export const viewport = "stage" as const;

interface FixtureModel {
  id: string;
  label: string;
  levels: readonly ReasoningLevel[];
  seed: ReasoningLevel;
}

/** The same four stop-set shapes the original effort rig stressed. */
const MODELS: readonly FixtureModel[] = [
  {
    id: "sonnet-4.5",
    label: "sonnet-4.5 · 3 stops",
    levels: ["low", "medium", "high"],
    seed: "medium",
  },
  {
    id: "haiku-4.5",
    label: "haiku-4.5 · 4 stops with Off",
    levels: ["off", "low", "medium", "high"],
    seed: "low",
  },
  {
    id: "gpt-5.6-luna",
    label: "gpt-5.6-luna · 5 stops",
    levels: ["minimal", "low", "medium", "high", "xhigh"],
    seed: "medium",
  },
  { id: "opus-4.6", label: "opus-4.6 · all 7", levels: REASONING_LEVELS, seed: "high" },
];

function FixtureRow({ model }: { model: FixtureModel }) {
  const [level, setLevel] = React.useState<string>(model.seed);
  return (
    <section className="flex items-center gap-4">
      <span className="w-56 shrink-0 text-ui text-muted-foreground">{model.label}</span>
      <EffortPill levels={model.levels} value={level} onChange={setLevel} />
    </section>
  );
}

export default function EffortSquiggleScratch() {
  return (
    <div className="flex flex-col gap-6 pb-16">
      <p className="text-ui text-muted-foreground">
        Open each pill and drag: the wave under the labels stands with the value — flat at the
        bottom of the range, full at <span className="text-foreground">Max</span> — and is clipped
        at the same seam as the wash.
      </p>
      {MODELS.map((model) => (
        <FixtureRow key={model.id} model={model} />
      ))}
    </div>
  );
}
