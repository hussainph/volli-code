/**
 * The transcript half of VC-49's contract, rendered.
 *
 * The delivered prompt is pinned at four seams elsewhere (expansion, submit,
 * wire, delivery); these pin the only part a user ever sees — the bubble keeps
 * `/skill` exactly as typed, and a compact Badge is the whole visible footprint
 * of the body that rode along.
 */
import { sessionHostNoticeMetadata, type RendererSessionInteraction } from "@volli/shared";
import { projectTranscriptRows } from "@volli/session-presentation";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { UIMessage } from "ai";

import { ChatTranscriptRow, ChatTurn, SessionBlocker, type TurnContext } from "./chat-plane";

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

describe("the desktop transcript-row mapping", () => {
  it("reports the actual allow-once outcome when saving a standing approval failed", () => {
    const interaction: RendererSessionInteraction = {
      id: "ask:c",
      attachmentId: "a",
      kind: "permission",
      title: "Allow writing outside this workspace?",
      detail: null,
      multiple: false,
      native: { id: null, detail: null },
      approval: {
        asked: "write /outside/a",
        because: "outside",
        reason: "outside",
        stages: [],
        held: null,
      },
      options: [{ id: "session", label: "Allow for this Session", description: null }],
    };
    const html = renderToStaticMarkup(
      <ChatTurn
        live={false}
        context={{
          ...context,
          interactions: new Map([[interaction.id, interaction]]),
          approvalFailures: new Map([["answer", "once"]]),
        }}
        messages={[
          {
            id: "answer",
            role: "user",
            metadata: { interactionId: interaction.id },
            parts: [
              {
                type: "data-interaction-resolution",
                data: { optionIds: ["session"], response: null },
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("once");
    expect(html).not.toContain("for this Session");
  });

  it.each(["PI_INTERACTION_NOT_RECORDED", "PI_INTERACTION_RESOLVING"])(
    "does not claim a remembered approval for a rejected %s answer",
    () => {
      const interaction: RendererSessionInteraction = {
        id: "ask:c",
        attachmentId: "a",
        kind: "permission",
        title: "Allow writing outside this workspace?",
        detail: null,
        multiple: false,
        native: { id: null, detail: null },
        approval: {
          asked: "write /outside/a",
          because: "outside",
          reason: "outside",
          stages: [],
          held: null,
        },
        options: [{ id: "project", label: "Always allow in this project", description: null }],
      };
      const html = renderToStaticMarkup(
        <ChatTurn
          live={false}
          context={{
            ...context,
            interactions: new Map([[interaction.id, interaction]]),
            approvalFailures: new Map([["answer", "not-delivered"]]),
          }}
          messages={[
            {
              id: "answer",
              role: "user",
              metadata: { interactionId: interaction.id },
              parts: [
                {
                  type: "data-interaction-resolution",
                  data: { optionIds: ["project"], response: null },
                },
              ],
            },
          ]}
        />,
      );
      expect(html).toContain("Answer not delivered");
      expect(html).not.toContain("You allowed");
      expect(html).not.toContain("always in this project");
    },
  );

  it.each(["shadow", "auto"] as const)(
    "draws a %s classifier verdict quietly, never as a message bubble",
    (mode) => {
      const [row] = projectTranscriptRows(
        [],
        [],
        [],
        [
          {
            sequence: 1,
            afterMessageId: null,
            toolCallId: "call-1",
            tool: "execute",
            mode,
            reason: "Outside the request.",
          },
        ],
      );
      if (row === undefined) throw new Error("expected a verdict notice");
      const html = renderToStaticMarkup(
        <ChatTranscriptRow row={row} context={context} live={false} />,
      );
      expect(html).toContain(
        `${mode === "shadow" ? "Would block" : "Blocked"} execute: Outside the request.`,
      );
      expect(html).toContain("text-muted-foreground");
      expect(html).not.toContain("is-user");
      expect(html).not.toContain("is-assistant");
      expect(html).not.toContain('aria-label="Copy"');
    },
  );

  it("draws a projected host notice without entering the user-message component", () => {
    const modelText =
      '[Subagent Session child-1 ("Review tests") completed its task. Read its answer.]';
    const [row] = projectTranscriptRows(
      [
        [
          {
            id: "notice-1",
            role: "user",
            metadata: sessionHostNoticeMetadata({
              kind: "subagent",
              childSessionId: "child-session-1",
              title: "Review tests",
              state: "completed",
              reason: null,
            }),
            parts: [{ type: "text", text: modelText }],
          },
        ],
      ],
      [],
      [],
    );
    if (row === undefined) throw new Error("expected one transcript row");

    const html = renderToStaticMarkup(
      <ChatTranscriptRow row={row} context={context} live={false} />,
    );
    expect(html).toContain("Review tests");
    expect(html).toContain("done");
    expect(html).not.toContain(modelText);
    expect(html).not.toContain("is-user");
    expect(html).not.toContain('aria-label="Copy"');
  });
});

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

describe("ChatTurn copy control", () => {
  it.each(["user", "assistant"] as const)("renders Copy for a %s message", (role) => {
    const html = turn({
      id: `${role}-1`,
      role,
      parts: [{ type: "text", text: `${role} message` }],
    });

    expect(html).toContain('aria-label="Copy"');
  });
});

describe("SessionBlocker hit testing", () => {
  it("opts back into pointer events within the composer overlay", () => {
    const html = renderToStaticMarkup(
      <div className="pointer-events-none">
        <SessionBlocker
          blocker={{
            message: "Session stopped",
            detail: "Stream ended without finish_reason",
            tone: "error",
            action: { label: "Retry", act: () => undefined },
            dismiss: { label: "Dismiss", act: () => undefined },
          }}
        />
      </div>,
    );

    // The rule, not the markup: an overlay that lets clicks through, and the
    // blocker inside it opting back in. Asserted without pinning attribute
    // ORDER — the element grew a `data-slot` ahead of its class and the whole
    // hit-testing claim went with it, which is a test describing a render
    // rather than a behaviour. Keeps main's `data-slot` requirement, since the
    // slot is how this element is addressed, without re-pinning the position
    // of the next attribute somebody adds.
    expect(html).toMatch(
      /^<div class="pointer-events-none"><div\b[^>]*\bdata-slot="session-blocker"[^>]*\bclass="[^"]*\bpointer-events-auto\b/,
    );
    expect(html).toContain('aria-label="Dismiss"');
  });
});
