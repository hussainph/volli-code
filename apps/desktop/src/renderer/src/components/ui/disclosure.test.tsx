import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./accordion";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import { Separator } from "./separator";

describe("disclosure defaults", () => {
  it("provides an overridable type baseline and contains unbroken accordion values", () => {
    const html = renderToStaticMarkup(
      <Accordion type="single" defaultValue="item">
        <AccordionItem value="item">
          <AccordionTrigger>Account</AccordionTrigger>
          <AccordionContent className="text-sm">{"long-value-".repeat(80)}</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    expect(html).toContain("font-semibold");
    expect(html).toContain("text-ui");
    expect(html).toContain("min-w-0 max-w-full");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("text-sm");
    expect(html).not.toContain("disclosure-content");
  });
  it("keeps generic disclosures instant while accepting the legacy animated prop", () => {
    const html = renderToStaticMarkup(
      <Collapsible open>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent className="px-2">Body</CollapsibleContent>
        <CollapsibleContent animated={false}>Instant</CollapsibleContent>
      </Collapsible>,
    );
    expect(html).toContain('data-state="open" data-slot="collapsible"');
    expect(html).not.toContain("disclosure-content");
    expect(html).not.toContain("--disclosure-height");
    expect(html).toContain("px-2");
    expect(html).toContain('data-animated="false"');
  });
  it("stretches a vertical separator in a flex row without requiring a percentage height", () => {
    const html = renderToStaticMarkup(<Separator orientation="vertical" decorative={false} />);
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain("self-stretch");
    expect(html).toContain("h-auto");
    expect(html).toContain("min-h-4");
    expect(html).not.toContain("h-full");
    const explicitHeight = renderToStaticMarkup(
      <Separator orientation="vertical" className="h-12" />,
    );
    expect(explicitHeight).toContain("h-12");
    expect(explicitHeight).not.toContain("h-auto");
  });
});
