/**
 * Model tiers (VC-259): the Settings rows, the picker's Defaults view, and the
 * Automation editor's tier option — the three surfaces that show the same six
 * slots, side by side so their vocabulary can be judged as one.
 *
 * **Settings.** The real `ModelAccessSettings` pane over a fixture catalog.
 * Board / Ticket / Utility sit where they always did; the three advanced tiers
 * are behind the Advanced row. Open it, set Fast to haiku, clear it again, and
 * read what the unset row says. Try to set Visual to `gpt-5.3-codex-spark`: it
 * cannot read images, and the save refuses with the one-line reason.
 *
 * **The catalog is chosen for its edge cases.** One model is blind
 * (`acceptsImageInput: false`); one provider is signed out, so a tier pointing
 * at it has a model the profile cannot run today. Both are states the Defaults
 * view has to draw.
 *
 * WHAT THE LAB CANNOT SHOW: persistence. The client below holds state in memory
 * and forgets it on reload.
 */
import * as React from "react";
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  visualModelProblem,
} from "@volli/shared";
import type {
  HiddenModelRef,
  ModelAccessDefaults,
  ModelAccessSnapshot,
  ModelPurpose,
  ModelSelection,
} from "@volli/shared";

import { ModelAccessSettings } from "@renderer/components/pages/model-access-settings";
import { Button } from "@renderer/components/ui/button";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

import { appApi, seedApp } from "../seed";

export const title = "Model tiers · Settings, picker Defaults, Automation runtime";
export const note =
  "Six slots on three surfaces — Advanced disclosure, unset rows, the Visual refusal";

export const seed = seedApp;
export const api = appApi;

/* ------------------------------------------------------------ model access */

const MODELS: ModelAccessSnapshot["models"] = [
  {
    providerId: "anthropic",
    modelId: "sonnet-4.5",
    label: "sonnet-4.5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 200_000,
  },
  {
    providerId: "anthropic",
    modelId: "opus-4.5",
    label: "opus-4.5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["low", "medium", "high", "max"],
    contextWindow: 200_000,
  },
  {
    providerId: "anthropic",
    modelId: "haiku-4.5",
    label: "haiku-4.5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["off", "low", "medium", "high"],
    contextWindow: 200_000,
  },
  {
    providerId: "openai-codex",
    modelId: "gpt-5.6-luna",
    label: "gpt-5.6-luna",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 400_000,
  },
  {
    // The blind one: the Visual row must refuse it.
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex-spark",
    label: "gpt-5.3-codex-spark",
    state: "available",
    acceptsImageInput: false,
    reasoningLevels: ["low", "medium", "high"],
  },
  {
    // Signed out: a tier pointing here names a model the profile cannot run.
    providerId: "google",
    modelId: "gemini-3.8-flash",
    label: "gemini-3.8-flash",
    state: "authentication-required",
    acceptsImageInput: true,
    reasoningLevels: ["off", "low", "high"],
  },
];

const PROVIDERS: ModelAccessSnapshot["providers"] = [
  {
    id: "anthropic",
    label: "Anthropic",
    state: "available",
    accountLabel: "demo@voltaic.dev",
    billingSource: "subscription",
    recovery: null,
    hasStoredCredential: true,
    signIn: [],
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    state: "available",
    accountLabel: "demo@voltaic.dev",
    billingSource: "subscription",
    recovery: null,
    hasStoredCredential: true,
    signIn: [],
  },
  {
    id: "google",
    label: "Google",
    state: "authentication-required",
    accountLabel: null,
    billingSource: "api-key",
    recovery: null,
    hasStoredCredential: false,
    signIn: [],
  },
];

/** Board and Ticket set, Fast set, Deep and Visual inherit. */
const SEEDED_DEFAULTS: ModelAccessDefaults = {
  ...EMPTY_MODEL_ACCESS_DEFAULTS,
  global: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "medium" },
  ticket: { providerId: "anthropic", modelId: "opus-4.5", reasoningLevel: "high" },
  fast: { providerId: "anthropic", modelId: "haiku-4.5", reasoningLevel: "low" },
};

/**
 * A Model Access client with no main process behind it. `setDefault` applies
 * the same two rules main does — availability, and the Visual image rule — so
 * the refusal toast is the real one.
 */
function labModelAccess(): ModelAccessClient {
  let defaults: ModelAccessDefaults = SEEDED_DEFAULTS;
  let hidden: readonly HiddenModelRef[] = [];
  return {
    inspect: () =>
      Promise.resolve({ observedAt: Date.now(), providers: PROVIDERS, models: MODELS }),
    defaults: () => Promise.resolve(defaults),
    setDefault: (purpose: ModelPurpose, selection: ModelSelection | null) => {
      if (selection !== null && purpose === "visual") {
        const problem = visualModelProblem(MODELS, selection);
        if (problem !== null) return Promise.reject(new Error(problem));
      }
      defaults = { ...defaults, [purpose]: selection };
      return Promise.resolve(defaults);
    },
    hiddenModels: () => Promise.resolve(hidden),
    setHiddenModels: (next) => {
      hidden = next;
      return Promise.resolve(hidden);
    },
    compactionPolicy: () => Promise.resolve(DEFAULT_COMPACTION_POLICY),
    setCompactionPolicy: (policy) => Promise.resolve(policy),
    beginSignIn: () => Promise.reject(new Error("Sign-in needs the main process")),
    signOut: () => Promise.reject(new Error("Sign-out needs the main process")),
  };
}

/* ------------------------------------------------------------------ scratch */

export default function ModelTiersScratch() {
  const [generation, setGeneration] = React.useState(0);
  const client = React.useMemo(labModelAccess, [generation]);

  return (
    <ModelAccessProvider key={generation} client={client}>
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setGeneration((n) => n + 1)}>
            Reset defaults
          </Button>
          <span className="text-ui text-muted-foreground">
            Board sonnet · Ticket opus · Fast haiku · Deep and Visual inherit
          </span>
        </div>
        <section className="flex flex-col gap-4">
          <h2 className="text-ui font-medium text-muted-foreground">Settings → Model Access</h2>
          <div className="flex max-w-3xl flex-col gap-4">
            <ModelAccessSettings />
          </div>
        </section>
      </div>
    </ModelAccessProvider>
  );
}
