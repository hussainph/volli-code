import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderGlyph, type ProviderArtwork } from "./provider-glyph";
import { providerMark } from "@renderer/components/models/model-identity";
import * as modelIdentity from "@renderer/components/models/model-identity";

afterEach(() => vi.restoreAllMocks());

describe("usage provider marks", () => {
  it.each(["anthropic", "openai-codex", "github-copilot", "opencode-go", "kimi-coding"])(
    "uses the existing %s artwork",
    (id) => {
      const mark: ProviderArtwork | null = providerMark(id);
      expect(mark).not.toBeNull();
      const markup = renderToStaticMarkup(<ProviderGlyph id={id} label={id} />);
      expect(markup).toContain(`<svg`);
      expect(markup).toContain(`viewBox="${mark!.viewBox}"`);
      if (mark?.fillRule) expect(markup).toContain(`fill-rule="${mark.fillRule}"`);
    },
  );
  it("retains the artwork's fill and clip rules", () => {
    const mark: ProviderArtwork = {
      paths: ["M0 0h24v24H0Z"],
      viewBox: "0 0 24 24",
      tint: "currentColor",
      fillRule: "evenodd",
      clipRules: ["evenodd"],
    };
    vi.spyOn(modelIdentity, "providerMark").mockReturnValue(mark);
    const markup = renderToStaticMarkup(<ProviderGlyph id="custom" label="Custom" />);
    expect(markup).toContain('fill-rule="evenodd"');
    expect(markup).toContain('clip-rule="evenodd"');
  });
  it("keeps a silent letter fallback for an unrecognised provider", () => {
    expect(renderToStaticMarkup(<ProviderGlyph id="unknown" label="Custom" />)).toContain(
      ">C</span>",
    );
  });
});
