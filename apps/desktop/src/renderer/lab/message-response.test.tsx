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
  it("enables Streamdown's immediate streaming update mode", () => {
    const html = renderToStaticMarkup(
      <MessageResponse isAnimating>Incremental response</MessageResponse>,
    );

    expect(html).toContain('data-animated="enabled"');
  });

  it("keeps code and Mermaid but does not enable math rendering", () => {
    const message = renderToStaticMarkup(<MessageResponse>Answer</MessageResponse>);
    const reasoning = renderToStaticMarkup(<ReasoningBody>Thinking</ReasoningBody>);

    expect(message).toContain('data-plugins="cjk,code,mermaid"');
    expect(reasoning).toContain('data-plugins="cjk,code,mermaid"');
  });
});
