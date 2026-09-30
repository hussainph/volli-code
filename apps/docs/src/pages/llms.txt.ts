import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { DOC_SECTIONS } from "../data/navigation";

/*
 * /llms.txt — the whole docs tree as one list, in the order the sidebar shows
 * it, with a link to each page's Markdown mirror.
 *
 * Volli's users point coding agents at things. This is the address you give an
 * agent when you want it to read the docs, and it's what cursor.com/docs links
 * from the foot of every page.
 *
 * The sidebar and this index share one navigation definition. The build
 * rejects an unlisted page rather than publishing an incomplete index.
 */

export const GET: APIRoute = async ({ site }) => {
  const docs = await getCollection("docs");
  const byId = new Map(docs.map((entry) => [entry.id, entry]));
  const origin = site?.origin ?? "https://docs.volli.app";

  // "index" is the docs home, which titles this file rather than appearing in it.
  const listed = new Set([
    "index",
    ...DOC_SECTIONS.flatMap((s) => s.items.map((item) => item.slug)),
  ]);
  const missing = docs.map((entry) => entry.id).filter((id) => !listed.has(id));
  if (missing.length > 0) {
    throw new Error(
      `llms.txt is missing ${missing.join(", ")}. Add each page to src/data/navigation.ts.`,
    );
  }

  const lines = ["# Volli Code"];

  const home = byId.get("index");
  if (home?.data.description) lines.push("", `> ${home.data.description}`);

  for (const section of DOC_SECTIONS) {
    lines.push("", `## ${section.label}`, "");
    for (const { slug } of section.items) {
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
