/**
 * What a subagent is running, drawn small (VC-416).
 *
 * A parent picks a model and an effort per delegation, and until this existed
 * neither of the two surfaces built for glancing at a helper said which: the
 * Activity Island's agents card drew a title and a state word, and the peek
 * overlay drew the same pair over a transcript. The only surface that answered
 * was the child's own composer, one promotion away — so the question a glance
 * exists to save a trip for was the one question it could not answer.
 *
 * ONE COMPONENT FOR BOTH SURFACES, which is the point of the file. The card row
 * and the overlay header are the two places the ticket names, they are a press
 * apart, and a reader who sees `sonnet-4.5` in one and `Sonnet 4.5` in the
 * other has learned that the two surfaces are reporting different things. The
 * words come from {@link agentModelFacts}; this is the typesetting.
 *
 * THE EFFORT WEARS A GAUGE, never a separator. `sonnet-4.5 · High` reads as a
 * claim about the MODEL — the exact misreading that moved effort out of the
 * composer's model pill and into a gauge chip beside it (`composer-ui.tsx`,
 * `modelPillLabel`) — so the glyph is what says the second word is a setting
 * and not an adjective. It is the same Gauge the composer's effort pill and the
 * transcript's reasoning row wear: reasoning has one vocabulary in this app.
 *
 * `bold`, per the house rule for glyphs at 12px and smaller, and for the reason
 * the effort pill gives: a gauge is arcs and a needle, and at this size the
 * outline draws lighter than the word beside it.
 */
import type * as React from "react";
import { GaugeIcon } from "@phosphor-icons/react";

import { agentModelFacts, type IslandAgent } from "@volli/session-presentation";

import { cn } from "@renderer/lib/utils";

/**
 * `sonnet-4.5  ⌾ High`, or nothing at all for a child whose policy has not
 * been recorded yet.
 *
 * NOTHING, rather than a placeholder: the gap is one beat long — between a
 * delegated row appearing and its Session's start settling — and a row that
 * printed `— · —` for it would be reporting an absence as a reading. The
 * caller's slot simply stays empty, exactly as `RowState` and `RowOwner` do
 * when they have nothing to say.
 */
export function AgentModelLine({
  agent,
  className,
}: {
  agent: IslandAgent;
  className?: string;
}): React.ReactElement | null {
  const facts = agentModelFacts(agent);
  if (facts === null) return null;
  return (
    <span
      data-agent-model=""
      className={cn(
        "flex min-w-0 items-center gap-1 text-label text-muted-foreground/70",
        className,
      )}
    >
      {/* The model is the term that can be long, so it is the one that gives:
          it truncates and the effort keeps its width. A reader who can see
          only half of `claude-sonnet-4-5-2026…` still knows which family it
          is; an effort clipped to `Ext…` says nothing at all. */}
      <span className="min-w-0 truncate">{facts.model}</span>
      <GaugeIcon aria-hidden weight="bold" className="size-3 shrink-0" />
      {/* WHAT THE GAUGE SAYS, SAID. The glyph is what stops `High` reading as
          an adjective on the model beside it, and a glyph says nothing to a
          screen reader — read aloud, the line would be "sonnet-4.5 High", the
          exact ambiguity the drawing spent a glyph to remove. So the noun is
          spoken and not drawn, in the composer control's own words. An
          `aria-label` on this span would have been the shorter spelling and the
          wrong one: it is not interactive and carries no role, which is the
          case where a label is free to be ignored. */}
      <span className="sr-only">Reasoning effort:</span>
      <span className="shrink-0">{facts.effort}</span>
    </span>
  );
}
