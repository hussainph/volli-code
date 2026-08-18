import { describe, expect, it } from "vite-plus/test";
import type { NamedBlobLink } from "@volli/shared";

import { buildTicketFilesNavigator, type TicketFilesNavigatorInput } from "./ticket-files-model";

function input(overrides: Partial<TicketFilesNavigatorInput> = {}): TicketFilesNavigatorInput {
  return {
    body: "",
    attachments: [],
    worktreeEntries: [],
    ...overrides,
  };
}

describe("buildTicketFilesNavigator", () => {
  it("parses @file refs from the Ticket Body into a referenced section", () => {
    const nav = buildTicketFilesNavigator(
      input({ body: "See @src/rail.tsx and @docs/plan.md for context." }),
    );
    expect(nav.referenced.map((r) => r.relPath)).toEqual(["docs/plan.md", "src/rail.tsx"]);
    expect(nav.referenced.every((r) => r.source === "body")).toBe(true);
  });

  it("includes every attachment as referenced context via its materialized path", () => {
    const attachments: NamedBlobLink[] = [
      { linkId: "a1", blobHash: "h1", label: "homepage mock", originalName: "spec.png" },
      { linkId: "a2", blobHash: "h2", label: "design", originalName: "design.pdf" },
    ];
    const nav = buildTicketFilesNavigator(input({ attachments }));
    expect(nav.referenced).toEqual([
      {
        relPath: ".volli/attachments/design.pdf",
        label: "design",
        source: "attachment",
      },
      {
        relPath: ".volli/attachments/spec.png",
        label: "homepage mock",
        source: "attachment",
      },
    ]);
  });

  it("lists worktree files as a compact flat list (not a nested tree)", () => {
    const nav = buildTicketFilesNavigator(
      input({
        worktreeEntries: [
          { relPath: "z.ts", kind: "file" },
          { relPath: "src/a.ts", kind: "file" },
          { relPath: "src", kind: "directory" },
        ],
      }),
    );
    expect(nav.worktree.map((e) => e.relPath)).toEqual(["src", "src/a.ts", "z.ts"]);
    expect(nav.worktree.find((e) => e.relPath === "src")?.kind).toBe("directory");
  });

  it("dedupes a body ref that already appears as an attachment", () => {
    const nav = buildTicketFilesNavigator(
      input({
        body: "See @.volli/attachments/spec.png",
        attachments: [{ linkId: "a1", blobHash: "h1", label: "spec", originalName: "spec.png" }],
      }),
    );
    expect(nav.referenced.map((r) => r.relPath)).toEqual([".volli/attachments/spec.png"]);
    expect(nav.referenced[0]?.source).toBe("attachment");
  });
});
