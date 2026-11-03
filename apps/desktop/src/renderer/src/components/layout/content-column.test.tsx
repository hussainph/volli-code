import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ContentColumn, WorkbenchColumn } from "./content-column";
import { Message, MessageContent } from "@renderer/components/ui/ai-elements/message";

describe("reading containers", () => {
  it.each([ContentColumn, WorkbenchColumn])(
    "can shrink inside a split without intrinsic overflow",
    (Column) => {
      const html = renderToStaticMarkup(<Column>Prose</Column>);
      for (const token of ["min-w-0", "w-full", "px-gutter"]) expect(html).toContain(token);
    },
  );
  it("gives assistant prose the full column measure and wraps long unbroken text", () => {
    const html = renderToStaticMarkup(
      <Message from="assistant">
        <MessageContent>https://example.test/a/very/long/path</MessageContent>
      </Message>,
    );
    expect(html).not.toContain("95%");
    expect(html).toContain("min-w-0");
    expect(html).toContain("wrap-anywhere");
    expect(renderToStaticMarkup(<Message from="user" />)).toContain("max-w-[95%]");
  });
});
