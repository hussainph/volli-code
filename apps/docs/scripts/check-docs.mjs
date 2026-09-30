import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://docs.volli.app";

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function checkLink(href, pageUrl, files) {
  const target = new URL(href.replaceAll("&amp;", "&"), pageUrl);
  if (target.origin !== origin) return null;
  const pathname = decodeURIComponent(target.pathname);
  const path = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const resolvedPath = files.has(path) ? path : `${path}/index.html`;
  const content = files.get(resolvedPath);
  if (content === undefined) return `missing target ${href}`;
  if (target.hash && resolvedPath.endsWith(".html")) {
    const id = decodeURIComponent(target.hash.slice(1));
    if (![...content.matchAll(/\bid="([^"]*)"/g)].some((match) => match[1] === id)) {
      return `missing anchor ${href}`;
    }
  }
  return null;
}

function selfTest() {
  const files = new Map([
    ["/index.html", '<h1 id="_top">Home</h1>'],
    ["/guides/example/index.html", '<h2 id="steps">Steps</h2>'],
    ["/guides/example.md", "# Example\n"],
    ["/licenses.txt", "Notices"],
  ]);
  const page = `${origin}/guides/example/`;
  assert.equal(checkLink("#steps", page, files), null);
  assert.equal(checkLink("/", page, files), null);
  assert.equal(checkLink("/guides/example.md", page, files), null);
  assert.equal(checkLink("/guides/example#steps", page, files), null);
  assert.equal(checkLink("/licenses.txt", page, files), null);
  assert.equal(checkLink("https://example.com/missing", page, files), null);
  assert.match(checkLink("/missing/", page, files), /missing target/);
  assert.match(checkLink("#missing", page, files), /missing anchor/);
  assert.match(checkLink("/guides/example#missing", page, files), /missing anchor/);
  console.log("Docs checker self-test passed.");
}

function checkBuild() {
  const dist = join(root, "dist");
  const files = new Map(
    walk(dist).map((path) => [
      `/${relative(dist, path).replaceAll("\\", "/")}`,
      path.endsWith(".html") || path.endsWith(".md") || path.endsWith(".txt")
        ? readFileSync(path, "utf8")
        : "",
    ]),
  );
  const problems = [];
  const pages = [...files].filter(([path]) => path.endsWith("/index.html"));
  const index = files.get("/llms.txt");
  assert.ok(index, "Build llms.txt before checking docs.");
  const indexed = [...index.matchAll(/\]\(https:\/\/docs\.volli\.app\/([^)]+\.md)\)/g)].map(
    (match) => `/${match[1]}`,
  );
  if (indexed.length !== new Set(indexed).size) problems.push("llms.txt has duplicate entries");

  for (const [path, html] of pages) {
    const route = path.slice(0, -"index.html".length);
    const url = `${origin}${route}`;
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";
    const levels = [...main.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
    if (levels.filter((level) => level === 1).length !== 1) {
      problems.push(`${route}: expected one H1 in main content`);
    }
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] > levels[i - 1] + 1) problems.push(`${route}: skipped heading level`);
    }
    for (const href of new Set([...html.matchAll(/\bhref="([^"]+)"/g)].map((match) => match[1]))) {
      const problem = checkLink(href, url, files);
      if (problem) problems.push(`${route}: ${problem}`);
    }
    const mirror = route === "/" ? "/index.md" : `${route.slice(0, -1)}.md`;
    const markdown = files.get(mirror);
    if (!markdown?.startsWith("# ")) problems.push(`${route}: missing Markdown mirror ${mirror}`);
    if (route !== "/" && !indexed.includes(mirror)) problems.push(`${route}: absent from llms.txt`);
    if (markdown && /<Agent(?:VerbEffects|ErrorRecovery|CapabilityChanges)\s*\/>/.test(markdown)) {
      problems.push(`${mirror}: unexpanded reference component`);
    }
    const source = html.match(/<copy-page\b[^>]*data-source="([^"]+)"/)?.[1];
    if (source !== mirror) problems.push(`${route}: Copy page points to ${source ?? "nothing"}`);
  }
  for (const mirror of indexed) {
    if (!files.has(mirror)) problems.push(`llms.txt: missing ${mirror}`);
  }
  const retainedFragments = {
    "/guides/board/": ["comments", "history", "archiving", "retention-and-archive-prompts"],
    "/guides/automations/": [
      "create-an-automation",
      "set-a-runtime",
      "run-an-automation-by-hand",
      "enable-and-arm-automatic-starts",
      "enable-an-automation",
      "arm-a-column",
      "what-starts-a-run",
      "choose-during-a-board-drag",
      "read-runs-and-skipped-occurrences",
    ],
    "/reference/cli/": ["volli-ticket-move", "volli-help", "volli-hook"],
  };
  for (const [route, fragments] of Object.entries(retainedFragments)) {
    for (const fragment of fragments) {
      const problem = checkLink(`${route}#${fragment}`, `${origin}/`, files);
      if (problem) problems.push(`Retained fragment: ${problem}`);
    }
  }
  for (const [path, text] of [
    ["/reference/command-effects.md", "### `ticket.move`"],
    ["/reference/cli-errors.md", "### `APP_UNREACHABLE`"],
    ["/reference/agent-capability-changes.md", "## VC-457"],
  ]) {
    if (!files.get(path)?.includes(text))
      problems.push(`${path}: generated reference content missing`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  console.log(
    `Docs checks passed: ${pages.length} pages, local links and anchors, retained fragments, heading hierarchy, Markdown mirrors, Copy page targets, and llms.txt.`,
  );
}

if (process.argv.includes("--self-test")) selfTest();
else checkBuild();
