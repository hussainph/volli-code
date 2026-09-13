import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  output: "static",
  site: "https://volli.app",
  // The sitemap is generated from the route list rather than hand-written, so
  // a new page cannot ship unlisted. `public/robots.txt` points crawlers at it.
  // The one exception is `/preview/`: proposal pages built for side-by-side
  // review (VC-217). They carry noindex themselves and stay out of the sitemap.
  integrations: [
    react(),
    sitemap({ filter: (page) => !new URL(page).pathname.startsWith("/preview/") }),
  ],
});
