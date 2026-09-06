/**
 * Drop-and-paste file attach, as one decision (VC-106).
 *
 * VC-50 gave the chat composer drag-and-drop and paste and left the ticket
 * surfaces button-only. The handlers it wrote are four lines each and three
 * subtleties deep, so the second and third copy of them would have been the
 * place the subtleties rotted. They live here instead: the views spread these
 * onto whatever element is the target, and the reasoning is written down once.
 *
 * A pure `.ts` beside the `.tsx` that spreads it, for the reason `tab-focus.ts`
 * and `scroll-chaining.ts` are: the decision is testable and worth the gate,
 * the glue that mounts it is not.
 */

/**
 * The three capture-phase handlers a surface spreads to accept files.
 *
 * Deliberately structural rather than `React.DOMAttributes`: the fields are
 * named exactly as the JSX props they spread onto, so a call site reads as the
 * props it becomes and a test can call them with a stub event.
 */
export interface FileAttachHandlers {
  onDropCapture: (event: FileDragEvent) => void;
  onDragOverCapture: (event: FileDragEvent) => void;
  onPasteCapture: (event: FilePasteEvent) => void;
}

/**
 * The part of a React drag event this decision reads.
 *
 * `Iterable<File>` rather than `FileList` so a test can pass an array: the two
 * meet at the spread, which is all this module does with either.
 */
export interface FileDragEvent {
  dataTransfer: { files: Iterable<File>; types: readonly string[] } | null;
  preventDefault: () => void;
  nativeEvent: { stopPropagation: () => void };
}

/** The part of a React paste event this decision reads. */
export interface FilePasteEvent {
  clipboardData: { files: Iterable<File> } | null;
  preventDefault: () => void;
  nativeEvent: { stopPropagation: () => void };
}

/**
 * Capture-phase handlers that route dropped and pasted files to `onAttach`.
 *
 * CAPTURE, and that is the whole point. The vendored `PromptInput` binds its
 * own native drop listener on the form and routes what it catches into the
 * vendored attachment state, which none of these composers use — so a dropped
 * file would land there and be seen by nobody. Monaco is the same hazard on the
 * ticket surfaces: its native `dragover` listener stages a dotted drop-caret
 * decoration, then its `drop` listener clears it. The outer attach handler
 * consumes `drop` before Monaco sees it, so it must consume `dragover` too or
 * that decoration is staged without ever being cleared. React registers these
 * handlers at the root, while the event is still descending; stopping the
 * NATIVE event is what keeps it from reaching those nested listeners at all.
 *
 * Passing `undefined` returns handlers that do nothing, so a surface that
 * cannot attach spreads the same props and simply declines every drop.
 */
export function fileAttachHandlers(
  onAttach: ((files: readonly File[]) => void) | undefined,
): FileAttachHandlers {
  return {
    onDropCapture: (event) => {
      const dropped = [...(event.dataTransfer?.files ?? [])];
      if (onAttach === undefined || dropped.length === 0) return;
      event.preventDefault();
      event.nativeEvent.stopPropagation();
      onAttach(dropped);
    },
    onDragOverCapture: (event) => {
      // Without preventDefault the drop is never delivered: the default action
      // for dragover is "reject". Propagation must stop for the same files the
      // outer surface claims, or a nested Monaco stages its dotted drop target
      // and never receives the captured drop that would clear it (VC-261).
      if (onAttach !== undefined && event.dataTransfer?.types.includes("Files") === true) {
        event.preventDefault();
        event.nativeEvent.stopPropagation();
      }
    },
    onPasteCapture: (event) => {
      const pasted = [...(event.clipboardData?.files ?? [])];
      if (onAttach === undefined || pasted.length === 0) return;
      // Only when the clipboard actually carries files. A paste of text that
      // happens to come from a file manager still pastes as text.
      event.preventDefault();
      event.nativeEvent.stopPropagation();
      onAttach(pasted);
    },
  };
}
