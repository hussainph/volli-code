/**
 * A markdown block that cannot cost the page.
 *
 * Streamdown fetches its syntax highlighter lazily — the chunk is requested the
 * first time a fenced block renders, which in a transcript is long after boot.
 * A dev server whose optimized-dep directory has been rewritten in the meantime
 * answers that request with 504, the dynamic import rejects, and React surfaces
 * the rejection as a render error. With no boundary in the path React unmounts
 * the root: one code block takes the transcript, the harness and the benchmark's
 * `window.chatPerf` with it, and only a server restart brings them back.
 *
 * So the boundary sits per block rather than per turn. A block that cannot be
 * highlighted falls back to its own source — which is what an unhighlighted code
 * block is — and every other block on the page still renders. The fallback
 * clears when the source changes, so a transient failure recovers on the next
 * token instead of pinning the block to plain text for the rest of the session.
 */
import * as React from "react";

import { MessageResponse, type MessageResponseProps } from "@ai-elements/message";

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
      <div className="w-full overflow-hidden rounded-md border bg-background">
        <pre className="m-0 overflow-x-auto p-4 font-mono text-sm text-foreground">
          {this.props.source}
        </pre>
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
