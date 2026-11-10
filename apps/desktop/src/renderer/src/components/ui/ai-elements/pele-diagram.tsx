import { render as renderPele } from "pele";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  Streamdown,
  StreamdownContext,
  type CustomRenderer,
  type CustomRendererProps,
  type DiagramPlugin,
} from "streamdown";

// Ignore Mermaid config, including fence directives: callers cannot relax the
// security policy. Pele ignores click callbacks; external links, images and
// math resolvers are deliberately absent. Omitted limits retain Pele's guards.
const security = { links: false, images: false, linkSchemes: [] };

/** The name/language are Streamdown's wire contract, not the rendering engine. */
export const pele: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid: () => ({
    initialize() {},
    async render(id, source) {
      // Independent prefixes matter when inline and fullscreen SVGs coexist.
      const { svg } = renderPele(source, { ...security, idPrefix: id });
      return { svg };
    },
  }),
};

// Both maps (including the nested one) are module constants. Streamdown's memo
// compares plugin identity; recreating a map per token would defeat its cache.
const diagramPlugins = { mermaid: pele };
const SAMPLE_MS = 100;

/** A leading sample and one trailing sample per interval, never a debounce. */
function useSampledSource(code: string, streaming: boolean): string {
  const [sample, setSample] = useState(code);
  const latest = useRef(code);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latest.current = code;
    if (!streaming) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setSample(latest.current);
      }, SAMPLE_MS);
    }
  }, [code, streaming]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // Closing the fence or settling the Turn bypasses the timer, even when the
  // source did not change. An interrupted, unclosed fence is final too.
  return streaming ? sample : code;
}

/** Use a fence longer than any backtick run in the source, not a fixed ``` . */
function fenced(source: string): string {
  const longest = Math.max(2, ...Array.from(source.matchAll(/`+/g), ([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}mermaid\n${source}\n${fence}`;
}

/**
 * Streamdown 2.7 renders open fences, but its diagram adapter receives neither
 * fence identity nor completeness. Its error UI is shown only BEFORE any SVG
 * succeeds: a final rejection otherwise keeps a stale drawing forever.
 *
 * This public custom-renderer seam owns per-fence validity, not diagram chrome.
 * Partial errors retain the last source that parsed (or draw nothing yet).
 * Closed/settled errors use Streamdown's code fallback. Valid sources go through
 * a nested, static Streamdown with the strict adapter above, preserving its own
 * download/copy, pan/zoom and mermaid-fullscreen portal. No internals are copied.
 * Validation and display each render once: the latter needs a fresh SVG prefix
 * for fullscreen/export as well as inline display, so SVG strings are not shared.
 *
 * Live work is sampled at 100 ms, with immediate final validation. Re-measured
 * through the guarded volli-drive bench on 79952778f: 1 real ChatPlane / 1600
 * fixture messages, an invented graph at 30 chunks/s, 240 two-paint scroll steps.
 * Three samples per arm: zero-delay/every-update dropped 114/17/37 frames,
 * with 7/0/0 long tasks totalling 431/0/0 ms; 100 ms dropped 7/4/1 frames,
 * with 1/1/0 tasks totalling 60/51/0 ms. All six painted changing, intersecting
 * SVGs with the full final graph. Distinct visible label sets fell from
 * 14/13/14 to 8/8/7: fewer transient layouts while groups/edges arrive.
 *
 * These are synthetic, shared-host samples, in one sequential order, not idle
 * timings, GPU presentation latency or causal speedup evidence. RSS was higher
 * in the 100 ms run; no memory improvement is claimed. The decision is to
 * coalesce topology churn, not to promise faster frames from noisy data. Older
 * direct-launch measurements are historical, not comparable to this harness.
 * Reproduce with chat-window-bench.mjs --arm stream --sessions 1 --turns 1600
 * --stream-content diagram --stream-samples 3 --stream-steps 240
 * --diagram-sample-ms 0 (then 100), each with a fresh --output directory.
 */
function PeleDiagram({ code, isIncomplete }: CustomRendererProps) {
  const context = useContext(StreamdownContext);
  const streaming = isIncomplete && context.isAnimating;
  const source = useSampledSource(code, streaming);
  const valid = useMemo(() => {
    try {
      renderPele(source, { ...security, idPrefix: "validate" });
      return true;
    } catch {
      return false;
    }
  }, [source]);
  const [lastGood, setLastGood] = useState<string | null>(null);
  useEffect(() => {
    if (valid) setLastGood(source);
  }, [source, valid]);

  if (!valid && !streaming) {
    return (
      <CodeBlock code={code} language="mermaid">
        <CodeBlockDownloadButton code={code} language="mermaid" />
        <CodeBlockCopyButton code={code} />
      </CodeBlock>
    );
  }
  const display = valid ? source : lastGood;
  if (display === null) return null;

  return (
    <Streamdown
      mode="static"
      plugins={diagramPlugins}
      isAnimating={context.isAnimating}
      controls={context.controls}
      mermaid={context.mermaid}
      portal={context.portal}
    >
      {fenced(display)}
    </Streamdown>
  );
}

export const peleRenderers: CustomRenderer[] = [{ language: "mermaid", component: PeleDiagram }];
