/**
 * Model tiers (VC-259): the Settings pane over a fixture catalog chosen for
 * its edge cases.
 *
 * The real `ModelAccessSettings`, drawn as the tree it is: Board at the root,
 * Utility and Ticket under it, Fast / Deep / Visual indented under Ticket.
 * Open it, set Fast to Haiku, clear it again, and read what the unset row
 * says ("Same as Ticket Sessions" — and nothing under it, because the row it
 * is the same as is two rows up). Then set Ticket Sessions to
 * `GPT-5.3 Codex Spark`: it cannot read images, so Visual says why it now
 * inherits nothing, and its own picker does not list that model at all.
 *
 * **The catalog is chosen for its edge cases.** One model is blind
 * (`acceptsImageInput: false`); the same name ships from two signed-in
 * providers (Claude Opus 4.5 from Anthropic and from GitHub Copilot), which
 * is the one case the composer's rule says the provider must be said beside
 * the name; one provider (xAI) has no mark in `model-identity.tsx` and wears
 * the lettermark; one provider is signed out. Labels are what pi's catalog
 * actually ships (`model.name`), not raw ids.
 *
 * This scratch held variants A and B of the pane during the VC-259 design
 * review — flat rows under two group headings against the tree — and the
 * tree shipped. The A/B chrome is gone with the decision.
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
export const note = "Six slots on three surfaces — flat tier list, unset rows, the Visual refusal";

export const seed = seedApp;
export const api = appApi;

/* ------------------------------------------------------------ model access */

const MODELS: ModelAccessSnapshot["models"] = [
  // Labels are what pi's catalog actually ships (`model.name`): "Claude Opus
  // 4.5", not `opus-4.5`. A fixture of raw ids made every surface look blander
  // than the product is.
  {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 200_000,
  },
  {
    providerId: "anthropic",
    modelId: "claude-opus-4-5",
    label: "Claude Opus 4.5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["low", "medium", "high", "max"],
    contextWindow: 200_000,
  },
  {
    providerId: "anthropic",
    modelId: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["off", "low", "medium", "high"],
    contextWindow: 200_000,
  },
  {
    providerId: "openai-codex",
    modelId: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 400_000,
  },
  {
    // The blind one: the Visual row must refuse it.
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    state: "available",
    acceptsImageInput: false,
    reasoningLevels: ["low", "medium", "high"],
  },
  {
    // The same name from a second signed-in provider: the composer's rule says
    // this is the one case the provider must be said beside the name.
    providerId: "github-copilot",
    modelId: "claude-opus-4.5",
    label: "Claude Opus 4.5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 200_000,
  },
  {
    // No mark in the identity file: exercises the lettermark fallback.
    providerId: "xai",
    modelId: "grok-4.6",
    label: "Grok 4.6",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["low", "high"],
    contextWindow: 256_000,
  },
  {
    // Signed out: a tier pointing here names a model the profile cannot run.
    providerId: "google",
    modelId: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
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
    id: "github-copilot",
    label: "GitHub Copilot",
    state: "available",
    accountLabel: "demo",
    billingSource: "subscription",
    recovery: null,
    hasStoredCredential: true,
    signIn: [],
  },
  {
    id: "xai",
    label: "xAI",
    state: "available",
    accountLabel: null,
    billingSource: "api-key",
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
  global: { providerId: "anthropic", modelId: "claude-sonnet-4-5", reasoningLevel: "medium" },
  ticket: { providerId: "anthropic", modelId: "claude-opus-4-5", reasoningLevel: "high" },
  fast: { providerId: "anthropic", modelId: "claude-haiku-4-5", reasoningLevel: "low" },
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
    pickerView: () => Promise.resolve("all" as const),
    setPickerView: (view) => Promise.resolve(view),
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
            Board Sonnet · Ticket Opus · Fast Haiku · Deep and Visual inherit
          </span>
        </div>
        <section className="flex flex-col gap-4">
          <h2 className="text-ui font-medium text-muted-foreground">Settings → Model Access</h2>
          <div className="flex max-w-4xl flex-col gap-4">
            <ModelAccessSettings />
          </div>
        </section>
      </div>
    </ModelAccessProvider>
  );
}
