import { describe, expect, it } from "vite-plus/test";

import {
  detectDocumentLanguage,
  documentIdentityKey,
  documentUri,
  fileDocumentIdentity,
  type DocumentIdentity,
} from "./document-identity";

const mainFile: DocumentIdentity = {
  kind: "file",
  projectId: "project-1",
  checkout: { kind: "main" },
  relPath: "src/index.ts",
};

describe("documentUri", () => {
  it("is deterministic and keeps the relative-path extension visible to language services", () => {
    expect(documentUri(mainFile)).toBe(documentUri({ ...mainFile }));
    expect(documentUri(mainFile)).toMatch(/^volli-document:\/\/file\//);
    expect(documentUri(mainFile)).toMatch(/\/src\/index\.ts$/);
    expect(documentIdentityKey(mainFile)).toBe(documentUri(mainFile));
  });

  it("separates Main-checkout and ticket-worktree copies of the same path", () => {
    const ticketFile: DocumentIdentity = {
      ...mainFile,
      checkout: { kind: "ticket", ticketId: "ticket-1" },
    };
    expect(documentUri(ticketFile)).not.toBe(documentUri(mainFile));
  });

  it("shares one identity for multiple views of the same logical ticket file", () => {
    const first: DocumentIdentity = {
      kind: "file",
      projectId: "project-1",
      checkout: { kind: "ticket", ticketId: "ticket-1" },
      relPath: "src/index.ts",
    };
    const second: DocumentIdentity = {
      kind: "file",
      projectId: "project-1",
      checkout: { kind: "ticket", ticketId: "ticket-1" },
      relPath: "src/index.ts",
    };
    expect(documentUri(first)).toBe(documentUri(second));
  });

  it("separates projects, ticket bodies, and immutable diff revisions", () => {
    expect(documentUri({ ...mainFile, projectId: "project-2" })).not.toBe(documentUri(mainFile));

    const bodyA: DocumentIdentity = {
      kind: "ticket-body",
      projectId: "project-1",
      ticketId: "ticket-1",
    };
    const bodyB: DocumentIdentity = { ...bodyA, ticketId: "ticket-2" };
    expect(documentUri(bodyA)).not.toBe(documentUri(bodyB));

    const baseA: DocumentIdentity = {
      kind: "diff-base",
      projectId: "project-1",
      ticketId: "ticket-1",
      baseRevision: "abc123",
      relPath: "src/index.ts",
    };
    const baseB: DocumentIdentity = { ...baseA, baseRevision: "def456" };
    expect(documentUri(baseA)).not.toBe(documentUri(baseB));
    expect(documentUri(baseA)).not.toBe(documentUri(mainFile));
  });

  it("encodes identity segments so separators inside record ids cannot collide", () => {
    const slashId: DocumentIdentity = {
      kind: "ticket-body",
      projectId: "project/one",
      ticketId: "ticket one",
    };
    const separateSegments: DocumentIdentity = {
      kind: "ticket-body",
      projectId: "project",
      ticketId: "one/ticket one",
    };
    expect(documentUri(slashId)).not.toBe(documentUri(separateSegments));
    expect(documentUri(slashId)).toContain("project%2Fone");
    expect(documentUri(slashId)).toContain("ticket%20one");
  });
});

describe("fileDocumentIdentity", () => {
  it("uses the resolved Main source even when the file was requested from a ticket", () => {
    const identity = fileDocumentIdentity({
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: ".volli/artifacts/plan.md",
      source: "main",
    });
    expect(identity).toEqual({
      kind: "file",
      projectId: "project-1",
      checkout: { kind: "main" },
      relPath: ".volli/artifacts/plan.md",
    });
  });

  it("shares a Main model across different ticket request contexts", () => {
    const first = fileDocumentIdentity({
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: "src/index.ts",
      source: "main",
    });
    const second = fileDocumentIdentity({
      projectId: "project-1",
      ticketId: "ticket-2",
      relPath: "src/index.ts",
      source: "main",
    });
    expect(documentUri(first)).toBe(documentUri(second));
  });

  it("uses the permanent ticket id only for a resolved worktree source", () => {
    const identity = fileDocumentIdentity({
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: "src/index.ts",
      source: "worktree",
    });
    expect(identity).toEqual({
      kind: "file",
      projectId: "project-1",
      checkout: { kind: "ticket", ticketId: "ticket-1" },
      relPath: "src/index.ts",
    });
    expect(documentUri(identity)).not.toBe(documentUri(mainFile));
  });

  it("rejects an impossible worktree source without a ticket identity", () => {
    expect(() =>
      fileDocumentIdentity({
        projectId: "project-1",
        relPath: "src/index.ts",
        source: "worktree",
      }),
    ).toThrow("ticket id");
  });
});

describe("detectDocumentLanguage", () => {
  it("selects Markdown for Ticket Bodies", () => {
    expect(
      detectDocumentLanguage({
        kind: "ticket-body",
        projectId: "project-1",
        ticketId: "ticket-1",
      }),
    ).toBe("markdown");
  });

  it.each([
    ["src/index.ts", "typescript"],
    ["src/Component.TSX", "typescript"],
    ["scripts/task.mjs", "javascript"],
    ["package.json", "json"],
    ["styles/app.scss", "scss"],
    ["templates/index.html", "html"],
    ["config/app.yaml", "yaml"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "makefile"],
    ["CMakeLists.txt", "cmake"],
  ])("selects %s as %s", (relPath, expected) => {
    expect(detectDocumentLanguage({ ...mainFile, relPath })).toBe(expected);
  });

  it("uses the diff path and falls back to plaintext for unknown files", () => {
    expect(
      detectDocumentLanguage({
        kind: "diff-base",
        projectId: "project-1",
        ticketId: "ticket-1",
        baseRevision: "abc123",
        relPath: "src/main.rs",
      }),
    ).toBe("rust");
    expect(detectDocumentLanguage({ ...mainFile, relPath: "fixtures/data.unknown" })).toBe(
      "plaintext",
    );
    expect(detectDocumentLanguage({ ...mainFile, relPath: "LICENSE" })).toBe("plaintext");
  });
});
