import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  output: "static",
  site: "https://volli.app",
  // The sitemap is generated from the route list rather than hand-written, so
  // a new page cannot ship unlisted. `public/robots.txt` points crawlers at it.
  integrations: [react(), sitemap()],
  vite: {
    build: {
      rollupOptions: {
        output: {
          // KEEP LEGAL COMMENTS (VC-409). GSAP ships under the GreenSock
          // Standard "no charge" license, whose section III.3 forbids removing
          // or altering its proprietary notices — and every GSAP ES module we
          // bundle (gsap-core, CSSPlugin, Flip, matrix) opens with a `/*!`
          // banner naming the copyright holder and linking the license terms.
          //
          // The production build was dropping all four. Rolldown documents
          // `comments.legal` as defaulting to true, but the default this
          // pipeline actually arrives at strips them, so it is stated here
          // rather than assumed. Verified by building and reading dist/: four
          // banners before this line existed, zero; after it, four.
          //
          // `scripts/check-bundled-license-notices.mjs` runs at the end of
          // `pnpm build` and fails the build if a banner disappears again, so
          // this option cannot regress silently on a toolchain bump.
          comments: { legal: true },
        },
      },
    },
  },
});
