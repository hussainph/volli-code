/**
 * The markdown file tab's Source ⇄ Document control (plan §4.6, VC-192).
 *
 * Two icons in the segmented control's own pressed/unpressed language, in the
 * same slim band idiom the diff pane's controls live in — `Code` for the file's
 * own bytes, `Article` for the rendered document. `iconOnly` keeps each word as
 * the accessible name, which is what makes a two-way switch cost one control's
 * width instead of a strip of prose.
 *
 * The band draws ONLY on markdown file tabs (`offersMarkdownViewToggle`), which
 * is the whole reason it is allowed to exist at all: the house rule from VC-187
 * is that a control joins the one existing band or a context menu, and a
 * segmented control cannot live in a menu. So this is the same band, borrowed
 * by the one file kind that has a second view to offer — not a strip above
 * every file.
 *
 * ## When Document view is refused
 *
 * The control still draws, disabled, with the reason beside it. The alternative
 * — hiding it — would answer a question the person never got to ask, and they
 * would be left believing this file simply has no document view rather than
 * knowing that its frontmatter is why (`document-view-policy.ts`).
 */
import { ArticleIcon } from "@phosphor-icons/react/dist/csr/Article";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";

import { Segmented } from "@renderer/components/ui/segmented";
import type { DocumentViewRefusal, MarkdownFileView } from "@renderer/editor/document-view-policy";

const VIEWS = [
  { key: "source", label: "Source", icon: CodeIcon },
  { key: "document", label: "Document", icon: ArticleIcon },
] as const;

export function MarkdownViewToggle({
  view,
  refusal,
  onChange,
}: {
  view: MarkdownFileView;
  /** Why Document view is not available for this file, or `null` when it is. */
  refusal: DocumentViewRefusal | null;
  onChange(next: MarkdownFileView): void;
}) {
  return (
    <div
      data-testid="file-view-control-band"
      className="flex shrink-0 items-center gap-2 border-b border-border px-gutter py-1"
    >
      <Segmented
        ariaLabel="Markdown view"
        testId="file-markdown-view"
        value={view}
        options={VIEWS}
        iconOnly
        disabled={refusal !== null}
        className="shrink-0"
        onChange={onChange}
      />
      {refusal !== null && (
        // `title` as well as the text: the band is as narrow as the pane, and a
        // truncated reason is a reason nobody can read.
        <p className="truncate text-ui text-muted-foreground" title={refusal.message}>
          {refusal.message}
        </p>
      )}
    </div>
  );
}
