import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Message, MessageContent } from "./message";

describe("conversation paper", () => {
  it("uses the authored accent tint and solved ink for the user only", () => {
    const html = renderToStaticMarkup(
      <Message from="user">
        <MessageContent>Hello</MessageContent>
      </Message>,
    );
    // Accent paint is derived; geometry comes from the named shared scale.
    expect(html).toContain("group-[.is-user]:bg-(--accent-selected)");
    expect(html).toContain("group-[.is-user]:text-primary-text");
    expect(html).toContain("group-[.is-user]:rounded-floating");
    expect(html).not.toContain("group-[.is-user]:bg-muted");
  });

  it("leaves assistant prose on paper without a second content card", () => {
    const html = renderToStaticMarkup(
      <Message from="assistant">
        <MessageContent>Answer</MessageContent>
      </Message>,
    );
    expect(html).toContain("is-assistant");
    expect(html).toContain("group-[.is-assistant]:text-foreground");
    expect(html).not.toContain("group-[.is-assistant]:bg-");
    expect(html).toContain("leading-prose");
  });
});
