import * as React from "react";
import DOMPurify, {
  type Config as DOMPurifyConfig,
  type UponSanitizeAttributeHookEvent,
  type UponSanitizeElementHookEvent,
} from "dompurify";
import { Marked } from "marked";
import { markdownImageNotice, parseBlobUrl, resolveMarkdownImageSrc } from "@volli/shared";
import { useBlobReader } from "@renderer/components/attachments/blob-read";

import { useMarkdownAttachments } from "@renderer/components/attachments/markdown-image";
import { chatSanitizerKeepsClass } from "@renderer/components/ui/ai-elements/chat-markdown";
import {
  allowsPreviewAttribute,
  PREVIEW_DROPPED_TAGS,
  PREVIEW_TAGS,
} from "@renderer/editor/markdown-preview-html";
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
 * The sanitizer's configuration: the file Preview's ALLOWLIST, not DOMPurify's
 * defaults (VC-839).
 *
 * A comment is written by any Session, so its body is whatever a prompt
 * injection in a repository file, a web page or an MCP result made it — and
 * DOMPurify's DEFAULT lists are written to stop script, not to keep one
 * fragment from styling or impersonating the page around it. They kept
 * `<style>`, `style=`, `<form action>` with its controls, `<dialog>`,
 * `popover*`, SVG and MathML trees, and whatever the next release adds; and
 * nothing around a comment contains a global sheet or a `position:fixed` box.
 *
 * So this renderer draws exactly what Preview draws, read from Preview's own
 * policy (`editor/markdown-preview-html.ts`) rather than copied:
 *
 *  - tags: {@link PREVIEW_TAGS}, Preview's list narrowed by chat's. Anything
 *    else is unwrapped, so its text still reads;
 *  - subtrees that go whole: {@link PREVIEW_DROPPED_TAGS} (`style`, `svg`,
 *    `video`, …), so no stylesheet or foreign markup is left loose as text;
 *  - attributes: {@link allowsPreviewAttribute} per element, in
 *    {@link keepAllowedAttribute}, which also narrows `class` and drops `id`.
 *
 * `data:` is admitted on `<img>` ONLY. The resolver has already narrowed data
 * URIs to `data:image/*`, so this is the second of two gates rather than the
 * only one; scoping it to the tag as well means a future caller cannot turn it
 * into a `data:text/html` link by reusing this config.
 */
const SANITIZE_CONFIG: DOMPurifyConfig = {
  ALLOWED_URI_REGEXP,
  ADD_DATA_URI_TAGS: ["img"],
  ALLOWED_TAGS: [...PREVIEW_TAGS],
  ADD_FORBID_CONTENTS: [...PREVIEW_DROPPED_TAGS],
};

/**
 * What this renderer's own `image` renderer (below) writes beyond Preview's
 * policy: the class of the notice an unrenderable image is drawn as, and
 * `loading="lazy"` on the images it does draw.
 */
const OWN_CLASS = { tag: "span", token: "typeset-image-missing" } as const;
const OWN_ATTRIBUTE = { tag: "img", name: "loading" } as const;

/**
 * DOMPurify reports attributes by their lowercase HTML name; Preview's policy
 * is written in hast's property names. The two differ only by case for the
 * multi-word names that policy admits, and by dash-to-camel for `aria-*` and
 * `data-*`.
 */
const HAST_PROPERTY_NAMES: Readonly<Record<string, string>> = {
  class: "className",
  colspan: "colSpan",
  rowspan: "rowSpan",
};

function hastPropertyName(attribute: string): string {
  const named = HAST_PROPERTY_NAMES[attribute];
  if (named !== undefined) return named;
  if (!/^(?:aria|data)-/.test(attribute)) return attribute;
  return attribute.replace(/-([a-z])/g, (_match: string, letter: string) => letter.toUpperCase());
}

/**
 * Keeps an attribute only where Preview's policy admits it for this element,
 * with two narrowings Preview gets elsewhere:
 *
 *  - `class` keeps only the tokens chat's sanitizer keeps on this tag
 *    (`language-*` on `code`, `task-list-item` on `li`, …) plus this
 *    renderer's own. Every utility in the app's stylesheet is otherwise one
 *    attribute away: `class="fixed inset-0 z-50 bg-background"` covers the
 *    whole window without a single `style`.
 *  - `id` goes. A comment shares the document with the app, so its ids would
 *    share the app's namespace; marked writes none.
 */
function keepAllowedAttribute(node: Element, event: UponSanitizeAttributeHookEvent): void {
  const tag = node.localName;
  const name = event.attrName;
  if (tag === OWN_ATTRIBUTE.tag && (name === OWN_ATTRIBUTE.name || name === "data-volli-blob"))
    return;
  if (name === "id" || !allowsPreviewAttribute(tag, hastPropertyName(name))) {
    event.keepAttr = false;
    return;
  }
  if (name !== "class") return;
  const kept = event.attrValue
    .split(/\s+/)
    .filter(
      (token) =>
        chatSanitizerKeepsClass(tag, token) || (tag === OWN_CLASS.tag && token === OWN_CLASS.token),
    );
  if (kept.length === 0) event.keepAttr = false;
  else event.attrValue = kept.join(" ");
}

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
 * This surface's own DOMPurify instance, so the hooks above cannot leak into
 * any other caller of the shared default one.
 *
 * Registered only where DOMPurify works at all: without a DOM (a Node-only
 * test importing this module through a component tree) the instance has
 * neither `addHook` nor `sanitize`, so rendering still throws rather than
 * passing markup through unsanitized.
 */
const purifier = DOMPurify();
if (purifier.isSupported) {
  purifier.addHook("uponSanitizeElement", keepOnlyTaskCheckboxes);
  purifier.addHook("uponSanitizeAttribute", keepAllowedAttribute);
}

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
  const reader = useBlobReader();
  const container = React.useRef<HTMLDivElement>(null);

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
            const hash = parseBlobUrl(resolution.src);
            const imageSource =
              reader !== null && hash !== null
                ? `data-volli-blob="${hash}"`
                : `src="${escapeHtml(resolution.src)}"`;
            return `<img ${imageSource} alt="${alt}" ${OWN_ATTRIBUTE.name}="lazy" />`;
          }
          // Drawn, not dropped: an image that silently vanishes is
          // indistinguishable from one nobody wrote. The alt text rides along
          // because it is usually the only description of what is missing.
          const notice = escapeHtml(markdownImageNotice(resolution) ?? "");
          const label = text.trim() === "" ? notice : `${notice} — ${alt}`;
          return `<span class="${OWN_CLASS.token}">${label}</span>`;
        },
      },
    });
    const raw = renderer.parse(source, { async: false, gfm: true });
    const sanitized = purifier.sanitize(raw, SANITIZE_CONFIG);
    if (reader === null) return sanitized;
    // Raw HTML images bypass marked's image renderer. Rewrite them while
    // still inert, before they could reach this Mac's local blob protocol.
    const fragment = document.createElement("template");
    fragment.innerHTML = sanitized;
    for (const image of fragment.content.querySelectorAll("img[src]")) {
      const hash = parseBlobUrl(image.getAttribute("src") ?? "");
      if (hash === null) continue;
      image.removeAttribute("src");
      image.setAttribute("data-volli-blob", hash);
    }
    return fragment.innerHTML;
  }, [source, byName, reader]);

  React.useEffect(() => {
    if (reader === null) return;
    let cancelled = false;
    const notices: HTMLElement[] = [];
    const cleanups: Array<() => void> = [];
    for (const image of container.current?.querySelectorAll<HTMLImageElement>(
      "img[data-volli-blob]",
    ) ?? []) {
      const hash = image.dataset.volliBlob;
      if (hash === undefined || !/^[a-f0-9]{64}$/.test(hash)) continue;
      image.removeAttribute("src");
      image.hidden = true;
      let failed = false;
      const fail = () => {
        if (cancelled || failed) return;
        failed = true;
        image.hidden = true;
        const notice = document.createElement("span");
        notice.className = OWN_CLASS.token;
        notice.textContent = `Image could not be loaded${image.alt ? ` — ${image.alt}` : ""}`;
        image.after(notice);
        notices.push(notice);
      };
      image.addEventListener("error", fail);
      cleanups.push(() => image.removeEventListener("error", fail));
      void reader(`volli-blob:${hash}`).then((src) => {
        if (!cancelled) {
          image.src = src;
          image.hidden = false;
        }
      }, fail);
    }
    return () => {
      cancelled = true;
      for (const notice of notices) notice.remove();
      for (const cleanup of cleanups) cleanup();
    };
  }, [html, reader]);

  return (
    <div
      ref={container}
      className={cn("typeset", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
