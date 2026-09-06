import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ReasoningDropNotice } from "./reasoning-drop-notice-ui";

function markup(causes: readonly ("prefix-mismatch" | "model-mismatch" | "unknown")[]): string {
  return renderToStaticMarkup(
    <ReasoningDropNotice
      drop={{
        sequence: 4,
        turnId: "turn-1",
        afterMessageId: "message-1",
        count: 1,
        causes,
      }}
    />,
  );
}

describe("ReasoningDropNotice", () => {
  it("shows the provider recovery as a quiet transcript fact", () => {
    const html = markup(["prefix-mismatch"]);

    expect(html).toContain("Earlier reasoning was dropped");
    expect(html).toContain("the conversation prefix changed");
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain('role="alert"');
  });

  it("names a server-side model change differently", () => {
    expect(markup(["model-mismatch"])).toContain("the provider changed the model");
  });
});
