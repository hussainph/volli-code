/**
 * The `<img>` a markdown renderer draws, and the attachments it resolves
 * against (VC-273).
 *
 * React-side counterpart to `@volli/shared`'s `resolveMarkdownImageSrc`: the
 * policy decision is pure and shared with the HTML pipeline in
 * `ticket/markdown.tsx`, and this module is only the drawing of it. The context
 * exists because the surface that KNOWS the attachments (a chat plane, a Ticket
 * detail) is nowhere near the component that renders one markdown node —
 * Streamdown builds the element tree itself and there is no prop to thread
 * through it.
 *
 * A refused image is drawn rather than dropped. An `<img>` whose source cannot
 * load renders as the browser's broken-image glyph beside the alt text, which
 * is exactly the failure this ticket started from and says nothing about why;
 * a notice naming the reason at least tells the author which of the two
 * problems they have.
 */
import * as React from "react";
import {
  attachmentHashesByName,
  markdownImageNotice,
  resolveMarkdownImageSrc,
  type NamedBlobLink,
} from "@volli/shared";

import { cn } from "@renderer/lib/utils";

const EMPTY: ReadonlyMap<string, string> = new Map();

const MarkdownAttachmentsContext = React.createContext<ReadonlyMap<string, string>>(EMPTY);

/**
 * The materialized-name → Blob-hash map the surrounding surface supplies.
 *
 * Read by both markdown pipelines — the React one through {@link MarkdownImage}
 * and the HTML one in `ticket/markdown.tsx` — so a comment and a transcript
 * resolve the same path to the same picture. Empty outside a provider, which
 * simply means only canonical sources render.
 */
export function useMarkdownAttachments(): ReadonlyMap<string, string> {
  return React.useContext(MarkdownAttachmentsContext);
}

/**
 * Supplies the attachments markdown image sources resolve against.
 *
 * Memoized on the list's CONTENT rather than its identity: callers derive their
 * link list with a `.map()` and would otherwise hand every markdown block on
 * screen a new map — and a new context value — on every render.
 */
export function MarkdownAttachmentsProvider({
  attachments,
  children,
}: {
  attachments: readonly NamedBlobLink[] | undefined;
  children: React.ReactNode;
}) {
  const signature = (attachments ?? [])
    .map((link) => `${link.linkId}\u0000${link.blobHash}\u0000${link.originalName}`)
    .join("\n");
  const latest = React.useRef(attachments);
  latest.current = attachments;
  const value = React.useMemo(
    () => attachmentHashesByName(latest.current ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` is the content of `latest`.
    [signature],
  );
  return (
    <MarkdownAttachmentsContext.Provider value={value}>
      {children}
    </MarkdownAttachmentsContext.Provider>
  );
}

/** The notice a refused image shows in place of the picture. */
function MissingImage({ notice, alt }: { notice: string; alt: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-muted px-2 py-1 text-ui text-muted-foreground">
      <span>{notice}</span>
      {alt.trim() === "" ? null : <span className="truncate italic">— {alt}</span>}
    </span>
  );
}

export interface MarkdownImageProps {
  src?: string | undefined;
  alt?: string | undefined;
  className?: string | undefined;
}

/** One markdown image, resolved against the surrounding surface's attachments. */
export function MarkdownImage({ src, alt, className }: MarkdownImageProps) {
  const attachments = React.useContext(MarkdownAttachmentsContext);
  const resolution = resolveMarkdownImageSrc(src ?? "", attachments);
  const notice = markdownImageNotice(resolution);
  if (resolution.kind !== "render") {
    return <MissingImage notice={notice ?? "Image unavailable"} alt={alt ?? ""} />;
  }
  return (
    <img
      className={cn("my-2 max-h-80 max-w-full rounded-md border border-border", className)}
      src={resolution.src}
      alt={alt ?? ""}
      loading="lazy"
    />
  );
}
