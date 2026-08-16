/**
 * The context meter, at every state its tone ladder has to hold.
 *
 * Three questions this scratch answers:
 *
 * **The pill at rest.** It lives in the composer footer beside stop/submit, so
 * it is judged at the footer's own 70% resting ink first — a quiet fact, not a
 * gauge demanding attention. The full composer at the bottom is the real
 * placement; the bare pills above it are the ladder in isolation.
 *
 * **The tone escalation.** Muted through most of a Session, attention at 80%,
 * destructive at 95%. The boundary cases (79/80, 94/95) sit side by side so a
 * change to the thresholds is visible as a change here.
 *
 * **The grid.** Open any popover. One cell per percent of the window, colored
 * by bucket, hover names the bucket and its (estimated) tokens. The windowless
 * pill is the degenerate case: no fraction, no free cells — the grid is the
 * spend alone, and the pill shows a count where the others show a share.
 */
import * as React from "react";

import type { SessionContextUsage } from "@renderer/chat/context-usage";
import { ContextUsagePill } from "@renderer/components/chat/context-usage-ui";
import { SessionComposer, type ComposerModel } from "@renderer/components/chat/composer-ui";

export const title = "Context usage · pill, tones, grid";
export const note = "The session context meter at every fraction its tone ladder distinguishes";
export const viewport = "stage" as const;

const MODELS: readonly ComposerModel[] = [
  {
    id: "anthropic/sonnet-4.5",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "sonnet-4.5",
    label: "sonnet-4.5",
    reasoningLevels: ["low", "medium", "high"],
  },
];

/** A usage whose split keeps the measured proportions of a real mid-session. */
function usageAt(fraction: number, window: number | null = 200_000): SessionContextUsage {
  const used = window === null ? 41_200 : Math.round(window * fraction);
  const system = Math.round(used * 0.28);
  const user = Math.round(used * 0.09);
  const reasoning = Math.round(used * 0.07);
  const tools = Math.round(used * 0.38);
  const assistant = used - system - user - reasoning - tools;
  return {
    usedTokens: used,
    contextWindow: window,
    fraction: window === null ? null : Math.min(1, fraction),
    segments: [
      { id: "system", label: "System prompt & overhead", tokens: system },
      { id: "user", label: "Your messages", tokens: user },
      { id: "assistant", label: "Assistant replies", tokens: assistant },
      { id: "reasoning", label: "Reasoning", tokens: reasoning },
      { id: "tools", label: "Tool activity", tokens: tools },
    ],
  };
}

const STATES: readonly { name: string; usage: SessionContextUsage }[] = [
  { name: "Early (4%)", usage: usageAt(0.04) },
  { name: "Working (41%)", usage: usageAt(0.41) },
  { name: "Below the rung (79%)", usage: usageAt(0.79) },
  { name: "Attention (80%)", usage: usageAt(0.8) },
  { name: "Still attention (94%)", usage: usageAt(0.94) },
  { name: "Destructive (95%)", usage: usageAt(0.95) },
  { name: "Spent (100%)", usage: usageAt(1) },
  { name: "No window known", usage: usageAt(0, null) },
];

export default function ContextUsageScratch() {
  const [value, setValue] = React.useState("");
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        {STATES.map((state) => (
          <div key={state.name} className="flex items-center justify-between gap-4">
            <span className="text-ui text-muted-foreground">{state.name}</span>
            <ContextUsagePill usage={state.usage} />
          </div>
        ))}
      </div>

      {/* The real placement: the pill in the footer's right cluster, resting
          at the footer's own dim until the box has focus. */}
      <SessionComposer
        value={value}
        onValueChange={setValue}
        models={MODELS}
        selection={{ providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "medium" }}
        onSelectionChange={() => {}}
        working={false}
        ready
        queued={[]}
        onQueuedChange={() => {}}
        onSteerQueued={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
        contextUsage={usageAt(0.41)}
      />
    </div>
  );
}
