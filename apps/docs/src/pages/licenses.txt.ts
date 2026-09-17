import type { APIRoute } from "astro";

import { collectFontNotices, renderFontNoticeDocument } from "../lib/font-notices";

/*
 * /licenses.txt — the OFL notices for the fonts this site redistributes.
 *
 * Starlight's `customCss` pulls Mona Sans into the build, which emits its
 * .woff2 files into `dist/_astro/`, and OFL-1.1 only permits that when the
 * copyright notice and license text travel with them. This route is how they
 * travel: it is part of the Astro build itself, so the notice is emitted by the
 * same run that emits the fonts and cannot be skipped by a deploy that forgot a
 * step. The page footer links it, beside the plain-text docs link.
 *
 * The body is read from the installed font package — see `lib/font-notices.ts`.
 */
export const GET: APIRoute = () => {
  const body = renderFontNoticeDocument(collectFontNotices(), {
    siteName: "docs.volli.app",
    projectLicenseUrl: "https://github.com/hussainph/volli-code/blob/main/LICENSE",
  });

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
