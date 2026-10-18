import * as React from "react";
import DOMPurify, {
  type Config as DOMPurifyConfig,
  type UponSanitizeElementHookEvent,
} from "dompurify";
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
 * The sanitizer's configuration: DOMPurify's defaults, narrowed to what a
 * comment can carry without reaching outside its own box (VC-839).
 *
 * A comment is written by any Session, so its body is whatever a prompt
 * injection in a repository file, a web page or an MCP result made it — and
 * DOMPurify's DEFAULT allowlists are written to stop script, not to keep one
 * fragment from styling or impersonating the page around it. They keep:
 *
 *  - `<style>` and `style=`, which the renderer CSP's `style-src
 *    'unsafe-inline'` lets through, so one comment could blank the whole app
 *    (`*{display:none}`) or draw a `position:fixed` fake dialog over it;
 *  - `<form action method>` with `<input>`, `<button>`, `<textarea>`,
 *    `<select>`, whose GET submission is a navigation main hands to the
 *    person's browser — with what they typed in the query string;
 *  - `<dialog>` and the `popover*` attributes, which draw in the top layer
 *    above every other surface.
 *
 * None of these is anything markdown produces. Everything else in the default
 * lists stays, so the GFM marked emits and the inline HTML people write in
 * comments (`<details>`, `<kbd>`, `<sup>`) renders as before. The one input
 * markdown DOES produce, a task list's disabled checkbox, is kept by
 * {@link keepOnlyTaskCheckboxes}.
 *
 * `data:` is admitted on `<img>` ONLY. The resolver has already narrowed data
 * URIs to `data:image/*`, so this is the second of two gates rather than the
 * only one; scoping it to the tag as well means a future caller cannot turn it
 * into a `data:text/html` link by reusing this config.
 */
const SANITIZE_CONFIG: DOMPurifyConfig = {
  ALLOWED_URI_REGEXP,
  ADD_DATA_URI_TAGS: ["img"],
  FORBID_TAGS: ["style", "form", "button", "textarea", "select", "option", "dialog"],
  FORBID_ATTR: [
    "style",
    "action",
    "method",
    "formaction",
    "popover",
    "popovertarget",
    "popovertargetaction",
  ],
};

/**
 * Removes every `<input>` that is not a GFM task-list checkbox — `type=checkbox`
 * and `disabled`, the shape marked writes for `- [ ]` / `- [x]`. A text field
 * in a comment can only ever be asking a person to type something into it.
 */
function keepOnlyTaskCheckboxes(node: Node, event: UponSanitizeElementHookEvent): void {
  if (event.tagName !== "input" || !(node instanceof Element)) return;
  const taskCheckbox =
    node.getAttribute("type")?.toLowerCase() === "checkbox" && node.hasAttribute("disabled");
  if (!taskCheckbox) node.remove();
}

/**
 * This surface's own DOMPurify instance, so the hook above cannot leak into any
 * other caller of the shared default one.
 *
 * Registered only where DOMPurify works at all: without a DOM (a Node-only
 * test importing this module through a component tree) the instance has
 * neither `addHook` nor `sanitize`, so rendering still throws rather than
 * passing markup through unsanitized.
 */
const purifier = DOMPurify();
if (purifier.isSupported) purifier.addHook("uponSanitizeElement", keepOnlyTaskCheckboxes);

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
    return purifier.sanitize(raw, SANITIZE_CONFIG);
  }, [source, byName]);

  return <div className={cn("typeset", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
