import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { InfoHint } from "./info-hint";

it("makes context and its links visible without a hint trigger", () => {
  const html = renderToStaticMarkup(
    <InfoHint label="Inheritance" interactive>
      <a href="#details">Details</a>
    </InfoHint>,
  );
  expect(html).toContain('href="#details"');
  expect(html).toContain("text-muted-foreground");
  expect(html).not.toContain("button");
});
