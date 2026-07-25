import { describe, expect, it } from "vite-plus/test";
import type { TicketAttachment } from "@volli/shared";

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

  it("includes file attachments as referenced context via materialized paths", () => {
    const attachments: TicketAttachment[] = [
      {
        id: "a1",
        ticketId: "t1",
        kind: "file",
        label: "homepage mock",
        fileName: "spec.png",
        createdAt: 1,
      },
      {
        id: "a2",
        ticketId: "t1",
        kind: "url",
        label: "design",
        url: "https://example.com",
        createdAt: 2,
      },
    ];
    const nav = buildTicketFilesNavigator(input({ attachments }));
    expect(nav.referenced).toEqual([
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
        attachments: [
          {
            id: "a1",
            ticketId: "t1",
            kind: "file",
            label: "spec",
            fileName: "spec.png",
            createdAt: 1,
          },
        ],
      }),
    );
    expect(nav.referenced.map((r) => r.relPath)).toEqual([".volli/attachments/spec.png"]);
    expect(nav.referenced[0]?.source).toBe("attachment");
  });
});
