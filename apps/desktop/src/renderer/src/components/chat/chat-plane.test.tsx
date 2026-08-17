/**
 * The transcript half of VC-49's contract, rendered.
 *
 * The delivered prompt is pinned at four seams elsewhere (expansion, submit,
 * wire, delivery); these pin the only part a user ever sees — the bubble keeps
 * `/skill` exactly as typed, and a compact Badge is the whole visible footprint
 * of the body that rode along.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { UIMessage } from "ai";

import { ChatTurn, type TurnContext } from "./chat-plane";

const context: TurnContext = {
  onOpenFile: () => undefined,
  interactions: new Map(),
  open: [],
  resolving: new Set(),
  onResolve: () => Promise.resolve(true),
};

const SKILL_BODY = "# Hussain Sol\n\nThe fifteen kilobytes the chip stands for.";

function turn(message: UIMessage): string {
  return renderToStaticMarkup(<ChatTurn messages={[message]} context={context} live={false} />);
}

describe("a user turn that delivered a skill", () => {
  const message: UIMessage = {
    id: "u1",
    role: "user",
    parts: [
      { type: "text", text: "can you tell me what /hussain-sol does?" },
      { type: "data-skill-resource", data: { name: "hussain-sol", text: SKILL_BODY } },
    ],
  };

  it("keeps the slash reference in the bubble and draws the name as a chip, never the body", () => {
    const html = turn(message);

    expect(html).toContain("can you tell me what /hussain-sol does?");
    expect(html).toContain('aria-label="Skills delivered with this message"');
    // The chip is the file's one vocabulary for a skill name: a Badge.
    expect(html).toMatch(/data-slot="badge"[^>]*>hussain-sol</);
    expect(html).not.toContain("fifteen kilobytes");
  });

  it("draws no chip row for a plain user message", () => {
    const html = turn({
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "just words" }],
    });

    expect(html).toContain("just words");
    expect(html).not.toContain("Skills delivered with this message");
  });

  it("draws no chip row on an assistant turn, whatever parts it carries", () => {
    const html = turn({ ...message, id: "a1", role: "assistant" });

    expect(html).not.toContain("Skills delivered with this message");
  });
});
