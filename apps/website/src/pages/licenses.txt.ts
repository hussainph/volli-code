import type { APIRoute } from "astro";

import { collectFontNotices, renderFontNoticeDocument } from "../lib/font-notices";

/*
 * /licenses.txt — the OFL notices for the fonts this site redistributes.
 *
 * The build emits Mona Sans .woff2 files into `dist/_astro/`, and OFL-1.1 only
 * permits that when the copyright notice and license text travel with them.
 * This route is how they travel: it is part of the Astro build itself, so the
 * notice is emitted by the same run that emits the fonts and cannot be skipped
 * by a deploy that forgot a step. The footer links it so a reader can find it
 * without knowing the path.
 *
 * The body is read from the installed font package — see `lib/font-notices.ts`.
 */
export const GET: APIRoute = () => {
  const body = renderFontNoticeDocument(collectFontNotices(), {
    siteName: "volli.app",
    projectLicenseUrl: "https://github.com/hussainph/volli-code/blob/main/LICENSE",
  });

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
