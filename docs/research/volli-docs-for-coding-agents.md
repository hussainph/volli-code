# Docs for coding agents: frontier study

> **Research date:** 2026-09-15
> **Scope:** Public developer-documentation affordances for AI coding agents; Volli's 14-page Astro Starlight site.
> **Method:** Read the repository's `llms.txt` route, Markdown route, `PageTitle.astro`, footer, config, robots/sitemap surfaces, and all 14 source pages; fetched the cited public URLs directly. `[observed]` means directly verified at the URL on the research date; `[interpretation]` is a recommendation or inference.

## 1. `/llms.txt` and `/llms-full.txt`

- [observed] The proposal at [llmstxt.org](https://llmstxt.org/) specifies a Markdown file at the site root or a subpath: required H1, optional blockquote summary, optional prose, then H2 sections containing lists of Markdown links and optional descriptions. A file covers its own URL subtree; the most-specific file wins.
- [observed] The proposal is deliberately an index, not necessarily a corpus dump: agents are expected to read the small guide and follow links to clean Markdown pages. It recommends `rel="alternate" type="text/markdown"` and `rel="describedby"` links (HTML or HTTP `Link` headers).
- [observed] The proposal distinguishes `llms.txt` (curated, agent-oriented map) from `sitemap.xml` (complete search-engine URL inventory) and says the former is primarily for on-demand inference, not a replacement for robots or a training feed.
- [observed] Anthropic's former docs URL redirects: [https://docs.anthropic.com/llms.txt](https://docs.anthropic.com/llms.txt) -> [https://platform.claude.com/llms.txt](https://platform.claude.com/llms.txt). It is a large, grouped index with Markdown links (including `/docs/...md`) and language coverage.
- [observed] [Vercel `/llms.txt`](https://vercel.com/llms.txt) is curated and unusually agent-specific: it explains when to use the index, links a docs sitemap, and links [Vercel `/docs/llms-full.txt`](https://vercel.com/docs/llms-full.txt) for the complete corpus.
- [observed] [Supabase `/llms.txt`](https://supabase.com/llms.txt) is a concise docs index, explicitly linking [its full corpus](https://supabase.com/llms-full.txt), language/SDK-specific indexes, OpenAPI, and its MCP endpoint.
- [observed] [Mintlify `/llms.txt`](https://www.mintlify.com/llms.txt) says every page has a `.md` twin (also `Accept: text/markdown`) and links both nested indexes and a full corpus. Mintlify documents automatic generation at [its llms.txt guide](https://www.mintlify.com/docs/ai/llmstxt).
- [interpretation] Links-only is the durable default: it keeps discovery cheap and lets an agent retrieve only relevant pages. A full file is useful as an explicitly named, cacheable convenience for a small or frequently mirrored corpus, but becomes stale, expensive, and hard to navigate as docs grow. Do not make the index itself a 14-page blob.
- [observed] The proposal reports thousands of adopters and describes the intended agent workflow; this is evidence of convention adoption, not a controlled study proving answer quality. No independent causal evidence that publishing `llms.txt` alone improves agent outcomes was found in the checked sources.

### What makes an index useful

- [interpretation] Put the product identity, audience, version/status, and one-sentence retrieval instruction near the top.
- [interpretation] Group links by task or product area, not by arbitrary filesystem order; retain short descriptions that distinguish similarly named pages.
- [interpretation] Link only to stable, public, clean representations. Do not include tracking-heavy URLs, duplicate language variants, or pages that agents cannot fetch.
- [interpretation] Keep the curated index small enough to read in one request. Use nested indexes for genuinely separate areas and reserve `Optional` for secondary context.
- [interpretation] A full corpus should be generated from the same source as page mirrors and should carry a predictable freshness/cache policy.
- [observed] No checked vendor page publishes telemetry proving that agents followed its `llms.txt`; Mintlify does publish aggregate agent/MCP analytics as a product capability, but that is not an independent efficacy study.

## 2. Markdown mirrors

- [observed] The practical pattern is the same path with `.md` appended/replaced: [Vercel page `.md`](https://vercel.com/docs/getting-started-with-vercel.md), [Supabase page `.md`](https://supabase.com/docs/guides/getting-started.md), and [Mintlify page `.md`](https://www.mintlify.com/docs/quickstart.md) return Markdown with useful frontmatter/metadata and content.
- [observed] Mintlify additionally documents content negotiation: `Accept: text/markdown`; the `.md` URL is the simpler fallback for agents and links in `llms.txt`.
- [observed] Vercel's Markdown includes `summary`, prerequisites, related links, an agent prompt, and a documentation graph link; this is richer than merely stripping HTML.
- [interpretation] Static Starlight should prefer deterministic `.md` routes over relying on headers that hosting/CDN layers may strip or cache incorrectly. Add `Link` metadata only as a discoverability bonus, not as the only path.

## 3. Docs MCP servers

- [observed] [Mintlify's MCP documentation](https://www.mintlify.com/docs/ai/model-context-protocol) describes a hosted `/mcp` server with search, virtual-document-filesystem retrieval, and feedback tools; it returns full pages as Markdown. `/.well-known/mcp` and `.json` advertise the endpoint, and server-card endpoints advertise tools/capabilities.
- [observed] [Supabase's index](https://supabase.com/llms.txt) publishes `https://mcp.supabase.com/mcp`, an OAuth-protected Streamable HTTP server for projects, schema, and queries.
- [observed] [Vercel's agent resources](https://vercel.com/docs/agent-resources/vercel-mcp.md) and [AI catalog](https://vercel.com/.well-known/ai-catalog.json) announce an OAuth MCP for account resources; the catalog also identifies machine-readable docs and a docs graph.
- [observed] [Context7's overview](https://context7.com/docs/overview) advertises its MCP as a cross-library, version-specific documentation retrieval service, installed/configured through the client's instructions rather than as a per-site docs endpoint.
- [observed] Anthropic's [MCP guide](https://code.claude.com/docs/en/mcp) explains how clients connect to remote HTTP, SSE, stdio, and WebSocket servers; it is a client guide, not evidence that Anthropic hosts a public Volli-like docs MCP.
- [interpretation] MCP is high value when docs are large, versioned, private, or frequently changing. For 14 static pages, hosting an MCP server would add auth, availability, protocol, and abuse surface without beating `.md` plus Pagefind. Revisit when users request an integration or the corpus becomes materially larger.

## 4. Copy-page and “open in an agent” affordances

- [observed] The current `PageTitle.astro` control fetches the page's `.md` route and writes it to the clipboard; it is hidden until JavaScript and Clipboard API support are present, and reports success/failure.
- [observed] Mintlify's MCP guide documents contextual-menu actions including copy MCP URL, copy install command, and direct “Connect to Cursor”/“Connect to VS Code” actions. Vercel's Markdown includes an explicit “Agent prompt” block and links agent resources.
- [interpretation] Best practice is progressive enhancement: a visible, ordinary “View Markdown”/“Copy page” link that works without JavaScript, plus copy with clear success feedback, and an agent-specific entry point explaining `.md`, `llms.txt`, and any MCP. Avoid an “AI” button that hides the stable URL.

## 5. Agent-discoverable conventions

- [observed] [llmstxt.org](https://llmstxt.org/) recommends alternate/describedby link relations. [Mintlify's MCP guide](https://www.mintlify.com/docs/ai/model-context-protocol) demonstrates `/.well-known/mcp` discovery and server cards. [Vercel's AI catalog](https://vercel.com/.well-known/ai-catalog.json) is a product-specific catalog of Markdown, OpenAPI, graph, and MCP resources.
- [observed] Anthropic's [robots.txt](https://platform.claude.com/robots.txt) permits general crawling, disallows `/api/`, and lists two sitemaps. Volli's deployed [robots.txt](https://docs.volli.app/robots.txt) lists the sitemap and currently includes Cloudflare Content-Signal directives (`search=yes, ai-train=no, use=reference`) plus bot disallows.
- [observed] Volli's deployed [sitemap index](https://docs.volli.app/sitemap-index.xml) points to `sitemap-0.xml`; it is separate from `llms.txt`, as the convention expects. Structured metadata is emitted by Starlight plus custom Open Graph tags in `apps/docs/astro.config.mjs`, but no agent-specific JSON catalog was observed.
- [interpretation] The highest-return convention set for Volli is: accurate robots/sitemap policy, root `llms.txt`, linked `.md` mirrors, and a short curated “For agents” page. JSON-LD/OG tags help general discovery but should not be mistaken for an agent content API.

## 6. Comparison with Volli today

[observed] `apps/docs/src/pages/llms.txt.ts` generates a valid small index from the content collection, uses descriptions, orders 14 pages by sidebar, links directly to `.md`, and fails the build if a page is omitted. `apps/docs/src/pages/[...slug].md.ts` serves every page as `text/markdown`; it strips leading MDX imports but leaves component tags. `PageTitle.astro` copies that source. The footer links `/llms.txt`.

| Affordance | Who ships it (URL) | Volli status | Recommendation | Effort |
|---|---|---|---|---|
| Curated `llms.txt` | [Vercel](https://vercel.com/llms.txt), [Supabase](https://supabase.com/llms.txt) | Present; generated and completeness-checked | Add explicit usage guidance and stable “full corpus” decision | S |
| Full corpus `llms-full.txt` | [Vercel](https://vercel.com/docs/llms-full.txt), [Supabase](https://supabase.com/llms-full.txt) | Missing | Add generated full corpus only if consumers request bulk ingestion; otherwise defer | M |
| Per-page `.md` | [Vercel](https://vercel.com/docs/getting-started-with-vercel.md), [Mintlify](https://www.mintlify.com/docs/quickstart.md) | Present | Preserve; normalize component tags or document that they are source-like MDX | S/M |
| Copy/view Markdown | [Mintlify](https://www.mintlify.com/docs/ai/model-context-protocol) | Copy present; no no-JS view link | Add a plain “View Markdown” link beside Copy | S |
| Markdown alternate relation | [llmstxt.org](https://llmstxt.org/) | Not observed in `PageTitle`/config | Add `<link rel="alternate">` and `rel="describedby"` in Starlight head | S |
| Agent landing/skill prompt | [Vercel agent resources](https://vercel.com/docs/agent-resources.md) | Missing | Add a small “For agents” page with retrieval recipe and safety/version notes | S |
| Docs MCP/discovery | [Mintlify](https://www.mintlify.com/docs/ai/model-context-protocol) | Missing | Defer; publish only when a real search/version/auth need exists | L |
| `/.well-known` catalog | [Vercel](https://vercel.com/.well-known/ai-catalog.json), [Mintlify](https://www.mintlify.com/docs/ai/model-context-protocol) | Missing | Optional static catalog after core links are stable | M |

### Specific weaknesses in the current mirrors

- [observed] The Markdown route prepends title/description but does not include authored frontmatter, canonical URL, last-updated data, or version metadata.
- [observed] It removes only leading imports; Starlight component tags such as `<Aside>`, `<Steps>`, and `<CardGrid>` remain in the response.
- [interpretation] This is acceptable source-like Markdown for a small site, but a normalized agent representation would preserve the information in callouts and lists without requiring an MDX-aware parser.
- [observed] The generated index links descriptions but does not tell a client whether `.md` is a mirror, whether the docs are versioned, or which page is the best starting point for a task.
- [interpretation] The existing build-time missing-page failure is a strong foundation and should remain the single source of truth rather than introducing a hand-maintained second index.
- [observed] The footer link says “All docs as plain text,” while the actual resource is an index of Markdown links; that wording may lead an agent to expect the full corpus.
- [interpretation] Rename it to “Docs for agents” or “Documentation index” and reserve “all docs” for a real full-corpus endpoint.

## Evidence limits and unreachable sources

- [observed] All requested primary URLs returned content during this run, including the redirects from the old Anthropic docs host and the old Mintlify host.
- [observed] The Anthropic result was read at `platform.claude.com`, and the MCP result at `code.claude.com`; those redirects are material when documenting canonical URLs.
- [observed] Vercel's fetched page metadata contained a future-looking `last_updated` value; this study treats the fetched content as evidence of the served format, not as a claim about its editorial date.
- [interpretation] Search-result snippets were not used as evidence where a direct page fetch was available.
- [observed] No fetched source established a universal “open in agent” URL scheme beyond ordinary Markdown links and MCP setup links.
- [interpretation] Avoid vendor-specific deep links until a target client documents a stable protocol and fallback behavior.
- [observed] No fetched source showed a static site turning Pagefind itself into an MCP endpoint; Pagefind remains a browser/search index, not a remote agent protocol.
- [interpretation] Volli can therefore get most near-term value without changing its search implementation.
- [observed] The deployed Volli robots policy explicitly separates search permission from AI training and reference use.
- [interpretation] Any future policy change should be deliberate and documented alongside the agent landing page.

## Final prioritized recommendations

1. **S — Make Markdown visibly addressable.** Add a no-JavaScript “View Markdown” link and retain Copy page; have both use the canonical `/slug.md`. Touch `apps/docs/src/components/PageTitle.astro`; verify all 15 routes and `text/markdown` responses. Caveat: absolute/base URLs and CDN caching must preserve `.md` routes.
2. **S — Add standards-based discovery links.** Emit per-page `alternate` Markdown and `describedby` `/llms.txt` links from `apps/docs/astro.config.mjs`/a small head component. Caveat: ensure Starlight's generated canonical URLs and trailing-slash mapping are not duplicated.
3. **S — Add an agent landing page.** Create `apps/docs/src/content/docs/reference/for-agents.mdx`, link it from `llms.txt` and the footer, and explain when to fetch the index, page Markdown, CLI reference, and version/date caveats. Caveat: the existing completeness guard means the new page must be added to `SECTIONS`.
4. **M — Generate `llms-full.txt` only on demonstrated demand.** Add `apps/docs/src/pages/llms-full.txt.ts` from the same collection and source normalization as `.md`. Caveat: full-corpus responses need explicit cache headers/size monitoring and must not silently diverge from page mirrors.
5. **M/L — Add a static agent catalog, not MCP yet.** If users need one-click discovery, publish `public/.well-known/ai-catalog.json` linking `llms.txt`, sitemap, Markdown convention, and the agent page. Defer MCP until search/version/auth requirements justify a hosted service; static Astro cannot safely provide a stateful remote MCP endpoint.
