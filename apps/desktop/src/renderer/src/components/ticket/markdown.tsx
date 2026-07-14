import * as React from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { cn } from "@renderer/lib/utils";

/**
 * Renders a markdown `source` string as sanitized HTML inside a `.typeset`
 * container (see typeset.css). The pipeline is deliberately tiny — `marked`
 * (GFM: tables, task lists, strikethrough) → `dompurify` — with no editor
 * framework or React element tree, per ticket-detail-mvp step 4.
 *
 * Sanitization is UNCONDITIONAL: agent-written `.volli` files flow through this
 * same component later, so the sanitize step is never skipped for "trusted"
 * input. `marked.parse` runs synchronously (`async: false`), so there's no
 * flash of raw markdown.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = React.useMemo(() => {
    const raw = marked.parse(source, { async: false, gfm: true });
    return DOMPurify.sanitize(raw);
  }, [source]);

  return <div className={cn("typeset", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
