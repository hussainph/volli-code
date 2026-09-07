/**
 * The read-only Preview a markdown file tab offers when Document view is
 * refused (VC-307).
 *
 * Document view is an editable Monaco projection over the file's own bytes, so
 * it must refuse constructs it cannot honestly draw — raw HTML blocks, YAML
 * frontmatter — and this repository's own README hits both. That refusal is
 * right and stays. What it left behind was a readable file with no way to read
 * it, and this surface is that way: a rendering, never an editor. Source
 * remains the place bytes are changed, and switching here writes nothing.
 *
 * ## Why it is allowed to render HTML at all
 *
 * Because it can only ever show. The danger in a file preview is not the markup
 * a person wrote; it is that the file came from a pull request, or from an
 * agent working in this very worktree, and opening it must not be an execution.
 * So the same bytes are judged twice before they are drawn:
 *
 *  1. `markdown-preview-source.ts` refuses whole HTML blocks that are not
 *     plainly inert, replacing each with a visible `HTML block not rendered`
 *     marker rather than dropping it quietly.
 *  2. The CHAT renderer's sanitization chain (`chatRehypePlugins`) parses and
 *     cleans everything that survives — the same `rehype-raw` →
 *     `rehype-sanitize` → `rehype-harden` chain the transcript trusts, taken
 *     whole rather than re-derived here.
 *
 * The chat COMPONENTS are not taken whole, and the exception is the point: the
 * chat `img` resolves Blob attachments and correctly refuses ordinary
 * repository paths, which in a file preview would blank out exactly the
 * pictures a README is made of. Preview brings its own image path instead
 * (`markdown-preview-image.ts`), reading through main's worktree-aware, path-safe
 * reader and displaying only the `data:` URL that comes back. It fetches
 * nothing.
 *
 * ## What it shows of the file
 *
 * The bytes the tab last read or saved, not the live Source draft. Preview is a
 * picture of the file; the draft belongs to the editor that holds it, and is
 * still there when the person switches back (`file-view.tsx` says so in the
 * band while it is dirty). Rendering an unsaved buffer would mean a read-only
 * surface tracking an editor's state, which is how a "preview" starts owning
 * content it cannot save.
 */
import * as React from "react";
import { Streamdown, type Components } from "streamdown";

import {
  chatMarkdownComponents,
  sanitizedRehypePlugins,
} from "@renderer/components/ui/ai-elements/chat-markdown";
import {
  parsePreviewImageSrc,
  previewImageDisplay,
  previewImageNotice,
  type PreviewImageDisplay,
} from "@renderer/editor/markdown-preview-image";
import { previewImageRehypePlugin } from "@renderer/editor/markdown-preview-rehype";
import { OMITTED_HTML_NOTICE, previewSegments } from "@renderer/editor/markdown-preview-source";
import { cn } from "@renderer/lib/utils";

/** Which file's directory an image resolves against, and which checkout it is read from. */
interface PreviewFile {
  projectId: string;
  ticketId: string | undefined;
  relPath: string;
}

/*
 * Context rather than a prop, for the reason `chat-markdown.tsx` uses one:
 * Streamdown builds the element tree itself, so there is no path from this
 * component to the `img` it eventually renders.
 */
const PreviewFileContext = React.createContext<PreviewFile | null>(null);

export interface MarkdownPreviewProps {
  projectId: string;
  /** Present in a ticket workspace, so repository paths resolve to its worktree copy. */
  ticketId?: string;
  /** The markdown file's own project-relative path — what relative images resolve against. */
  relPath: string;
  /** The bytes to render. Read-only: this component has no way to write them back. */
  text: string;
}

export function MarkdownPreview({ projectId, ticketId, relPath, text }: MarkdownPreviewProps) {
  const segments = React.useMemo(() => previewSegments(text), [text]);
  const rehypePlugins = React.useMemo(
    () => sanitizedRehypePlugins([previewImageRehypePlugin(relPath)]),
    [relPath],
  );
  const file = React.useMemo<PreviewFile>(
    () => ({ projectId, ticketId, relPath }),
    [projectId, ticketId, relPath],
  );

  return (
    <PreviewFileContext.Provider value={file}>
      <div
        data-testid="markdown-preview"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto text-sm leading-prose [scrollbar-gutter:stable]"
      >
        {segments.map((segment, index) =>
          segment.kind === "markdown" ? (
            <Streamdown
              // Position IS the identity here: the segments are a pure function
              // of the text, and a re-render with different text replaces the
              // whole list rather than reordering it.
              key={`markdown-${String(index)}`}
              rehypePlugins={rehypePlugins}
              components={PREVIEW_COMPONENTS}
              className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            >
              {segment.text}
            </Streamdown>
          ) : (
            <OmittedHtmlBlock key={`omitted-${String(index)}`} line={segment.line} />
          ),
        )}
      </div>
    </PreviewFileContext.Provider>
  );
}

/**
 * The chat overrides, minus the two that are wrong for a file.
 *
 * `img` becomes the repository resolver below. `inlineCode` — the chat's
 * file-mention heuristic — goes back to Streamdown's own inline code, because
 * its dotted underline announces a click target, and in a preview there is
 * nothing to click: this surface opens no files.
 */
const {
  inlineCode: _chatFileMention,
  img: _chatAttachmentImage,
  ...sharedComponents
} = chatMarkdownComponents;

const PREVIEW_COMPONENTS: Components = {
  ...sharedComponents,
  img: ({ className, src, alt }) => (
    <PreviewImage src={typeof src === "string" ? src : undefined} alt={alt} className={className} />
  ),
};

/**
 * One image in a previewed file.
 *
 * The `src` it receives has already been through the preview's rehype pass, so
 * it is either inert bytes the page may carry or a verdict that pass minted —
 * a repository path to ask main for, or a refusal to draw a sentence for. This
 * component adds no policy of its own; it does the asking and the drawing.
 */
function PreviewImage({
  src,
  alt,
  className,
}: {
  src?: string | undefined;
  alt?: string | undefined;
  className?: string | undefined;
}) {
  const file = React.useContext(PreviewFileContext);
  const source = parsePreviewImageSrc(src);
  const relPath = source.kind === "repo-file" ? source.relPath : null;
  const [display, setDisplay] = React.useState<PreviewImageDisplay | null>(null);

  React.useEffect(() => {
    if (file === null || relPath === null) return;
    let live = true;
    setDisplay(null);
    void (async () => {
      try {
        const result = await window.api.files.read({
          projectId: file.projectId,
          ticketId: file.ticketId,
          relPath,
        });
        if (!live) return;
        setDisplay(
          result.ok
            ? previewImageDisplay({ relPath, content: result.content })
            : // The read's own error names a path and an errno; a page of prose
              // wants the one fact a reader can act on, which is that the
              // picture is not there.
              { kind: "notice", notice: previewImageNotice("unresolved") },
        );
      } catch {
        if (live) setDisplay({ kind: "notice", notice: previewImageNotice("unresolved") });
      }
    })();
    return () => {
      live = false;
    };
  }, [file, relPath]);

  if (source.kind === "inline")
    return <PreviewImageElement src={source.src} alt={alt} className={className} />;
  if (source.kind !== "repo-file") {
    return <PreviewImageNotice notice={previewImageNotice(source.kind)} alt={alt} />;
  }
  // Nothing yet: the read is in flight. A spinner for a picture that is usually
  // already in main's page cache would be more motion than information.
  if (display === null) return null;
  if (display.kind === "notice") return <PreviewImageNotice notice={display.notice} alt={alt} />;
  return <PreviewImageElement src={display.src} alt={alt} className={className} />;
}

function PreviewImageElement({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <img
      className={cn("my-2 max-h-96 max-w-full rounded-md border border-border", className)}
      src={src}
      alt={alt ?? ""}
      loading="lazy"
    />
  );
}

/**
 * The sentence drawn where a picture is not. Same shape as the chat's refused
 * image (`attachments/markdown-image.tsx`): the reason, then the author's own
 * alt text, so a reader learns both what was meant and why it is missing.
 */
function PreviewImageNotice({ notice, alt }: { notice: string; alt?: string | undefined }) {
  const description = (alt ?? "").trim();
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-muted px-2 py-1 text-ui text-muted-foreground">
      <span>{notice}</span>
      {description === "" ? null : <span className="truncate italic">— {description}</span>}
    </span>
  );
}

/** Where a raw HTML block was left out, and which line of the file to look at for it. */
function OmittedHtmlBlock({ line }: { line: number }) {
  return (
    <p
      data-testid="preview-omitted-html"
      className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-ui text-muted-foreground"
    >
      {OMITTED_HTML_NOTICE} <span className="tabular-nums">(line {line})</span>
    </p>
  );
}
