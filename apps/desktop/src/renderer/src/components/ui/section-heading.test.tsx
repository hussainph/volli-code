import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SectionHeading, SECTION_HEADING } from "./section-heading";

describe("SectionHeading hierarchy", () => {
  it.each([
    ["h2", "h2", "text-heading", "font-semibold", "text-foreground"],
    ["h3", "h3", "text-ui", "font-semibold", "text-foreground"],
    ["p", "h3", "text-ui", "font-semibold", "text-foreground"],
    ["span", "span", "text-ui", "font-medium", "text-muted-foreground"],
  ] as const)("draws %s on its own type rung", (as, tag, size, weight, ink) => {
    const html = renderToStaticMarkup(<SectionHeading as={as}>Sessions</SectionHeading>);
    expect(html).toContain(`<${tag}`);
    for (const token of [size, weight, ink]) expect(html).toContain(token);
    if (as === "p" || as === "h3") expect(html).toContain(SECTION_HEADING);
    expect(html).toContain(">Sessions<");
    expect(html).not.toContain("uppercase");
    expect(html).not.toContain("tracking-");
    expect(html).not.toContain("text-label");
  });
});
