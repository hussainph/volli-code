import { Markdown } from "./markdown";

/**
 * Rendered view of a markdown artifact's content (ticket-detail-mvp decision
 * #17) — the same sanitized typeset rendering as the ticket body, so `.volli`
 * artifacts read like documents, not source dumps.
 */
export function ArtifactContent({ content }: { content: string }) {
  return (
    <div className="min-h-24 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-4">
      <Markdown source={content} />
    </div>
  );
}
