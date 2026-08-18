import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { applyDocumentExternalValue, MonacoDocumentEditor } from "./monaco-document-editor";

describe("applyDocumentExternalValue", () => {
  it("adopts the host's value as model text and baseline in one transaction", () => {
    // No editor view is involved: the registry lands the change as minimal edit
    // operations and Monaco maps the caret through them. Restoring a pre-edit
    // view-state snapshot afterwards would undo exactly that mapping.
    const applyExternalUpdate = vi.fn();

    applyDocumentExternalValue({
      lease: { applyExternalUpdate },
      value: "agent document\n",
      revision: 3,
    });

    expect(applyExternalUpdate).toHaveBeenCalledWith({
      baseline: "agent document\n",
      value: "agent document\n",
      revision: 3,
    });
  });
});

/**
 * Static markup only sees the pre-Monaco frame — the mount effect never runs
 * under `react-dom/server` — but that frame renders the HOST element, and the
 * host is the whole point: it is the editor's layout box, so a caller's
 * `maxHeight` must be on it for `fitToContent`'s `clientHeight` read to see a
 * clamped box. Threading `style` only to the Monaco-unavailable `<pre>`
 * fallback (which real runs never reach) left VC-99's body clamp inert, so pin
 * the host here.
 */
describe("MonacoDocumentEditor host box", () => {
  const identity = { kind: "ticket-body", projectId: "p1", ticketId: "t1" } as const;

  it("applies the caller's inline style to the host the editor lays out into", () => {
    const html = renderToStaticMarkup(
      <MonacoDocumentEditor
        identity={identity}
        viewId="ticket-body:t1"
        value="body"
        onChange={() => {}}
        className="min-h-32"
        style={{ maxHeight: 384 }}
      />,
    );

    expect(html).toContain("max-height:384px");
    expect(html).toContain("min-h-32"); // the className path still works alongside it
  });

  it("leaves the host unstyled when the caller passes no style", () => {
    const html = renderToStaticMarkup(
      <MonacoDocumentEditor
        identity={identity}
        viewId="ticket-body:t1"
        value="body"
        onChange={() => {}}
      />,
    );

    expect(html).not.toContain("max-height");
    expect(html).not.toContain("style=");
  });
});
