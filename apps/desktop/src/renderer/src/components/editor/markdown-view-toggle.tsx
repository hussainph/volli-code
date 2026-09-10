/**
 * The markdown file tab's view control (plan §4.6, VC-192; the Preview slot,
 * VC-307).
 *
 * Icons in the segmented control's own pressed/unpressed language, in the same
 * slim band idiom the diff pane's controls live in — `Code` for the file's own
 * bytes, `Article` for the rendered document, `Eye` for the read-only preview.
 * `iconOnly` keeps each word as the accessible name, which is what makes the
 * switch cost one control's width instead of a strip of prose.
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
 * The control still draws Document, disabled, with the reason beside it. The
 * alternative — hiding it — would answer a question the person never got to
 * ask, and they would be left believing this file simply has no document view
 * rather than knowing that its frontmatter is why
 * (`document-view-policy.ts`).
 *
 * A refusal now also ADDS a segment: read-only Preview, which is on offer
 * exactly where Document view is not. The two never appear as live choices
 * together, because they would be the same choice — a rendered picture of the
 * file — differing only in whether it can be typed into.
 *
 * While Preview is in front, the line beside the control stops repeating the
 * refusal and says what this surface IS instead, since that is the fact a
 * person is missing once they are looking at a page they cannot edit. The
 * refusal is a keystroke away in Source, and stays in the control's tooltip.
 */
import { ArticleIcon } from "@phosphor-icons/react/dist/csr/Article";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";

import { Segmented } from "@renderer/components/ui/segmented";
import type { DocumentViewRefusal, MarkdownFileView } from "@renderer/editor/document-view-policy";

const SOURCE = { key: "source", label: "Source", icon: CodeIcon } as const;
const DOCUMENT = { key: "document", label: "Document", icon: ArticleIcon } as const;
const PREVIEW = { key: "preview", label: "Preview", icon: EyeIcon } as const;

/** The editable pair, for a file the projection can honestly show. */
const EDITABLE_VIEWS = [SOURCE, DOCUMENT] as const;
/** A refused file: Document stays on screen, unavailable, and Preview joins it. */
const REFUSED_VIEWS = [SOURCE, { ...DOCUMENT, disabled: true }, PREVIEW] as const;

export function MarkdownViewToggle({
  view,
  refusal,
  sourceDirty,
  onChange,
}: {
  view: MarkdownFileView;
  /** Why Document view is not available for this file, or `null` when it is. */
  refusal: DocumentViewRefusal | null;
  /** Whether Source holds unsaved edits — which Preview, drawing the saved file, is not showing. */
  sourceDirty: boolean;
  onChange(next: MarkdownFileView): void;
}) {
  const note = view === "preview" ? previewNote(sourceDirty) : refusal?.message;
  return (
    <div
      data-testid="file-view-control-band"
      className="flex shrink-0 items-center gap-2 border-b border-border px-gutter py-1"
    >
      <Segmented
        ariaLabel="Markdown view"
        testId="file-markdown-view"
        value={view}
        options={refusal === null ? EDITABLE_VIEWS : REFUSED_VIEWS}
        iconOnly
        className="shrink-0"
        onChange={onChange}
      />
      {note === undefined ? null : (
        // `title` as well as the text: the band is as narrow as the pane, and a
        // truncated reason is a reason nobody can read. In Preview it carries
        // the refusal the line no longer repeats.
        <p
          className="truncate text-ui text-muted-foreground"
          title={refusal === null ? note : refusal.message}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * What Preview says about itself: that it cannot be edited, that unsupported
 * markup may be missing from it, and — only while it is true — that the draft
 * open in Source is not what is on screen.
 */
function previewNote(sourceDirty: boolean): string {
  return sourceDirty
    ? "Read-only preview. Unsaved Source edits and unsupported HTML may be left out."
    : "Read-only preview. Unsupported HTML may be left out.";
}
