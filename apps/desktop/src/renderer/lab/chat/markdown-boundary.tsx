/**
 * A markdown block that cannot cost the page — and a highlighter that is
 * already there by the time a block needs it.
 *
 * Streamdown highlights through `React.lazy(() => import(…))`, so the
 * highlighter chunk is requested the first time a fenced block RENDERS, which
 * in a transcript can be long after boot. That lateness is the whole bug. Vite
 * serves optimized deps at a `?v=<browserHash>` URL and 504s any request whose
 * hash it has moved past, and it moves past hashes constantly: a cold optimizer
 * run assigns a session hash, a warm one replays the deterministic hash from
 * `_metadata.json`, and every re-optimization re-stamps what it publishes. A
 * page keeps whatever hash was current when its modules were transformed. For
 * the modules it finished loading that is harmless — they are in the browser's
 * registry and are never fetched again. For the one chunk it has NOT fetched it
 * is fatal, and it stays fatal until the page is reloaded.
 *
 * `HighlighterWarmup` closes that window by highlighting a throwaway fence at
 * lab boot, so the chunk — and the grammars and themes it reaches for, which
 * are lazy in the same way — are fetched while their URLs are still the ones
 * the server will answer, alongside every other module the page loads. After
 * that the lazy component is resolved and later blocks never touch the network.
 *
 * The boundary stays because warming is a smaller promise than never failing:
 * the chunk can still be missing (a dep cache wiped underneath a live page),
 * and React surfaces a rejected lazy import as a render error, which with no
 * boundary in the path unmounts the root — one code block taking the
 * transcript, the harness and the benchmark's `window.chatPerf` with it. So the
 * boundary sits per block rather than per turn, and a block that cannot be
 * highlighted falls back to READING its source rather than printing it: fences
 * become a code frame instead of visible ``` markers. The fallback clears when
 * the source changes, so a transient failure recovers on the next token instead
 * of pinning the block to plain text for the rest of the session.
 */
import * as React from "react";

import { MessageResponse, type MessageResponseProps } from "@ai-elements/message";

import { splitMarkdownSource } from "./markdown-source";

interface BoundaryProps {
  /** The markdown this block was asked to render; also the fallback's text. */
  source: string;
  children: React.ReactNode;
}

interface BoundaryState {
  failed: boolean;
  /** The source the current verdict was reached on. A new one earns a retry. */
  source: string;
}

class MarkdownBoundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false, source: props.source };
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    // Runs before every render, including the one React does after catching —
    // and there the source is unchanged, so the verdict survives to be drawn.
    if (props.source === state.source) return null;
    return { failed: false, source: props.source };
  }

  override componentDidCatch(error: unknown): void {
    // Never silent: the block degrades on screen, and the reason stays legible
    // in the console rather than only in a network panel long since scrolled.
    console.error("[lab] markdown block failed to render", error);
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex w-full flex-col gap-2" data-lab-markdown-fallback>
        {splitMarkdownSource(this.props.source).map((segment) =>
          segment.kind === "code" ? (
            <div
              key={segment.line}
              className="w-full overflow-hidden rounded-xl border border-border bg-sidebar"
              data-language={segment.language ?? undefined}
            >
              {segment.language ? (
                <div className="px-3 pt-2 font-mono text-muted-foreground text-xs lowercase">
                  {segment.language}
                </div>
              ) : null}
              <pre className="m-0 overflow-x-auto p-3 font-mono text-foreground text-sm">
                <code>{segment.text}</code>
              </pre>
            </div>
          ) : (
            <p key={segment.line} className="m-0 whitespace-pre-wrap text-foreground">
              {segment.text}
            </p>
          ),
        )}
      </div>
    );
  }
}

/**
 * `MessageResponse` with the boundary already around it. Same props, so call
 * sites read the same; the wrapper adds one fiber per block and nothing else,
 * and `MessageResponse`'s own memo still bails on an unchanged source.
 */
export function GuardedResponse({ children, ...props }: MessageResponseProps) {
  const source = typeof children === "string" ? children : "";
  return (
    <MarkdownBoundary source={source}>
      <MessageResponse {...props}>{children}</MessageResponse>
    </MarkdownBoundary>
  );
}

/**
 * One fence per language the lab's transcripts actually contain.
 *
 * The highlighter chunk is not the only thing fetched late: Shiki resolves a
 * grammar per language and a chunk per theme when a block first asks for them,
 * so warming the highlighter alone still leaves `typescript`, `tsx` and both
 * themes to be fetched at first render. Highlighting one block in each language
 * pulls all of it. This list is the lab's fixtures, not an attempt at Shiki's
 * catalogue — a language nobody has written a fixture in is still fetched late,
 * and still degrades to unhighlighted code rather than to a broken block.
 */
const WARMUP_SOURCE = "```ts\n0\n```\n\n```tsx\n<a />\n```\n\n```bash\ntrue\n```";

/**
 * How long the warm-up stays mounted. It has to outlive the highlighter's own
 * import — unmounting the moment the chunk request starts leaves the component
 * gone before it can ask for a grammar, which was the whole point. Measured at
 * ~1s on a cold optimizer; the margin is for a machine under load.
 */
const WARMUP_MS = 5_000;

/**
 * Highlights a throwaway block at boot, then takes itself off the page.
 *
 * Rendering is what makes `React.lazy` call its importer and what makes the
 * highlighter ask for a grammar, so this has to render — importing the module
 * would fetch the chunk and stop there. It unmounts once that is done so it
 * cannot show up in anything that counts what is on the page: the benchmark
 * scratch's timings, or a probe counting `<pre>` elements.
 *
 * `hidden` rather than an off-screen position so it can never contribute
 * layout, and it is inside the boundary so a warm-up that fails is still just a
 * warm-up that failed.
 */
export function HighlighterWarmup(): React.ReactElement | null {
  const [warmed, setWarmed] = React.useState(false);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setWarmed(true), WARMUP_MS);
    return () => window.clearTimeout(timer);
  }, []);
  if (warmed) return null;
  return (
    <div hidden aria-hidden="true" data-lab-highlighter-warmup>
      <MarkdownBoundary source={WARMUP_SOURCE}>
        <MessageResponse>{WARMUP_SOURCE}</MessageResponse>
      </MarkdownBoundary>
    </div>
  );
}
