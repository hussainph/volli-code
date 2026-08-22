import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  loadPromptTemplates,
  parsePromptTemplateFile,
  readPromptTemplateDir,
  writePromptTemplate,
} from "./prompt-templates";

const tempDirs: string[] = [];

function makeCommandsDir(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "volli-commands-test-"));
  tempDirs.push(root);
  const dir = join(root, "commands");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

/** A path inside a real temp root that deliberately does not exist. */
function missingDir(): string {
  const root = mkdtempSync(join(tmpdir(), "volli-commands-test-"));
  tempDirs.push(root);
  return join(root, "commands");
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("parsePromptTemplateFile", () => {
  it("splits a fenced frontmatter block from the body", () => {
    const parsed = parsePromptTemplateFile("---\ndescription: Review a file\n---\nReview $1.\n");

    expect(parsed.description).toBe("Review a file");
    expect(parsed.body).toBe("Review $1.");
  });

  it("treats a file with no fence as body only", () => {
    const parsed = parsePromptTemplateFile("Just the prompt.\n");

    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe("Just the prompt.\n");
  });

  it("treats an unterminated fence as body only", () => {
    const parsed = parsePromptTemplateFile("---\ndescription: dangling\nstill going");

    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe("---\ndescription: dangling\nstill going");
  });

  it("normalises CRLF so a Windows-authored file is not one long line", () => {
    const parsed = parsePromptTemplateFile(
      "---\r\ndescription: Win\r\n---\r\nLine one\r\nLine two",
    );

    expect(parsed.description).toBe("Win");
    expect(parsed.body).toBe("Line one\nLine two");
  });

  it("normalises a lone CR the same way", () => {
    const parsed = parsePromptTemplateFile("---\rdescription: Old mac\r---\rBody");

    expect(parsed.description).toBe("Old mac");
    expect(parsed.body).toBe("Body");
  });

  it("strips the block anyway when its YAML does not parse", () => {
    const parsed = parsePromptTemplateFile("---\ndescription: [unclosed\n---\nThe prompt.");

    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe("The prompt.");
  });

  it("reads other frontmatter keys without tripping over them", () => {
    const parsed = parsePromptTemplateFile("---\nmodel: fast\nargument-hint: <path>\n---\nBody");

    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe("Body");
  });

  it("survives frontmatter that parses to a scalar rather than a map", () => {
    const parsed = parsePromptTemplateFile("---\njust a string\n---\nBody");

    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe("Body");
  });
});

describe("readPromptTemplateDir", () => {
  it("loads every direct .md child, name-sorted", async () => {
    const dir = makeCommandsDir({
      "zeta.md": "Zeta body",
      "alpha.md": "Alpha body",
    });

    const result = await readPromptTemplateDir(dir);

    expect(result.ok).toBe(true);
    expect(result.ok && result.templates.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  });

  it("names a template after its basename and takes the body as content", async () => {
    const dir = makeCommandsDir({
      "review.md": "---\ndescription: Review a file\n---\nReview $1 carefully.",
    });

    const result = await readPromptTemplateDir(dir);

    expect(result.ok && result.templates[0]).toEqual({
      name: "review",
      description: "Review a file",
      content: "Review $1 carefully.",
    });
  });

  it("derives a description from the first body line when frontmatter has none", async () => {
    const dir = makeCommandsDir({ "ship.md": "\n\nShip the change.\nThen tell me." });

    const result = await readPromptTemplateDir(dir);

    expect(result.ok && result.templates[0]?.description).toBe("Ship the change.");
  });

  it("ignores files that are not markdown", async () => {
    const dir = makeCommandsDir({ "notes.txt": "not a command", "real.md": "a command" });

    const result = await readPromptTemplateDir(dir);

    expect(result.ok && result.templates.map((entry) => entry.name)).toEqual(["real"]);
  });

  it("accepts an uppercase extension", async () => {
    const dir = makeCommandsDir({ "SHOUT.MD": "loud" });

    const result = await readPromptTemplateDir(dir);

    expect(result.ok && result.templates.map((entry) => entry.name)).toEqual(["SHOUT"]);
  });

  it("does not descend into subdirectories — /name is a flat namespace", async () => {
    const dir = makeCommandsDir({ "top.md": "top" });
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.md"), "deep", "utf8");

    const result = await readPromptTemplateDir(dir);

    expect(result.ok && result.templates.map((entry) => entry.name)).toEqual(["top"]);
  });

  it("is an empty list — not an error — when the directory is absent", async () => {
    expect(await readPromptTemplateDir(missingDir())).toEqual({ ok: true, templates: [] });
  });

  it("is an empty list when the path is a file rather than a directory", async () => {
    const dir = makeCommandsDir({ "real.md": "x" });
    const notADir = join(dir, "real.md");

    expect(await readPromptTemplateDir(notADir)).toEqual({ ok: true, templates: [] });
  });

  it("reports a directory that exists but cannot be read", async () => {
    const dir = makeCommandsDir({ "real.md": "x" });
    chmodSync(dir, 0o000);
    try {
      const result = await readPromptTemplateDir(dir);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.length).toBeGreaterThan(0);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("follows a symlinked template — a shared command set is a real thing", async () => {
    const source = makeCommandsDir({ "shared.md": "Shared body" });
    const dir = makeCommandsDir({ "own.md": "Own body" });
    symlinkSync(join(source, "shared.md"), join(dir, "linked.md"));

    const result = await readPromptTemplateDir(dir);

    expect(result.ok && result.templates.map((entry) => entry.name)).toEqual(["linked", "own"]);
    expect(result.ok && result.templates[0]?.content).toBe("Shared body");
  });

  it("loses one broken link rather than failing the batch", async () => {
    const dir = makeCommandsDir({ "good.md": "fine" });
    symlinkSync(join(dir, "does-not-exist.md"), join(dir, "broken.md"));

    const result = await readPromptTemplateDir(dir);

    expect(result.ok && result.templates.map((entry) => entry.name)).toEqual(["good"]);
  });

  it("caps how many templates one directory contributes", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 205; index += 1) {
      files[`cmd-${String(index).padStart(3, "0")}.md`] = `body ${index}`;
    }
    const dir = makeCommandsDir(files);

    const result = await readPromptTemplateDir(dir);

    expect(result.ok && result.templates).toHaveLength(200);
  });
});

describe("loadPromptTemplates", () => {
  it("merges both tiers with the project winning a shared name", async () => {
    const projectCommandsDir = makeCommandsDir({ "review.md": "project body" });
    const globalCommandsDir = makeCommandsDir({ "review.md": "global body", "ship.md": "ship" });

    const result = await loadPromptTemplates({ projectCommandsDir, globalCommandsDir });

    expect(result.ok).toBe(true);
    expect(result.ok && result.templates.map((entry) => entry.name)).toEqual(["review", "ship"]);
    expect(result.ok && result.templates[0]?.content).toBe("project body");
  });

  it("is an empty list when neither directory exists", async () => {
    const result = await loadPromptTemplates({
      projectCommandsDir: missingDir(),
      globalCommandsDir: missingDir(),
    });

    expect(result).toEqual({ ok: true, templates: [] });
  });

  it("surfaces an unreadable project directory", async () => {
    const projectCommandsDir = makeCommandsDir({ "x.md": "x" });
    chmodSync(projectCommandsDir, 0o000);
    try {
      const result = await loadPromptTemplates({
        projectCommandsDir,
        globalCommandsDir: missingDir(),
      });
      expect(result.ok).toBe(false);
    } finally {
      chmodSync(projectCommandsDir, 0o700);
    }
  });

  it("surfaces an unreadable global directory", async () => {
    const globalCommandsDir = makeCommandsDir({ "x.md": "x" });
    chmodSync(globalCommandsDir, 0o000);
    try {
      const result = await loadPromptTemplates({
        projectCommandsDir: missingDir(),
        globalCommandsDir,
      });
      expect(result.ok).toBe(false);
    } finally {
      chmodSync(globalCommandsDir, 0o700);
    }
  });
});

describe("writePromptTemplate", () => {
  it("writes a file the reader offers back as a command", async () => {
    const dir = makeCommandsDir();

    const written = await writePromptTemplate({
      dir,
      name: "ship",
      description: "Open a PR",
      body: "Open a PR against main.",
    });

    expect(written).toEqual({ ok: true, path: join(dir, "ship.md") });
    const read = await readPromptTemplateDir(dir);
    expect(read).toEqual({
      ok: true,
      templates: [{ name: "ship", description: "Open a PR", content: "Open a PR against main." }],
    });
  });

  it("refuses a name already on disk rather than overwriting the prompt in it", async () => {
    const dir = makeCommandsDir({ "ship.md": "The prompt someone tuned by hand." });

    const written = await writePromptTemplate({
      dir,
      name: "ship",
      description: "Open a PR",
      body: "Something else entirely.",
    });

    expect(written.ok).toBe(false);
    // The file on disk is untouched — the whole point of refusing.
    const read = await readPromptTemplateDir(dir);
    expect(read).toEqual({
      ok: true,
      templates: [
        {
          name: "ship",
          description: "The prompt someone tuned by hand.",
          content: "The prompt someone tuned by hand.",
        },
      ],
    });
  });

  it("refuses a name that would escape the commands directory", async () => {
    const dir = makeCommandsDir();

    expect(
      await writePromptTemplate({ dir, name: "../escape", description: "", body: "hi" }),
    ).toEqual({
      ok: false,
      error: "Use letters, numbers, dashes and underscores — the name becomes the filename.",
    });
  });

  it("refuses an empty prompt — a command with no body invokes nothing", async () => {
    const dir = makeCommandsDir();

    expect(await writePromptTemplate({ dir, name: "ship", description: "x", body: "   " })).toEqual(
      {
        ok: false,
        error: "A command needs a prompt.",
      },
    );
  });

  it("escapes a description that would otherwise break its own frontmatter block", async () => {
    const dir = makeCommandsDir();

    await writePromptTemplate({
      dir,
      name: "ship",
      description: "Ship: fast, and\nmind the newline",
      body: "Go.",
    });

    const read = await readPromptTemplateDir(dir);
    expect(read).toEqual({
      ok: true,
      templates: [
        { name: "ship", description: "Ship: fast, and\nmind the newline", content: "Go." },
      ],
    });
  });

  it("creates the commands directory when the project has never had one", async () => {
    const dir = missingDir();

    expect(
      (await writePromptTemplate({ dir, name: "ship", description: "", body: "Go." })).ok,
    ).toBe(true);
    const read = await readPromptTemplateDir(dir);
    expect(read.ok && read.templates.map((t) => t.name)).toEqual(["ship"]);
  });

  /**
   * The reader trims the body only on its frontmatter branch
   * (`parsePromptTemplateFile` slices past the closing fence and trims); with
   * no fence it hands back the file verbatim, trailing newline included. That
   * is Pi's grammar, pinned by `prompt-template-parity.test.ts`, so the writer
   * bends around it rather than the reverse.
   *
   * Pinned because it is invisible until someone compares two commands: the
   * SAME prompt stores one way with a description and another way without.
   * Harmless in a prompt — and a trap for anyone who later asserts equality
   * between what was typed and what was stored.
   */
  it("round-trips the prompt exactly when a description fences it, and with the file's own newline when nothing does", async () => {
    const described = makeCommandsDir();
    const bare = makeCommandsDir();

    await writePromptTemplate({ dir: described, name: "a", description: "d", body: "Go." });
    await writePromptTemplate({ dir: bare, name: "a", description: "", body: "Go." });

    const withFence = await readPromptTemplateDir(described);
    const withoutFence = await readPromptTemplateDir(bare);
    expect(withFence.ok && withFence.templates[0]?.content).toBe("Go.");
    expect(withoutFence.ok && withoutFence.templates[0]?.content).toBe("Go.\n");
  });
});
