import { describe, expect, it, vi } from "vite-plus/test";

import {
  type FileDragEvent,
  type FilePasteEvent,
  fileAttachHandlers,
} from "@renderer/components/attachments/file-drop";

function file(name: string): File {
  return new File(["x"], name);
}

function dragEvent(files: readonly File[], types: readonly string[] = ["Files"]) {
  return {
    dataTransfer: { files, types },
    preventDefault: vi.fn<() => void>(),
    nativeEvent: { stopPropagation: vi.fn<() => void>() },
  } satisfies FileDragEvent;
}

function pasteEvent(files: readonly File[]) {
  return {
    clipboardData: { files },
    preventDefault: vi.fn<() => void>(),
    nativeEvent: { stopPropagation: vi.fn<() => void>() },
  } satisfies FilePasteEvent;
}

describe("fileAttachHandlers", () => {
  describe("drop", () => {
    it("hands every dropped file over, in order", () => {
      const onAttach = vi.fn();
      const event = dragEvent([file("a.png"), file("b.pdf")]);

      fileAttachHandlers(onAttach).onDropCapture(event);

      expect(onAttach).toHaveBeenCalledTimes(1);
      expect(onAttach.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual([
        "a.png",
        "b.pdf",
      ]);
    });

    it("stops the native event, so the vendored form listener never sees it", () => {
      const event = dragEvent([file("a.png")]);

      fileAttachHandlers(vi.fn()).onDropCapture(event);

      // The load-bearing pair: without these the drop reaches PromptInput's own
      // listener (or Monaco) and lands somewhere nobody is looking.
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(event.nativeEvent.stopPropagation).toHaveBeenCalledTimes(1);
    });

    it("leaves a drop carrying no files alone", () => {
      const onAttach = vi.fn();
      const event = dragEvent([]);

      fileAttachHandlers(onAttach).onDropCapture(event);

      expect(onAttach).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.nativeEvent.stopPropagation).not.toHaveBeenCalled();
    });

    it("declines when the surface cannot attach", () => {
      const event = dragEvent([file("a.png")]);

      fileAttachHandlers(undefined).onDropCapture(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("survives a drop with no dataTransfer at all", () => {
      const onAttach = vi.fn();
      const event: FileDragEvent = {
        dataTransfer: null,
        preventDefault: vi.fn(),
        nativeEvent: { stopPropagation: vi.fn() },
      };

      expect(() => fileAttachHandlers(onAttach).onDropCapture(event)).not.toThrow();
      expect(onAttach).not.toHaveBeenCalled();
    });
  });

  describe("dragover", () => {
    it("prevents the default, which is what makes this a drop target", () => {
      const event = dragEvent([]);

      fileAttachHandlers(vi.fn()).onDragOverCapture(event);

      // Note there are no files on a dragover — only `types` is readable — so
      // this must key off the type list, not off `files`.
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("ignores a drag carrying something other than files", () => {
      const event = dragEvent([], ["text/plain"]);

      fileAttachHandlers(vi.fn()).onDragOverCapture(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("declines when the surface cannot attach", () => {
      const event = dragEvent([]);

      fileAttachHandlers(undefined).onDragOverCapture(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("survives a dragover with no dataTransfer at all", () => {
      const event: FileDragEvent = {
        dataTransfer: null,
        preventDefault: vi.fn(),
        nativeEvent: { stopPropagation: vi.fn() },
      };

      expect(() => fileAttachHandlers(vi.fn()).onDragOverCapture(event)).not.toThrow();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("paste", () => {
    it("hands pasted files over and stops the native event", () => {
      const onAttach = vi.fn();
      const event = pasteEvent([file("shot.png")]);

      fileAttachHandlers(onAttach).onPasteCapture(event);

      expect(onAttach).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(event.nativeEvent.stopPropagation).toHaveBeenCalledTimes(1);
    });

    it("lets text paste as text", () => {
      const onAttach = vi.fn();
      const event = pasteEvent([]);

      fileAttachHandlers(onAttach).onPasteCapture(event);

      // A path copied out of a file manager arrives as text with an empty file
      // list. Intercepting it would break pasting a path into the body.
      expect(onAttach).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("declines when the surface cannot attach", () => {
      const event = pasteEvent([file("shot.png")]);

      fileAttachHandlers(undefined).onPasteCapture(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("survives a paste with no clipboardData at all", () => {
      const onAttach = vi.fn();
      const event: FilePasteEvent = {
        clipboardData: null,
        preventDefault: vi.fn(),
        nativeEvent: { stopPropagation: vi.fn() },
      };

      expect(() => fileAttachHandlers(onAttach).onPasteCapture(event)).not.toThrow();
      expect(onAttach).not.toHaveBeenCalled();
    });
  });
});
