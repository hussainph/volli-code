import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("streamdown", () => ({
  Streamdown: ({ animated }: { animated?: boolean }) => (
    <output data-animated={animated ? "enabled" : "disabled"} />
  ),
}));

import { MessageResponse } from "../../components/ai-elements/message";

describe("MessageResponse", () => {
  it("enables Streamdown's immediate streaming update mode", () => {
    const html = renderToStaticMarkup(
      <MessageResponse isAnimating>Incremental response</MessageResponse>,
    );

    expect(html).toContain('data-animated="enabled"');
  });
});
