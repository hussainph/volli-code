import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const { pluginMaps } = vi.hoisted(() => ({ pluginMaps: [] as Record<string, unknown>[] }));

vi.mock("streamdown", () => ({
  // Shaped like the real export because `message.tsx` derives its sanitizer
  // config from it (VC-273): the `sanitize` entry is a `[plugin, schema]` pair
  // whose `protocols.src` we widen, and a mock without it would leave the
  // module throwing at import.
  defaultRehypePlugins: {
    raw: "raw-plugin",
    sanitize: ["sanitize-plugin", { protocols: { src: ["http", "https"] } }],
    harden: ["harden-plugin", {}],
  },
  Streamdown: ({
    animated,
    plugins,
    rehypePlugins,
    isAnimating,
  }: {
    animated?: boolean;
    isAnimating?: boolean;
    plugins?: Record<string, unknown>;
    rehypePlugins?: unknown[];
  }) => {
    if (plugins) pluginMaps.push(plugins);
    return (
      <output
        data-animated={animated ? "enabled" : "disabled"}
        data-turn-active={isAnimating ? "yes" : "no"}
        data-plugins={Object.keys(plugins ?? {}).join(",")}
        data-image-protocols={JSON.stringify(
          (rehypePlugins ?? [])
            .filter((entry): entry is [unknown, { protocols?: { src?: string[] } }] =>
              Array.isArray(entry),
            )
            .map(([, schema]) => schema?.protocols?.src)
            .find((src) => src !== undefined) ?? null,
        )}
      />
    );
  },
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

  it("passes reasoning liveness separately from the animation scheduler", () => {
    const html = renderToStaticMarkup(<ReasoningBody isAnimating>Thinking</ReasoningBody>);
    expect(html).toContain('data-turn-active="yes"');
    expect(html).toContain('data-animated="disabled"');
  });

  it("selects the live and settled plugin maps", () => {
    const live = renderToStaticMarkup(
      <MessageResponse isAnimating>Incremental response</MessageResponse>,
    );
    const settled = renderToStaticMarkup(<MessageResponse>Answer</MessageResponse>);
    const reasoning = renderToStaticMarkup(<ReasoningBody>Thinking</ReasoningBody>);

    expect(live).toContain('data-plugins="cjk,mermaid,renderers"');
    expect(settled).toContain('data-plugins="cjk,code,mermaid,renderers"');
    expect(reasoning).toContain('data-plugins="cjk,code,mermaid,renderers"');
  });

  it("keeps each phase's plugin map and diagram renderer stable across updates", () => {
    pluginMaps.length = 0;
    renderToStaticMarkup(<MessageResponse isAnimating>One</MessageResponse>);
    renderToStaticMarkup(<MessageResponse isAnimating>Two</MessageResponse>);
    renderToStaticMarkup(<MessageResponse>Three</MessageResponse>);
    renderToStaticMarkup(<MessageResponse>Four</MessageResponse>);
    renderToStaticMarkup(<ReasoningBody>Five</ReasoningBody>);
    renderToStaticMarkup(<ReasoningBody>Six</ReasoningBody>);
    expect(pluginMaps[0]).toBe(pluginMaps[1]);
    expect(pluginMaps[2]).toBe(pluginMaps[3]);
    expect(pluginMaps[4]).toBe(pluginMaps[5]);
    expect(pluginMaps[0]?.renderers).toBe(pluginMaps[2]?.renderers);
    expect(pluginMaps[2]?.renderers).toBe(pluginMaps[4]?.renderers);
    expect(pluginMaps[0]?.mermaid).toBe(pluginMaps[2]?.mermaid);
    expect(pluginMaps.every((map) => !("math" in map))).toBe(true);
  });

  /*
   * The seam itself (VC-273). Streamdown sanitizes before our `img` component
   * can judge a source, and its schema allows `http`/`https` on `src` alone —
   * so an attachment's `volli-blob:` src was deleted upstream and the node
   * reported as `[Image blocked]`. Pinned here because the widening is derived
   * from Streamdown's own export and would break silently on an upgrade that
   * reshaped it.
   */
  it("lets the app's own blob scheme survive sanitization", () => {
    const html = renderToStaticMarkup(<MessageResponse>Answer</MessageResponse>);

    expect(html).toContain(
      `data-image-protocols="${JSON.stringify(["http", "https", "volli-blob", "data"]).replace(
        /"/g,
        "&quot;",
      )}"`,
    );
  });
});
