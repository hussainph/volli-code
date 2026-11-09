import type { editor } from "monaco-editor";
import { documentModeOptions } from "./document-mode";

const warmed = new WeakSet<Document>();

/**
 * Use Monaco's public configuration path to cache its real font measurements.
 * A null model warms no document, language worker or registry entry. The
 * contained, unfocusable host has its own dimensions and never enters a pane.
 * Call only from idle work, not from the dialog's arrival/after-paint path.
 */
export function warmDocumentEditorFonts(
  host: Pick<typeof editor, "create">,
  document: Document,
): void {
  if (warmed.has(document)) return;
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.inert = true;
  Object.assign(container.style, {
    position: "fixed",
    width: "600px",
    height: "24px",
    contain: "strict",
    visibility: "hidden",
    pointerEvents: "none",
  });
  document.body.append(container);
  let view: editor.IStandaloneCodeEditor | undefined;
  try {
    view = host.create(container, {
      ...documentModeOptions({}),
      model: null,
      automaticLayout: false,
      dimension: { width: 600, height: 24 },
    });
    warmed.add(document);
  } finally {
    view?.dispose();
    container.remove();
  }
}
