/**
 * Shot · a model for every job (VC-259).
 *
 * Real: `ModelAccessSettings` inside a `ModelAccessProvider` — the Settings →
 * Model Access pane, drawing the tier tree it shipped with: Board at the root,
 * Utility and Ticket Sessions under it, Fast / Deep / Visual indented under
 * Ticket behind the left rule. Fixture: the catalog and the six defaults (the
 * same shape `lab/scratches/model-tiers.tsx` seeds), chosen so every row names
 * its own model across three providers.
 *
 * Only the tree is in frame. The pane is laid out at a settings-column width
 * and clipped to its first section, "Default models", so Compaction, the
 * catalog and the provider accounts below it (the only place an account
 * identity could appear) are never drawn. Provider account labels are null
 * anyway.
 *
 * The pane is laid out at 2× (`zoom`) rather than magnified by the camera, so
 * tier and model names are rasterised crisp at the distance the rig holds.
 */
import { Surface } from "@webprodigies/flute";
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type HiddenModelRef,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
  type ModelPurpose,
  type ModelSelection,
} from "@volli/shared";

import { ModelAccessSettings } from "@renderer/components/pages/model-access-settings";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { appApi, seedApp } from "../../renderer/lab/seed";

import { FrameLayer, Supers, useFilm, useFixtures, Vignette, type Cue, type Format } from "../kit/film";

const MODELS: ModelAccessSnapshot["models"] = [
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
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    state: "available",
    acceptsImageInput: false,
    reasoningLevels: ["low", "medium", "high"],
  },
  {
    providerId: "google",
    modelId: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["off", "low", "high"],
  },
];

function provider(
  id: string,
  label: string,
  billingSource: "subscription" | "api-key",
): ModelAccessSnapshot["providers"][number] {
  return {
    id,
    label,
    state: "available",
    // No account identity anywhere in the fixture, in frame or out of it.
    accountLabel: null,
    billingSource,
    recovery: null,
    hasStoredCredential: true,
    signIn: [],
  };
}

const PROVIDERS: ModelAccessSnapshot["providers"] = [
  provider("anthropic", "Anthropic", "subscription"),
  provider("openai-codex", "OpenAI Codex", "subscription"),
  provider("google", "Google", "api-key"),
];

/** Every rung set: one model per kind of work. */
const DEFAULTS: ModelAccessDefaults = {
  ...EMPTY_MODEL_ACCESS_DEFAULTS,
  global: { providerId: "anthropic", modelId: "claude-sonnet-4-5", reasoningLevel: "medium" },
  utility: { providerId: "anthropic", modelId: "claude-haiku-4-5", reasoningLevel: "off" },
  ticket: { providerId: "anthropic", modelId: "claude-opus-4-5", reasoningLevel: "high" },
  fast: { providerId: "openai-codex", modelId: "gpt-5.3-codex-spark", reasoningLevel: "low" },
  deep: { providerId: "openai-codex", modelId: "gpt-5.6-luna", reasoningLevel: "xhigh" },
  visual: { providerId: "google", modelId: "gemini-3.8-flash", reasoningLevel: "high" },
};

const SNAPSHOT: ModelAccessSnapshot = { observedAt: 0, models: MODELS, providers: PROVIDERS };

/** A client with no main process behind it; state lives for the render only. */
function createModelAccessClient(): ModelAccessClient {
  let defaults = DEFAULTS;
  let hidden: readonly HiddenModelRef[] = [];
  return {
    inspect: async () => SNAPSHOT,
    defaults: async () => defaults,
    setDefault: async (purpose: ModelPurpose, selection: ModelSelection | null) => {
      defaults = { ...defaults, [purpose]: selection };
      return defaults;
    },
    hiddenModels: async () => hidden,
    setHiddenModels: async (next) => {
      hidden = next;
      return hidden;
    },
    compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
    setCompactionPolicy: async (policy) => policy,
    pickerView: async () => "all",
    setPickerView: async (view) => view,
    beginSignIn: async () => {
      throw new Error("Sign-in is not part of this fixture.");
    },
    signOut: async () => undefined,
  };
}

const CLIENT = createModelAccessClient();

/**
 * The pane's layout: a settings column just wide enough for the label beside
 * its two controls, laid out at `ZOOM`, clipped to the Default models card.
 * Mirrored by scripts/film/shots/models.mjs (row centres measured in the lab).
 */
export const ZOOM = 2;
export const PANE = { width: 560, height: 406 };
export const TREE = { width: PANE.width * ZOOM, height: PANE.height * ZOOM };

const CUE: Omit<Cue, "place"> = {
  at: 250,
  until: 1650,
  eyebrow: "VC-259",
  lines: ["A model for", "every job."],
};

const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "lower" }],
  portrait: [{ ...CUE, place: "upper" }],
};

export function ModelsShot({ format }: { format: Format }) {
  const t = useFilm();
  useFixtures({ api: appApi, seed: seedApp });
  return (
    <>
      <Surface
        id="model-tree"
        style={{
          position: "absolute",
          left: `calc(50% - ${TREE.width / 2}px)`,
          top: `calc(50% - ${TREE.height / 2}px)`,
          width: TREE.width,
          height: TREE.height,
        }}
        content={
          <div
            className="overflow-hidden rounded-lg border border-border shadow-overlay"
            style={{ width: TREE.width, height: TREE.height }}
          >
            <div style={{ zoom: ZOOM, width: PANE.width }}>
              <ModelAccessProvider client={CLIENT}>
                <div className="flex flex-col gap-4" data-film="model-pane">
                  <ModelAccessSettings />
                </div>
              </ModelAccessProvider>
            </div>
          </div>
        }
      />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
