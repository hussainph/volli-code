import { getCollection } from "astro:content";
import type { APIRoute, GetStaticPaths } from "astro";

/*
 * A plain-Markdown mirror of every docs page, at /<slug>.md.
 *
 * Two readers want this. The "Copy page" control in PageTitle.astro fetches it
 * so a page pasted into an agent arrives as its source rather than as scraped
 * DOM. And the agents Volli runs can read a page directly without a Markdown
 * extractor in front of it, which matters for a product whose users are mostly
 * driving coding agents.
 *
 * The body is served as authored apart from its leading `import` block, which
 * only ever names Starlight components and means nothing outside a build. The
 * component tags themselves stay: stripping them would leave holes where the
 * tabs and callouts were, and a reader can follow `<Tabs>` more easily than it
 * can follow a gap.
 */

/** Drops the MDX `import` statements at the top of a page body. */
function stripLeadingImports(body: string): string {
  return body.replace(/^(?:import\s[^\n]*\n|\s*\n)*/, "");
}
export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection("docs");
  return docs.map((entry) => ({ params: { slug: entry.id || undefined } }));
};

export const GET: APIRoute = async ({ params }) => {
  const docs = await getCollection("docs");
  const entry = docs.find((doc) => (doc.id || undefined) === params.slug);

  if (!entry) {
    return new Response("Not found", { status: 404 });
  }

  const { title, description } = entry.data;
  const heading = description ? `# ${title}\n\n> ${description}\n` : `# ${title}\n`;

  return new Response(`${heading}\n${stripLeadingImports(entry.body ?? "")}`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
