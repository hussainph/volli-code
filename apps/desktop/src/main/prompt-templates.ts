/**
 * Reading prompt templates off disk — the `/command` picker's supply.
 *
 * Two directories, both plain `.md` files with optional YAML frontmatter:
 * the project's `.volli/commands/` and the global `<userData>/commands/`, the
 * project winning any name they both define ({@link mergePromptTemplates}).
 * The format is Pi's, deliberately — same frontmatter key, same
 * body-as-content rule, same first-line description fallback — so a file
 * written for `pi` works here unchanged. What is NOT Pi's is the reader: this
 * module owns it, because `@earendil-works/pi-agent-core` is the Agent
 * Runtime's dependency, not the desktop app's, and reaching through
 * `@volli/agent-runtime` for a directory walk would put a runtime import in a
 * path that has nothing to do with running an agent.
 *
 * **A missing directory is not a failure.** Most projects have no
 * `.volli/commands/`, and a picker that reported that on every open would be
 * reporting the normal case. Only a directory that exists and cannot be read
 * produces an error. A single unreadable or malformed file is skipped rather
 * than failing the batch, on the same principle the session ledger reads by:
 * one bad row must not cost you the other nine.
 *
 * Mirrors volli-fs.ts's shape — pure async helpers here, testable against real
 * temp dirs; the IPC handler that calls them lives beside the other file
 * channels.
 */
import { promises as fsp, type Dirent } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  errorMessage,
  mergePromptTemplates,
  promptTemplateDescription,
  type PromptTemplate,
} from "@volli/shared";

/**
 * How many `.md` files one directory may contribute. A commands directory is
 * hand-authored — a hundred is already more than anyone scrolls — and the cap
 * exists so a mistyped path at a repo root cannot turn a picker open into a
 * thousand-file read.
 */
const MAX_TEMPLATES_PER_DIR = 200;

/** The frontmatter fence, and the only key this format reads. */
const FRONTMATTER_FENCE = "---";

interface Frontmatter {
  readonly description: unknown;
  readonly body: string;
}

/**
 * Split `---`-fenced YAML frontmatter from the body.
 *
 * Pi's rules, kept verbatim so the same file parses the same way in both: no
 * leading fence (or no closing one) means the whole text is body, and CRLF is
 * normalised first so a Windows-authored file is not one long line.
 *
 * A frontmatter block whose YAML does not parse is stripped anyway rather than
 * left in the prompt. The alternative — treating the whole file as body —
 * would send a literal `---` header to the model, which is worse than losing a
 * description the author mistyped.
 */
export function parsePromptTemplateFile(raw: string): Frontmatter {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith(FRONTMATTER_FENCE))
    return { description: undefined, body: normalized };
  const endIndex = normalized.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
  if (endIndex === -1) return { description: undefined, body: normalized };
  const body = normalized.slice(endIndex + 4).trim();
  try {
    const frontmatter: unknown = parseYaml(normalized.slice(4, endIndex));
    const description =
      typeof frontmatter === "object" && frontmatter !== null
        ? (frontmatter as Record<string, unknown>)["description"]
        : undefined;
    return { description, body };
  } catch {
    return { description: undefined, body };
  }
}

/**
 * Every `.md` template directly inside `dir`, name-sorted.
 *
 * Non-recursive and `.md`-only, both of which are Pi's rules: a commands
 * directory is a flat namespace because `/name` is flat, and there is no
 * spelling of `/a/b`.
 */
export async function readPromptTemplateDir(
  dir: string,
): Promise<{ ok: true; templates: PromptTemplate[] } | { ok: false; error: string }> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // The directory simply not being there is the normal case, not a fault.
    if (isMissingPath(error)) return { ok: true, templates: [] };
    return { ok: false, error: errorMessage(error) };
  }

  // Symlinks count, which is Pi's rule too: a shared set of commands linked
  // into a project is a real thing people do, and a `readdir` dirent for a
  // symlink says `isSymbolicLink`, never `isFile`, however ordinary its target
  // is. `readFile` follows it; one that points at nothing fails the read below
  // and loses that row alone.
  const files = entries
    .filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".md"),
    )
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, MAX_TEMPLATES_PER_DIR);

  const templates: PromptTemplate[] = [];
  for (const name of files) {
    let raw: string;
    try {
      raw = await fsp.readFile(join(dir, name), "utf8");
    } catch {
      // One unreadable file loses one command, not the picker.
      continue;
    }
    const { description, body } = parsePromptTemplateFile(raw);
    templates.push({
      name: name.slice(0, -".md".length),
      description: promptTemplateDescription({ body, frontmatterDescription: description }),
      content: body,
    });
  }
  return { ok: true, templates };
}

/**
 * Both tiers, merged into the list the picker shows.
 *
 * The two reads are independent, so one unreadable tier is still an error —
 * a global directory you cannot read is a real fault and the composer says so
 * — but neither tier's absence is.
 */
export async function loadPromptTemplates(input: {
  projectCommandsDir: string;
  globalCommandsDir: string;
}): Promise<{ ok: true; templates: readonly PromptTemplate[] } | { ok: false; error: string }> {
  const [project, global] = await Promise.all([
    readPromptTemplateDir(input.projectCommandsDir),
    readPromptTemplateDir(input.globalCommandsDir),
  ]);
  if (!project.ok) return project;
  if (!global.ok) return global;
  return {
    ok: true,
    templates: mergePromptTemplates({ project: project.templates, global: global.templates }),
  };
}

/** ENOENT/ENOTDIR — the directory is absent, which this surface treats as empty. */
function isMissingPath(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
