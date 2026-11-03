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
    const paths = [...html.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(paths).size).toBe(2);
    expect(html.match(/size-4 shrink-0 text-foreground/g)).toHaveLength(2);
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
  });
});
