import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  attachmentFilePath,
  attachmentsRoot,
  importAttachmentFile,
  removeAttachmentFiles,
} from "./attachment-store";

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-attachment-store-test-"));
  root = attachmentsRoot(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("attachmentsRoot", () => {
  it("is <userDataPath>/attachments", () => {
    expect(attachmentsRoot("/Users/x/Library/Application Support/Volli")).toBe(
      "/Users/x/Library/Application Support/Volli/attachments",
    );
  });
});

describe("importAttachmentFile", () => {
  it("copies bytes into <root>/<id>/<fileName> and returns the stored path", () => {
    const sourcePath = join(dir, "source.pdf");
    writeFileSync(sourcePath, "spec contents");

    const storedPath = importAttachmentFile(root, "attach-1", sourcePath, "spec.pdf");

    expect(storedPath).toBe(join(root, "attach-1", "spec.pdf"));
    expect(existsSync(storedPath)).toBe(true);
    expect(readFileSync(storedPath, "utf8")).toBe("spec contents");
  });

  it("creates the id directory even when the root doesn't exist yet", () => {
    expect(existsSync(root)).toBe(false);
    const sourcePath = join(dir, "source.txt");
    writeFileSync(sourcePath, "hi");

    importAttachmentFile(root, "attach-2", sourcePath, "notes.txt");

    expect(existsSync(join(root, "attach-2", "notes.txt"))).toBe(true);
  });

  it("rejects a fileName containing a path separator", () => {
    const sourcePath = join(dir, "source.txt");
    writeFileSync(sourcePath, "hi");

    expect(() => importAttachmentFile(root, "attach-3", sourcePath, "sub/escape.txt")).toThrow();
  });

  it("rejects a fileName containing a .. traversal segment", () => {
    const sourcePath = join(dir, "source.txt");
    writeFileSync(sourcePath, "hi");

    expect(() => importAttachmentFile(root, "attach-4", sourcePath, "../../etc/passwd")).toThrow();
  });
});

describe("attachmentFilePath", () => {
  it("joins root/id/fileName without touching disk", () => {
    expect(attachmentFilePath(root, "attach-1", "spec.pdf")).toBe(
      join(root, "attach-1", "spec.pdf"),
    );
  });

  it("rejects an unsafe fileName", () => {
    expect(() => attachmentFilePath(root, "attach-1", "../escape.pdf")).toThrow();
  });
});

describe("removeAttachmentFiles", () => {
  it("removes the attachment's whole id directory", () => {
    const sourcePath = join(dir, "source.pdf");
    writeFileSync(sourcePath, "spec contents");
    importAttachmentFile(root, "attach-1", sourcePath, "spec.pdf");
    expect(existsSync(join(root, "attach-1"))).toBe(true);

    removeAttachmentFiles(root, "attach-1");

    expect(existsSync(join(root, "attach-1"))).toBe(false);
  });

  it("is idempotent for an attachment with no files", () => {
    expect(() => removeAttachmentFiles(root, "never-existed")).not.toThrow();
  });

  it("never touches a sibling attachment's directory", () => {
    const sourcePath = join(dir, "source.pdf");
    writeFileSync(sourcePath, "spec contents");
    importAttachmentFile(root, "attach-1", sourcePath, "spec.pdf");
    importAttachmentFile(root, "attach-2", sourcePath, "spec.pdf");

    removeAttachmentFiles(root, "attach-1");

    expect(existsSync(join(root, "attach-1"))).toBe(false);
    expect(existsSync(join(root, "attach-2", "spec.pdf"))).toBe(true);
  });
});
