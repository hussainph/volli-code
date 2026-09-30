import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import { DOC_SECTIONS } from "./src/data/navigation.ts";

export default defineConfig({
  output: "static",
  site: "https://docs.volli.app",
  // Generated from the route list rather than hand-written, so a new doc page
  // cannot ship unlisted. `public/robots.txt` points crawlers at it.
  integrations: [
    sitemap(),
    starlight({
      title: "Volli Docs",
      description:
        "Documentation for Volli, a local-first macOS workspace for parallel coding agents.",
      favicon: "/volli-icon-dark.png",
      // Starlight already emits og:title/type/url/description/site_name and
      // twitter:card=summary_large_image — but a large-image card with no image
      // renders as nothing, so these two complete it. One card for all pages:
      // the share is about the product, not the individual doc.
      // Regenerate with `pnpm -C apps/website run og`.
      head: [
        {
          tag: "meta",
          attrs: { property: "og:image", content: "https://docs.volli.app/og.png" },
        },
        {
          tag: "meta",
          attrs: { property: "og:image:width", content: "1200" },
        },
        {
          tag: "meta",
          attrs: { property: "og:image:height", content: "630" },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "Volli documentation",
          },
        },
        {
          tag: "meta",
          attrs: { name: "twitter:image", content: "https://docs.volli.app/og.png" },
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/hussainph/volli-code",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/hussainph/volli-code/edit/main/apps/docs/",
      },
      components: {
        // The header lockup and links, drawn like volli.app's header: the
        // mark and "Volli" (home to volli.app), "Docs", then GitHub and
        // Download as words rather than an icon row. Starlight's light/dark
        // select stays; volli.css gives both themes the brand palette.
        SiteTitle: "./src/components/SiteTitle.astro",
        SocialIcons: "./src/components/SocialIcons.astro",
        // Adds a "Copy page" control beside the title, and a link to /llms.txt
        // in the footer. Both exist because our readers paste these pages into
        // coding agents.
        PageTitle: "./src/components/PageTitle.astro",
        Footer: "./src/components/Footer.astro",
      },
      // The website's fonts, loaded the way it loads them (BRAND.md §5): Mona
      // Sans from its full variable file, so the width axis is there, and
      // Geist Mono for code. Every font here needs an entry in
      // src/pages/licenses.txt.ts, or `licenses:check` fails the build.
      customCss: [
        "@fontsource-variable/mona-sans/standard.css",
        "@fontsource-variable/mona-sans/standard-italic.css",
        "@fontsource-variable/geist-mono/wght.css",
        "./src/styles/volli.css",
      ],
      sidebar: DOC_SECTIONS,
    }),
  ],
});
