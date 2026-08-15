/**
 * The redesigned composer, at every stop count its effort control has to hold.
 *
 * Three things are being judged here and only one of them is a picture.
 *
 * **The collapsed height.** The composer is the most-looked-at surface in the
 * app and it was 45% chrome. The readout below the frame is the real measured
 * height of the `<form>` — not a claim, the number a `ResizeObserver` reports —
 * so the before/after is checkable rather than asserted.
 *
 * **The chrome at rest.** The footer sits at 70% until the box has focus. That
 * is the state the effort chip lives in most of the time, so judge it there
 * first, click into the box second.
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

export default function ComposerRedesignScratch() {
  const [value, setValue] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);
  const [selection, setSelection] = React.useState({
    providerId: "openai",
    modelId: "gpt-5.6-luna",
    reasoningLevel: "medium",
  });
  const composer = useMeasuredHeight<HTMLDivElement>();

  return (
    <div className="flex flex-col gap-6 pb-16">
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
