import type { APIRoute } from "astro";

import monaSansLicense from "@fontsource-variable/mona-sans/LICENSE?raw";
import monaSansManifest from "@fontsource-variable/mona-sans/package.json";
import {
  buildFontNotice,
  renderFontNoticeDocument,
  type FontPackageSource,
} from "@volli/font-notices";

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
 * The rendering lives in `@volli/font-notices`, shared with the docs site. What
 * belongs to THIS site is the list below: the fonts it self-hosts, imported
 * from the packages it declares, so the notice is built from the same bytes the
 * bundler is copying into `dist/`. Nothing is transcribed by hand — bumping the
 * font dependency rewrites the notice on the next build.
 *
 * A font added to this site must be added here too. If it is not,
 * `check-font-notices` fails the build rather than publishing the binary with
 * no attribution.
 */

// Astro prerenders endpoints under `output: "static"` anyway. Saying so out
// loud makes the compliance artifact's staticness a property of this file
// rather than of a config default: /licenses.txt has to exist as a FILE in
// `dist/`, because that is what the deploy uploads and what the gate reads.
export const prerender = true;

const REDISTRIBUTED_FONTS: readonly FontPackageSource[] = [
  {
    family: "Mona Sans",
    packageName: "@fontsource-variable/mona-sans",
    manifest: monaSansManifest,
    licenseText: monaSansLicense,
  },
];

export const GET: APIRoute = () => {
  const body = renderFontNoticeDocument(REDISTRIBUTED_FONTS.map(buildFontNotice), {
    siteName: "volli.app",
    projectLicenseUrl: "https://github.com/hussainph/volli-code/blob/main/LICENSE",
  });

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
