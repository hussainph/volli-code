// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";

import { pele } from "./pele-diagram";

const render = (source: string, id = "test-diagram") => pele.getMermaid().render(id, source);

describe("Pele's Streamdown adapter", () => {
  it("keeps the diagram contract and renders themed SVG synchronously behind the promise", async () => {
    expect(pele).toMatchObject({ name: "mermaid", language: "mermaid", type: "diagram" });
    const engine = pele.getMermaid();
    expect(engine.initialize({ securityLevel: "loose" })).toBeUndefined();
    const { svg } = await render("flowchart LR\n A[Start]-->B[Finish]");
    expect(svg).toContain('class="pele pele-flowchart"');
    expect(svg).toContain("var(--pele-fg");
    expect(svg).toContain("Start");
    expect(svg).toContain("Finish");
  });

  it.each([
    [
      "sequence",
      "sequenceDiagram\n Client->>Server: Request\n alt Ready\n Server-->>Client: Done\n else Busy\n Server-->>Client: Retry\n end",
    ],
    ["state", "stateDiagram-v2\n [*] --> Draft\n Draft --> Published\n Published --> [*]"],
    ["pie", 'pie title Inventory\n "Books": 3\n "Pens": 2'],
    ["xychart", 'xychart-beta\n x-axis [Mon, Tue, Wed]\n y-axis "Count" 0 --> 10\n bar [2, 5, 8]'],
  ])("renders invented %s fixtures", async (_name, source) => {
    expect((await render(source)).svg).toContain("<svg");
  });

  it("rejects malformed sources and keeps the default input limit", async () => {
    await expect(render("not a diagram")).rejects.toThrow();
    await expect(render(`flowchart LR\n A[${"x".repeat(1_000_000)}]`)).rejects.toThrow();
  });

  it("never enables links, images or click handlers, even via caller config/directives", async () => {
    const engine = pele.getMermaid({ securityLevel: "loose", links: true, images: true });
    const { svg } = await engine.render(
      "safe",
      [
        '%%{init: {"securityLevel": "loose"}}%%',
        "flowchart LR",
        ' A["<script>alert(1)</script>"] --> B[Destination]',
        ' click A "javascript:alert(1)"',
        ' click B "https://example.com"',
        ' C@{ img: "https://example.com/image.png", label: "External" }',
        " click C call runCallback()",
      ].join("\n"),
    );
    expect(svg).not.toMatch(/<(?:a|image|script)\b|\bon\w+=|javascript:|https:\/\/example/);
    expect(svg).not.toContain("runCallback");
  });

  it("leaves math as text, without a resolver", async () => {
    const { svg } = await render('flowchart LR\n A["$$x^2$$"]');
    expect(svg).not.toMatch(/katex|<math\b/);
    expect(svg).toContain("x^2");
  });

  it("uses the call's id prefix so simultaneous inline and fullscreen definitions do not collide", async () => {
    const source = "sankey-beta\nSource,Destination,5";
    const first = (await render(source, "inline-id")).svg;
    const second = (await render(source, "fullscreen-id")).svg;
    expect(first).toContain("inline-id");
    expect(second).toContain("fullscreen-id");
    expect(second).not.toContain("inline-id");
  });
});
