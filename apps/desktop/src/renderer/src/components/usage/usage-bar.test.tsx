// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());
import { summarizeSessionUsage } from "@volli/shared";
import { UsageBar } from "./usage-bar";
import { UsageTokenCount } from "./usage-token-count";

const summary = summarizeSessionUsage([
  {
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 4200,
    outputTokens: 1100,
    cacheReadTokens: 3_200_000_000_000,
    cacheWriteTokens: 2400,
    costUsd: null,
    costBasis: "unavailable",
  },
]);

describe("Instrument usage", () => {
  it("shares compact notation while preserving the exact token reading", () => {
    const markup = renderToStaticMarkup(<UsageTokenCount tokens={3_200_000_000_000} unit />);
    expect(markup).toContain("3.2T tokens");
    expect(markup).toContain('title="3,200,000,000,000 tokens"');
    expect(markup).toContain('aria-label="3,200,000,000,000 tokens"');
    expect(markup).toContain("tabular-nums");
  });
  it("offers a keyboard target for each class and full precision labels", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<UsageBar summary={summary} />);
    expect(host.querySelectorAll("button")).toHaveLength(4);
    expect(
      host.querySelector('button[aria-label^="Cache read"]')?.getAttribute("aria-label"),
    ).toContain("3,200,000,000,000 tokens");
    expect(host.querySelector('[role="group"]')?.className).toContain("h-8");
  });
  it("never nests controls in a containing card button", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <button>
        <UsageBar summary={summary} interactive={false} />
      </button>,
    );
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelector('[role="img"]')).not.toBeNull();
  });
  it("leaves empty summaries undrawn", () => {
    expect(renderToStaticMarkup(<UsageBar summary={summarizeSessionUsage([])} />)).toBe("");
  });
  it("opens centred details on focus without descriptor text and closes on Escape", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<UsageBar summary={summary} />));
    const button = host.querySelector<HTMLButtonElement>('button[aria-label^="Cache read"]')!;
    await act(async () => button.focus());
    const dialog = document.querySelector('[role="dialog"][aria-label="Cache read"]');
    expect(dialog?.textContent).toContain("3.2T");
    expect(dialog?.textContent).not.toContain("Reused prompt tokens");
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });
});
