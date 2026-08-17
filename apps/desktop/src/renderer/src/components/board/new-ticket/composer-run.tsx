/**
 * What Create & start will RUN: the model, and the effort it runs at.
 *
 * This row replaced the terminal-harness picker (VC-15, subsumed by VC-56). The
 * picker named a TUI to launch in a PTY, which is not what the button does any
 * more — kickoff opens the ticket's chat Session — so the question it asked was
 * one the product had stopped asking. The two controls here are the two facts a
 * Session is born with.
 *
 * THEY ARE THE CHAT COMPOSER'S OWN PILLS, imported rather than re-drawn. Press
 * Create & start and you land in a chat pane whose footer carries these exact
 * two controls, showing these exact two values; a second pair shaped slightly
 * differently would be the same control drawn twice and would read as two
 * different settings. The automations lab (`lab/automation/runtime-picker.tsx`)
 * sketched effort INSIDE the model popover, and the shipped chat composer has
 * since settled the other way for a reason that applies here too — effort is
 * the per-task decision and belongs where it can be read without opening
 * anything (`components/chat/composer-effort-ui.tsx`).
 *
 * SEEDED, NOT REMEMBERED. Every open reads the Ticket purpose's configured
 * default (VC-53's Model Access defaults). A choice made here is this ticket's,
 * not a new preference: the durable answer to "what should my tickets run on"
 * already exists in Settings, and a composer that quietly persisted its own
 * would make two places disagree about it. Which is also why the model stays
 * out of the composer's draft cache — a restored draft would carry a model
 * chosen before the default changed, or before that provider was signed out.
 */
import * as React from "react";
import { resolveDefaultModel, type ModelSelection } from "@volli/shared";

import { EffortPill } from "@renderer/components/chat/composer-effort-ui";
import { composerModelSelection } from "@renderer/components/chat/chat-plane-model";
import {
  ModelPill,
  offerableModels,
  type ComposerModel,
} from "@renderer/components/chat/composer-ui";
import { useModelAccessClient } from "@renderer/lib/model-access-client";

/**
 * The empty catalog, as one value: "nothing to offer yet" and "the read failed"
 * are the same state here, and writing it as two `[]` literals would let a
 * future reader think they were told apart.
 */
const NO_MODELS: readonly ComposerModel[] = [];

export interface ComposerRun {
  models: readonly ComposerModel[];
  /**
   * What Create & start will run, or null when the composer has nothing to
   * say: Model Access is unreachable, the catalog read failed, or no default is
   * configured for either purpose. Null is not a blocked state — the start
   * simply sends no override and main resolves the Ticket default itself, which
   * is exactly what every kickoff did before this row existed. If that resolves
   * nothing either, the refusal opens Model Access (VC-53), which is the one
   * recovery there is.
   */
  selection: ModelSelection | null;
  setSelection(selection: ModelSelection): void;
}

/**
 * Read the catalog and the configured Ticket default, once per composer open.
 *
 * Radix mounts the composer fresh on every open, so "once per mount" is "once
 * per open" — which is when the answer can have gone stale: a default changed
 * in Settings, a provider signed in, a model hidden.
 */
export function useComposerRun(): ComposerRun {
  const access = useModelAccessClient();
  const [models, setModels] = React.useState<readonly ComposerModel[]>(NO_MODELS);
  const [selection, setSelection] = React.useState<ModelSelection | null>(null);
  const inspect = access?.inspect;
  const hiddenModels = access?.hiddenModels;
  const defaults = access?.defaults;
  const revision = access?.revision ?? 0;

  React.useEffect(() => {
    if (inspect === undefined || hiddenModels === undefined || defaults === undefined) return;
    let current = true;
    void Promise.all([inspect({}), hiddenModels(), defaults()])
      .then(([snapshot, hidden, configured]) => {
        if (!current) return;
        setModels(offerableModels(snapshot.models, snapshot.providers, hidden));
        // `resolveDefaultModel` is the policy, not a guess: an unset Ticket
        // default MEANS the project default, which is what the Settings row
        // says when it is unset.
        setSelection(resolveDefaultModel(configured, "ticket"));
      })
      .catch(() => {
        // A catalog we could not read costs the ROW, never the kickoff: with
        // no selection the start sends no override and main answers the same
        // question from the same defaults.
        if (!current) return;
        setModels(NO_MODELS);
        setSelection(null);
      });
    return () => {
      current = false;
    };
  }, [defaults, hiddenModels, inspect, revision]);

  return { models, selection, setSelection };
}

/**
 * The pills. Nothing at all while there is no selection — a disabled pair
 * naming no model would be two controls explaining that a third surface is
 * unconfigured, and the start already says that where it can be acted on.
 */
export function ComposerRunRow({ run }: { run: ComposerRun }) {
  const { models, selection, setSelection } = run;
  if (selection === null) return null;
  const stops =
    models.find(
      (model) => model.providerId === selection.providerId && model.modelId === selection.modelId,
    )?.reasoningLevels ?? [];

  return (
    <>
      {/* The pill re-clamps effort onto the incoming model's own stop set, so a
          model change can never leave a level behind that this one cannot run. */}
      <ModelPill
        models={models}
        selection={selection}
        // Never disabled by an empty title: choosing what a ticket will run on
        // is independent of whether the ticket is ready to be created.
        disabled={false}
        onChange={(next) => {
          // A level the wire grammar does not spell cannot be recorded, so a
          // pill that produced one changes nothing rather than half of it.
          const picked = composerModelSelection(next);
          if (picked !== null) setSelection(picked);
        }}
      />
      {/* A model with one level has no decision in it, and a control naming one
          option is worse than no control — the chat composer's own rule. */}
      {stops.length > 1 ? (
        <EffortPill
          levels={stops}
          value={selection.reasoningLevel}
          onChange={(level) => {
            const picked = composerModelSelection({ ...selection, reasoningLevel: level });
            if (picked !== null) setSelection(picked);
          }}
        />
      ) : null}
    </>
  );
}
