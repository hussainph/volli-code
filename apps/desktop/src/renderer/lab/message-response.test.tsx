import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("streamdown", () => ({
  Streamdown: ({
    animated,
    plugins,
  }: {
    animated?: boolean;
    plugins?: Record<string, unknown>;
  }) => (
    <output
      data-animated={animated ? "enabled" : "disabled"}
      data-plugins={Object.keys(plugins ?? {}).join(",")}
    />
  ),
}));

import { MessageResponse } from "@renderer/components/ui/ai-elements/message";
import { ReasoningBody } from "@renderer/components/ui/ai-elements/reasoning";

describe("MessageResponse", () => {
  // The whole point of the prop's absence: any truthy `animated` builds
  // Streamdown's animation controller, and the controller is what puts every
  // streamed token's re-render on the urgent path ahead of paint. A default
  // reinstated here would be invisible in the UI — the old one ran at 0ms — and
  // would cost a blocking re-lex per token.
  it("hands Streamdown no animation config, even while streaming", () => {
    const html = renderToStaticMarkup(
      <MessageResponse isAnimating>Incremental response</MessageResponse>,
    );

    expect(html).toContain('data-animated="disabled"');
  });

  it("hands the reasoning body no animation config either", () => {
    expect(renderToStaticMarkup(<ReasoningBody>Thinking</ReasoningBody>)).toContain(
      'data-animated="disabled"',
    );
  });

  it("keeps code and Mermaid but does not enable math rendering", () => {
    const message = renderToStaticMarkup(<MessageResponse>Answer</MessageResponse>);
    const reasoning = renderToStaticMarkup(<ReasoningBody>Thinking</ReasoningBody>);

    expect(message).toContain('data-plugins="cjk,code,mermaid"');
    expect(reasoning).toContain('data-plugins="cjk,code,mermaid"');
  });
});
