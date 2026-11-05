import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerPicker } from "./composer-picker-ui";

// Isolate the drawing from cmdk's DOM-only keyboard machinery.
vi.mock("@renderer/components/ui/ai-elements/prompt-input", () => ({
  PromptInputCommand: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PromptInputCommandEmpty: () => null,
  PromptInputCommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PromptInputCommandItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PromptInputCommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("composer picker glyphs", () => {
  it("gives files and authored artifacts distinct readable marks", () => {
    const html = renderToStaticMarkup(
      <ComposerPicker
        mode="file"
        active=""
        onActiveChange={vi.fn()}
        onSelect={vi.fn()}
        rows={[
          {
            kind: "file",
            value: "file",
            label: "file.ts",
            detail: "src/file.ts",
            relPath: "src/file.ts",
            artifact: false,
          },
          {
            kind: "file",
            value: "note",
            label: "note.md",
            detail: "note.md",
            relPath: "note.md",
            artifact: true,
          },
        ]}
      />,
    );
    // Icons may contain several paths (or other SVG shapes). Compare the
    // complete drawings, not the number of paths in the icon library.
    const marks = [...html.matchAll(/<svg\b[^>]*>([\s\S]*?)<\/svg>/g)].map((match) => match[1]);
    expect(marks).toHaveLength(2);
    expect(marks.every((mark) => mark.length > 0)).toBe(true);
    expect(new Set(marks).size).toBe(2);
    expect(html.match(/size-4 shrink-0 text-foreground/g)).toHaveLength(2);
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
  });
});
