import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  loadPromptTemplates,
  parsePromptTemplateFile,
  readPromptTemplateDir,
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

  it("skips one unreadable file rather than failing the batch", async () => {
    const dir = makeCommandsDir({ "good.md": "fine" });
    // A symlink to nowhere is a dirent that claims to be a file and then
    // ENOENTs on read — the cheapest honest stand-in for an unreadable entry.
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
