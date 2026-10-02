// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ModelCatalogue } from "@renderer/lib/use-model-catalogue";
import { ResolvedModelName } from "./resolved-model-name";
import { AgentModelLine } from "@renderer/components/chat/agent-model-ui";

const held = vi.hoisted(() => ({ catalogue: null as ModelCatalogue | null }));
vi.mock("@renderer/lib/use-model-catalogue", () => ({
  useModelCatalogue: () => held.catalogue,
}));

const selection = { providerId: "anthropic", modelId: "claude-opus-4-1" };
const model = {
  ...selection,
  label: "Claude Opus 4.1",
  state: "unavailable" as const,
  reasoningLevels: [],
  acceptsImageInput: true,
};

beforeEach(() => {
  held.catalogue = { models: [model], providers: [] };
});

function expectModelMark(markup: string): void {
  const container = document.createElement("div");
  container.innerHTML = markup;
  const caption = container.querySelector('[data-slot="model-name"]');
  expect(caption).not.toBeNull();
  expect(caption?.parentElement?.querySelector(":scope > svg[aria-hidden] path")).not.toBeNull();
}

describe("ResolvedModelName", () => {
  it("names a durable selection from the whole catalogue, even if unavailable", () => {
    const markup = renderToStaticMarkup(<ResolvedModelName selection={selection} />);
    expect(markup).toContain("Claude Opus 4.1");
    expect(markup).not.toContain("claude-opus-4-1");
    expectModelMark(markup);
  });

  it("disambiguates the same name offered through two providers", () => {
    held.catalogue = {
      models: [model, { ...model, providerId: "github-copilot" }],
      providers: [],
    };
    const markup = renderToStaticMarkup(
      <ResolvedModelName selection={selection} providerLabel="Anthropic" />,
    );
    expect(markup).toContain("· Anthropic");
  });

  it("matches the full gateway ID and provider rather than splitting model IDs", () => {
    const gateway = { providerId: "openrouter", modelId: "anthropic/claude-opus-4-1" };
    held.catalogue = {
      models: [
        { ...model, ...gateway },
        { ...model, label: "Different account label" },
      ],
      providers: [],
    };
    const markup = renderToStaticMarkup(<ResolvedModelName selection={gateway} />);
    expect(markup).toContain("Claude Opus 4.1");
    expect(markup).not.toContain("Different account label");
    expect(markup).not.toContain(gateway.modelId);
  });

  it("uses the selected provider's model and catalogue account label", () => {
    held.catalogue = {
      models: [{ ...model, providerId: "other", label: "Wrong account" }, model],
      providers: [
        {
          id: "anthropic",
          label: "Anthropic",
          state: "unavailable",
          accountLabel: null,
          billingSource: "subscription",
          recovery: null,
          signIn: [],
          hasStoredCredential: false,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <ResolvedModelName selection={selection} providerLabel="Stale label" alwaysProvider />,
    );
    expect(markup).toContain("Claude Opus 4.1");
    expect(markup).toContain("· Anthropic");
    expect(markup).not.toContain("Wrong account");
    expect(markup).not.toContain("Stale label");
  });

  it("keeps an honest marked ID and provider fallback without a catalogue", () => {
    held.catalogue = null;
    const markup = renderToStaticMarkup(
      <ResolvedModelName selection={selection} providerLabel="Anthropic" trailing="High effort" />,
    );
    expect(markup).toContain("claude-opus-4-1");
    expect(markup).toContain("· Anthropic");
    expect(markup).toContain("· High effort");
    expectModelMark(markup);
    const emptyProvider = renderToStaticMarkup(
      <ResolvedModelName selection={selection} providerLabel="" />,
    );
    expect(emptyProvider).toContain("· anthropic");
  });

  it("uses the same resolved identity on helper rows, with a separate effort gauge", () => {
    const markup = renderToStaticMarkup(
      <AgentModelLine
        agent={{
          id: "helper",
          label: "Review",
          progress: 0,
          state: "working",
          promoted: false,
          model: { ...selection, reasoningLevel: "xhigh" },
        }}
      />,
    );
    expect(markup).toContain("Claude Opus 4.1");
    expect(markup).not.toContain("claude-opus-4-1");
    expect(markup).toContain("Reasoning effort:");
    expect(markup).toContain("Extra high");
    expectModelMark(markup);
    expect(
      renderToStaticMarkup(
        <AgentModelLine
          agent={{
            id: "new",
            label: "New",
            progress: 0,
            state: "working",
            promoted: false,
            model: null,
          }}
        />,
      ),
    ).toBe("");
  });
});
