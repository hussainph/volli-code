/**
 * Rendered view of a markdown artifact's content (ticket-detail-mvp decision
 * #17). A THIN wrapper — ONE component, ONE place — deliberately plain
 * preformatted text for the MVP: the parallel Doc-tab/`<Markdown/>` work
 * (step 4) replaces the body below post-merge, with no change needed at
 * either call site (`ticket-doc-tab.tsx`'s body, this tab's viewer).
 * TODO(step-4-merge): render via Markdown component
 */
export function ArtifactContent({ content }: { content: string }) {
  return (
    <pre className="min-h-24 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap text-foreground">
      {content}
    </pre>
  );
}
