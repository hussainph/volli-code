import * as React from "react";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { Marked } from "marked";
import { markdownImageNotice, resolveMarkdownImageSrc } from "@volli/shared";

import { useMarkdownAttachments } from "@renderer/components/attachments/markdown-image";
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
 *
 * Images resolve through `@volli/shared`'s one policy (VC-273) rather than
 * being passed to the browser as written. Two things were wrong before, and
 * they compounded: nothing translated the `.volli/attachments/…` path an agent
 * writes into an address this renderer can load, and DOMPurify's DEFAULT
 * `ALLOWED_URI_REGEXP` silently deletes a `volli-blob:` or `data:` `src`
 * attribute outright — so the app's own durable image form was stripped on the
 * way through and every attachment on a Ticket rendered as a broken box. The
 * resolver runs first (in the `image` renderer below, so an unrenderable source
 * becomes a legible notice instead of a broken `<img>`), and the sanitizer is
 * then told about the one extra scheme the resolver can emit.
 */

/**
 * DOMPurify's default scheme allowlist plus `volli-blob:`.
 *
 * Copied from dompurify 3.4's `IS_ALLOWED_URI` with one scheme added rather
 * than loosened generally — every other clause is upstream's, so a URI this
 * accepts is one upstream accepts or is a Blob URL. Widening it to `volli-blob:`
 * is safe beyond images (it also reaches `href`) because the scheme serves
 * nothing but content-addressed bytes under `default-src 'none'` and
 * `X-Content-Type-Options: nosniff` (`blob-protocol.ts`): there is no script in
 * it to run and no path in it to traverse, since a hash is its whole address.
 */
export const ALLOWED_URI_REGEXP =
  // eslint-disable-next-line no-useless-escape -- kept byte-identical to dompurify's own IS_ALLOWED_URI, which carries the same disable.
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|volli-blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/**
 * `data:` is admitted on `<img>` ONLY.
 *
 * The resolver has already narrowed data URIs to `data:image/*`, so this is the
 * second of two gates rather than the only one; scoping it to the tag as well
 * means a future caller cannot turn it into a `data:text/html` link by reusing
 * this config.
 */
const SANITIZE_CONFIG: DOMPurifyConfig = {
  ALLOWED_URI_REGEXP,
  ADD_DATA_URI_TAGS: ["img"],
};

/** Escapes a string for interpolation into an HTML attribute or text node. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  // From context rather than a prop: this renders every comment in a feed, and
  // the surface that knows the attachments is the Ticket around it, not each
  // row. The provider memoizes the map on its content, so an unchanged set of
  // attachments keeps this memo's cached HTML.
  const byName = useMarkdownAttachments();

  const html = React.useMemo(() => {
    // A per-render instance rather than the module-level `marked`: the image
    // renderer closes over THIS surface's attachments, and mutating the shared
    // singleton would leak one Ticket's links into every other markdown block
    // on screen.
    const renderer = new Marked({
      renderer: {
        image({ href, text }) {
          const resolution = resolveMarkdownImageSrc(href, byName);
          const alt = escapeHtml(text);
          if (resolution.kind === "render") {
            return `<img src="${escapeHtml(resolution.src)}" alt="${alt}" loading="lazy" />`;
          }
          // Drawn, not dropped: an image that silently vanishes is
          // indistinguishable from one nobody wrote. The alt text rides along
          // because it is usually the only description of what is missing.
          const notice = escapeHtml(markdownImageNotice(resolution) ?? "");
          const label = text.trim() === "" ? notice : `${notice} — ${alt}`;
          return `<span class="typeset-image-missing">${label}</span>`;
        },
      },
    });
    const raw = renderer.parse(source, { async: false, gfm: true });
    return DOMPurify.sanitize(raw, SANITIZE_CONFIG);
  }, [source, byName]);

  return <div className={cn("typeset", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
