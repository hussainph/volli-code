/**
 * Shot · newest models, and a model for every subagent.
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

import {
  FrameLayer,
  Supers,
  useFilm,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { Backdrop, useFilmTheme } from "../kit/world";

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

/** What "Refresh models" brings in: the newest releases, invented. */
const NEWEST: ModelAccessSnapshot["models"] = [
  {
    providerId: "anthropic",
    modelId: "claude-opus-5",
    label: "Claude Opus 5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["low", "medium", "high", "max"],
    contextWindow: 400_000,
  },
  {
    providerId: "google",
    modelId: "gemini-4-flash",
    label: "Gemini 4 Flash",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["off", "low", "high"],
  },
];

const SNAPSHOT: ModelAccessSnapshot = { observedAt: 0, models: MODELS, providers: PROVIDERS };
const REFRESHED: ModelAccessSnapshot = {
  observedAt: 1,
  models: [...NEWEST, ...MODELS],
  providers: PROVIDERS,
};

/** After the refresh, Ticket picks up the newest model. */
const DEFAULTS_REFRESHED: ModelAccessDefaults = {
  ...DEFAULTS,
  ticket: { providerId: "anthropic", modelId: "claude-opus-5", reasoningLevel: "high" },
};
/** Then Fast — what quick subagents run on — moves to the new Flash. */
const DEFAULTS_FAST: ModelAccessDefaults = {
  ...DEFAULTS_REFRESHED,
  fast: { providerId: "google", modelId: "gemini-4-flash", reasoningLevel: "low" },
};

/** A client with no main process behind it; state lives for the render only. */
function createModelAccessClient(
  snapshot: ModelAccessSnapshot,
  initial: ModelAccessDefaults,
): ModelAccessClient {
  let defaults = initial;
  let hidden: readonly HiddenModelRef[] = [];
  return {
    inspect: async () => snapshot,
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

/** The shot's three states, swapped by `t`: before the press, after it, Fast re-picked. */
const CLIENTS = [
  createModelAccessClient(SNAPSHOT, DEFAULTS),
  createModelAccessClient(REFRESHED, DEFAULTS_REFRESHED),
  createModelAccessClient(REFRESHED, DEFAULTS_FAST),
] as const;
/** Stable keys for the three stacked clients. */
const PHASE_KEYS = ["before", "refreshed", "fast"] as const;
/** Scene ms: the Refresh press, and the Fast tier's change. Mirrored in models.mjs. */
export const PRESS_AT = 600;
export const FAST_AT = 1750;

/**
 * The pane's layout: a settings column just wide enough for the label beside
 * its two controls, laid out at `ZOOM`, clipped to the Default models card.
 * Mirrored by scripts/film/shots/models.mjs (row centres measured in the lab).
 */
export const ZOOM = 2;
export const PANE = { width: 560, height: 406 };
export const TREE = { width: PANE.width * ZOOM, height: PANE.height * ZOOM };

const CUE1: Omit<Cue, "place"> = {
  at: 100,
  until: 1200,
  lines: ["Newest models,", "one click."],
  weights: [800, 320],
};
const CUE2: Omit<Cue, "place"> = {
  at: 1350,
  until: 2500,
  lines: ["A model for", "every subagent."],
  weights: [320, 800],
};

const CUES: Record<Format, Cue[]> = {
  landscape: [
    // Medium, bottom-left: the card lives in the right ~55% of the frame.
    { ...CUE1, place: "lower", size: "medium" },
    { ...CUE2, place: "lower", size: "medium" },
  ],
  portrait: [
    { ...CUE1, place: "upper" },
    { ...CUE2, place: "upper" },
  ],
};

export function ModelsShot({ format }: { format: Format }) {
  const t = useFilm();
  useFilmTheme("lime");
  useFixtures({ api: appApi, seed: seedApp });
  const phase = t < PRESS_AT ? 0 : t < FAST_AT ? 1 : 2;
  const pressing = t >= PRESS_AT - 120 && t < PRESS_AT + 160;
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
            <div
              style={{ zoom: ZOOM, width: PANE.width }}
              data-film-press={pressing ? "on" : "off"}
              className="[&[data-film-press=on]_button[aria-label='Refresh_models']]:scale-90 [&[data-film-press=on]_button[aria-label='Refresh_models']]:bg-primary/30 [&[data-film-press=on]_button[aria-label='Refresh_models']]:ring-2 [&[data-film-press=on]_button[aria-label='Refresh_models']]:ring-primary"
            >
              {/* All three states stay mounted from frame 0, stacked; only the
                  current one is visible, so a swap never shows a loading pane. */}
              <div style={{ position: "relative" }}>
                {CLIENTS.map((client, index) => (
                  <div
                    key={PHASE_KEYS[index]}
                    style={
                      index === phase
                        ? { position: "relative" }
                        : { position: "absolute", inset: 0, visibility: "hidden" }
                    }
                  >
                    <ModelAccessProvider client={client}>
                      <div className="flex flex-col gap-4" data-film="model-pane">
                        <ModelAccessSettings />
                      </div>
                    </ModelAccessProvider>
                  </div>
                ))}
              </div>
            </div>
          </div>
        }
      />
      <Backdrop t={t} theme="lime" focus={[0.5, 0.5]} />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
