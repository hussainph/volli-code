import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

/*
 * /llms.txt — the whole docs tree as one list, in the order the sidebar shows
 * it, with a link to each page's Markdown mirror.
 *
 * Volli's users point coding agents at things. This is the address you give an
 * agent when you want it to read the docs, and it's what cursor.com/docs links
 * from the foot of every page.
 *
 * The order below has to match the `sidebar` array in astro.config.mjs. A page
 * added there and not here is dropped from this listing, so the build fails
 * loudly rather than shipping a quietly incomplete index.
 */
const SECTIONS = [
  {
    label: "Get started",
    slugs: ["start/install", "start/quickstart", "start/concepts"],
  },
  {
    label: "Using Volli",
    slugs: ["guides/board", "guides/agents-and-worktrees", "guides/theming"],
  },
  {
    label: "Reference",
    slugs: [
      "reference/cli",
      "reference/keyboard-shortcuts",
      "reference/troubleshooting",
    ],
  },
];

export const GET: APIRoute = async ({ site }) => {
  const docs = await getCollection("docs");
  const byId = new Map(docs.map((entry) => [entry.id, entry]));
  const origin = site?.origin ?? "https://docs.volli.app";

  // "index" is the docs home, which titles this file rather than appearing in it.
  const listed = new Set(["index", ...SECTIONS.flatMap((s) => s.slugs)]);
  const missing = docs.map((entry) => entry.id).filter((id) => !listed.has(id));
  if (missing.length > 0) {
    throw new Error(
      `llms.txt is missing ${missing.join(", ")}. Add each page to SECTIONS in src/pages/llms.txt.ts.`
    );
  }

  const lines = ["# Volli Code"];

  const home = byId.get("index");
  if (home?.data.description) lines.push("", `> ${home.data.description}`);

  for (const section of SECTIONS) {
    lines.push("", `## ${section.label}`, "");
    for (const slug of section.slugs) {
      const entry = byId.get(slug);
      if (!entry) throw new Error(`llms.txt references a missing page: ${slug}`);
      const summary = entry.data.description ? `: ${entry.data.description}` : "";
      lines.push(`- [${entry.data.title}](${origin}/${slug}.md)${summary}`);
    }
  }

  return new Response(`${lines.join("\n")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
