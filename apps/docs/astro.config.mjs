import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  site: "https://docs.volli.app",
  // Generated from the route list rather than hand-written, so a new doc page
  // cannot ship unlisted. `public/robots.txt` points crawlers at it.
  integrations: [
    sitemap(),
    starlight({
      title: "Volli Code",
      description:
        "Documentation for Volli Code, a local-first macOS workspace for parallel coding agents.",
      logo: {
        src: "./src/assets/volli-icon-dark.png",
        alt: "Volli Code",
      },
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
            content: "Volli Code documentation",
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
        baseUrl:
          "https://github.com/hussainph/volli-code/edit/main/apps/docs/",
      },
      components: {
        // The site is dark-only, matching volli.app. (The app itself ships both
        // light and dark; the marketing site and these docs share one palette.)
        // Overriding ThemeSelect with an empty component removes the toggle;
        // volli.css pins the palette so a light-preferring visitor still gets
        // dark.
        ThemeSelect: "./src/components/ThemeSelect.astro",
        // Adds a "Copy page" control beside the title, and a link to /llms.txt
        // in the footer. Both exist because our readers paste these pages into
        // coding agents.
        PageTitle: "./src/components/PageTitle.astro",
        Footer: "./src/components/Footer.astro",
      },
      customCss: [
        "@fontsource-variable/mona-sans/wght.css",
        "./src/styles/volli.css",
      ],
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Install", slug: "start/install" },
            { label: "Quickstart", slug: "start/quickstart" },
            { label: "Concepts", slug: "start/concepts" },
          ],
        },
        {
          // Ordered by the path through the product: plan on the board, open a
          // task, understand chats and worktrees, then configure and theme.
          label: "Using Volli",
          items: [
            { label: "The board", slug: "guides/board" },
            { label: "Ticket workspace", slug: "guides/ticket-workspace" },
            { label: "Chats and worktrees", slug: "guides/agents-and-worktrees" },
            { label: "Settings", slug: "guides/settings" },
            { label: "Theming", slug: "guides/theming" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "reference/cli" },
            {
              label: "Agent capability changes",
              slug: "reference/agent-capability-changes",
            },
            { label: "Keyboard shortcuts", slug: "reference/keyboard-shortcuts" },
            { label: "Troubleshooting", slug: "reference/troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
