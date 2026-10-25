// @vitest-environment jsdom
/**
 * The transcript half of VC-49's contract, rendered.
 *
 * The delivered prompt is pinned at four seams elsewhere (expansion, submit,
 * wire, delivery); these pin the only part a user ever sees — the bubble keeps
 * `/skill` exactly as typed, and a compact Badge is the whole visible footprint
 * of the body that rode along.
 */
import { sessionHostNoticeMetadata } from "@volli/shared";
import { projectTranscriptRows } from "@volli/session-presentation";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { UIMessage } from "ai";

import {
  ChatTranscriptRow,
  ChatTurn,
  PendingMessage,
  SessionBlocker,
  type TurnContext,
} from "./chat-plane";

const context: TurnContext = {
  onOpenFile: () => undefined,
  interactions: new Map(),
};

const SKILL_BODY = "# Hussain Sol\n\nThe fifteen kilobytes the chip stands for.";

function turn(message: UIMessage): string {
  return renderToStaticMarkup(<ChatTurn messages={[message]} context={context} live={false} />);
}

describe("the desktop transcript-row mapping", () => {
  it("draws the portable refresh fact as a quiet expandable system row", () => {
    const [row] = projectTranscriptRows(
      [],
      [],
      [],
      [
        {
          sequence: 8,
          afterMessageId: null,
          trigger: "cold-turn",
          added: ["write"],
          changed: ["codemode"],
        },
      ],
    );
    if (row === undefined) throw new Error("expected a refresh row");
    const html = renderToStaticMarkup(
      <ChatTranscriptRow row={row} context={context} live={false} />,
    );
    expect(html).toContain("Tools updated: 1 added");
    expect(html).toContain("Cold turn");
    expect(html).toContain("codemode (updated)");
    expect(html).toContain("<details");
    expect(html).not.toContain("is-user");
    expect(html).not.toContain('role="alert"');
  });

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
    // A labelled generic div is ignored by assistive tech; the role makes the
    // label count (VC-516).
    expect(html).toContain('role="group" aria-label="Skills delivered with this message"');
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

const NO_ACT = () => undefined;

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

  // VC-584: the failed environment setup's row, the one with a third act.
  it("draws every act a blocker offers, in order", () => {
    const html = renderToStaticMarkup(
      <SessionBlocker
        blocker={{
          message: "Environment setup failed",
          detail: ".agents/setup exited with code 1: boom",
          tone: "error",
          action: { label: "Retry setup", act: NO_ACT },
          secondaryAction: { label: "Start anyway", act: NO_ACT },
          tertiaryAction: { label: "Fix with an agent", act: NO_ACT },
          dismiss: { label: "Dismiss", act: NO_ACT },
        }}
      />,
    );
    const labels = [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(
      ([, label]) => label,
    );
    expect(labels).toEqual(["Retry setup", "Start anyway", "Fix with an agent"]);
  });
});

describe("VC-758 message and work status rows", () => {
  it("does not add a delivery footer to historical or interaction-answer messages", () => {
    const html = turn({ id: "old", role: "user", parts: [{ type: "text", text: "old words" }] });
    expect(html).not.toContain("message-delivery");
    expect(html).not.toContain("Recorded");
  });
  it("does not flash committed steering state during server rendering", () => {
    const html = renderToStaticMarkup(
      <ChatTurn
        messages={[{ id: "steer", role: "user", parts: [{ type: "text", text: "focus" }] }]}
        context={{
          ...context,
          deliveryLabels: new Map([["steer", "Pending"]]),
        }}
        live={false}
      />,
    );
    expect(html).not.toContain("message-delivery");
  });
  it.each(["send", "steer", "queue"] as const)(
    "renders %s words immediately without pending state before the delay",
    (delivery) => {
      const html = renderToStaticMarkup(
        <PendingMessage
          message={{ id: "pending", text: "my words", state: "sending", delivery }}
          context={context}
        />,
      );
      expect(html).toContain("my words");
      expect(html).not.toContain("message-delivery");
      expect(html).not.toContain("Delivered");
    },
  );
  it("keeps definite durable refusal visible", () => {
    const html = renderToStaticMarkup(
      <ChatTurn
        messages={[{ id: "user", role: "user", parts: [{ type: "text", text: "hello" }] }]}
        context={{ ...context, deliveryLabels: new Map([["user", "Not delivered"]]) }}
        live={false}
      />,
    );
    expect(html).toContain(">Not delivered</span>");
  });
  it.each(["send", "steer"] as const)(
    "keeps accepted held %s quiet even before durable proof arrives",
    (delivery) => {
      const html = renderToStaticMarkup(
        <PendingMessage
          message={{
            id: "user",
            text: "hello",
            state: "sending",
            delivery,
            deliveryAccepted: true,
          }}
          context={{ ...context, deliveryLabels: new Map([["user", "Pending"]]) }}
        />,
      );
      expect(html).toContain("hello");
      expect(html).not.toContain("message-delivery");
      expect(html).not.toContain("Delivered");
      expect(html).not.toContain("Pending");
    },
  );
  it("does not flash accepted held queue ownership before the delay", () => {
    const html = renderToStaticMarkup(
      <PendingMessage
        message={{
          id: "queued",
          text: "later",
          state: "sending",
          delivery: "queue",
          deliveryAccepted: true,
        }}
        context={context}
      />,
    );
    expect(html).not.toContain("message-delivery");
  });
  it("does not draw a durable Delivered footer without a local override", () => {
    const html = renderToStaticMarkup(
      <ChatTurn
        messages={[{ id: "user", role: "user", parts: [{ type: "text", text: "hello" }] }]}
        context={{ ...context, deliveryLabels: new Map([["user", "Delivered"]]) }}
        live={false}
      />,
    );
    expect(html).not.toContain("message-delivery");
  });
});
