// @vitest-environment jsdom
/**
 * The transcript half of VC-49's contract, rendered.
 *
 * The delivered prompt is pinned at four seams elsewhere (expansion, submit,
 * wire, delivery); these pin the only part a user ever sees — the bubble keeps
 * `/skill` exactly as typed, and a compact Badge is the whole visible footprint
 * of the body that rode along.
 */
import {
  sessionHostNoticeMetadata,
  SESSION_TOOL_CALL_SCOPE_METADATA_KEY,
  type RendererSessionInteraction,
} from "@volli/shared";
import {
  approvalAnswerFailures,
  projectTranscriptRows,
  type TranscriptAuthorityReview,
} from "@volli/session-presentation";
import { renderToStaticMarkup } from "react-dom/server";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useUiStore } from "@renderer/stores/ui";
import type { UIMessage } from "ai";

import { ChatTranscriptRow, ChatTurn, SessionBlocker, type TurnContext } from "./chat-plane";

const activityBundleRenders = vi.hoisted(() => vi.fn());
vi.mock("./activity-ui", async (importOriginal) => {
  const original = await importOriginal<typeof import("./activity-ui")>();
  return {
    ...original,
    ActivityBundle: (props: ComponentProps<typeof original.ActivityBundle>) => {
      activityBundleRenders(props);
      return <original.ActivityBundle {...props} />;
    },
  };
});

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

afterEach(() => useUiStore.setState({ authorityHintsVisible: true }));

describe("the desktop transcript-row mapping", () => {
  it("does not rerender settled reviewed tools for unrelated transcript updates", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    activityBundleRenders.mockClear();
    const container = document.createElement("div");
    const root = createRoot(container);
    const scope = { attachmentId: "attachment-1", turnId: "turn-1" };
    const messages: UIMessage[] = [
      {
        id: "settled",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call-1",
            toolName: "execute",
            state: "output-available",
            input: { command: "pnpm test" },
            output: "Passed",
            toolMetadata: { [SESSION_TOOL_CALL_SCOPE_METADATA_KEY]: scope },
          },
        ],
      },
    ];
    const review = {
      sequence: 1,
      afterMessageId: null,
      toolCallId: "call-1",
      scope,
      tool: "execute",
      mode: "shadow" as const,
      reason: "Classifier concern.",
    };
    const project = (reason = review.reason) =>
      projectTranscriptRows([messages], [], [], [{ ...review, scope: { ...scope }, reason }])[0]!;
    try {
      act(() => root.render(<ChatTranscriptRow row={project()} context={context} live={false} />));
      expect(activityBundleRenders).toHaveBeenCalledTimes(1);
      // Real projection produces new linked-review wrappers on each update,
      // while the settled turn and all of the review's values are unchanged.
      act(() => root.render(<ChatTranscriptRow row={project()} context={context} live={false} />));
      expect(activityBundleRenders).toHaveBeenCalledTimes(1);
      act(() =>
        root.render(
          <ChatTranscriptRow row={project("Updated concern.")} context={context} live={false} />,
        ),
      );
      expect(activityBundleRenders).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it.each(["append", "reason", "mode"] as const)(
    "keeps the first reviewed tool's group when the second review changes (%s)",
    (change) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      activityBundleRenders.mockClear();
      const container = document.createElement("div");
      const root = createRoot(container);
      const scope = { attachmentId: "attachment-1", turnId: "turn-1" };
      const messages: UIMessage[] = [
        {
          id: "live",
          role: "assistant",
          parts: [1, 2].map((index) => ({
            type: "dynamic-tool" as const,
            toolCallId: `call-${index}`,
            toolName: "execute",
            state: "output-error" as const,
            input: { command: `echo ${index}` },
            errorText: `Failed ${index}`,
            toolMetadata: { [SESSION_TOOL_CALL_SCOPE_METADATA_KEY]: scope },
          })),
        },
      ];
      const reviews: TranscriptAuthorityReview[] = [1, 2].map((sequence) => ({
        sequence,
        afterMessageId: null,
        toolCallId: `call-${sequence}`,
        scope,
        tool: "execute",
        mode: "shadow",
        reason: `Concern ${sequence}.`,
      }));
      const render = (next: readonly TranscriptAuthorityReview[]) => {
        const [row] = projectTranscriptRows(
          [messages],
          [],
          [],
          next.map((review) => ({ ...review, scope: { ...scope } })),
        );
        if (row === undefined) throw new Error("expected a turn");
        act(() => root.render(<ChatTranscriptRow row={row} context={context} live />));
        return activityBundleRenders.mock.lastCall![0] as ComponentProps<
          typeof import("./activity-ui").ActivityBundle
        >;
      };
      try {
        const before = render(reviews).authorityReviews!;
        expect(before.get("live:0")).toHaveLength(1);
        expect(before.get("live:1")).toHaveLength(1);
        const disclosures = container.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Show details"]',
        );
        expect(disclosures).toHaveLength(2);
        act(() => disclosures.forEach((button) => button.click()));
        const updated = {
          ...reviews[1]!,
          ...(change === "append" ? { sequence: 3 } : {}),
          ...(change === "mode" ? { mode: "auto" as const } : { reason: "Updated concern." }),
        };
        const next = change === "append" ? [...reviews, updated] : [reviews[0]!, updated];
        const after = render(next).authorityReviews!;
        expect(after.get("live:0")).toBe(before.get("live:0"));
        expect(after.get("live:1")).not.toBe(before.get("live:1"));
        expect(after.get("live:1")).toHaveLength(change === "append" ? 2 : 1);
        expect(
          [...container.querySelectorAll('[data-slot="authority-review"]')].map(
            (node) => node.textContent,
          ),
        ).toEqual(
          next.map(
            (review) =>
              `${review.mode === "shadow" ? "Would block" : "Blocked"} execute: ${review.reason}`,
          ),
        );
        // Streaming new prose re-segments the live turn, but no review changed.
        const streamedMessages: UIMessage[] = [
          {
            ...messages[0]!,
            parts: [...messages[0]!.parts, { type: "text", text: "Still working." }],
          },
        ];
        const [streamedRow] = projectTranscriptRows([streamedMessages], [], [], next);
        if (streamedRow === undefined) throw new Error("expected a turn");
        act(() => root.render(<ChatTranscriptRow row={streamedRow} context={context} live />));
        expect(activityBundleRenders.mock.lastCall![0].authorityReviews).toBe(after);
      } finally {
        act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("hides shadow fallback hints but never hides an actual block", () => {
    useUiStore.setState({ authorityHintsVisible: false });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      for (const mode of ["shadow", "auto"] as const) {
        const review = {
          sequence: 1,
          afterMessageId: null,
          toolCallId: "x",
          tool: "execute",
          mode,
          reason: "Outside the request.",
        };
        act(() =>
          root.render(
            <ChatTranscriptRow
              row={{ kind: "authority-review", review }}
              context={context}
              live={false}
            />,
          ),
        );
        expect(container.textContent?.includes("Outside the request.")).toBe(mode === "auto");
      }
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it.each(["shadow", "auto"] as const)(
    "filters linked %s hints live without hiding a block or runtime error",
    (mode) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      const root = createRoot(container);
      const review = {
        sequence: 1,
        afterMessageId: null,
        toolCallId: "call-1",
        tool: "execute",
        mode,
        reason: "Classifier concern.",
      };
      const messages: UIMessage[] = [
        {
          id: "a",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "call-1",
              toolName: "execute",
              state: "output-error",
              input: { command: "pnpm test" },
              errorText: "Actual command failure",
            },
          ],
        },
      ];
      const [row] = projectTranscriptRows([messages], [], [], [review]);
      if (row === undefined) throw new Error("expected a turn");
      try {
        act(() => root.render(<ChatTranscriptRow row={row} context={context} live={false} />));
        const show = container.querySelector<HTMLButtonElement>('[aria-label="Show details"]');
        expect(show).not.toBeNull();
        act(() => show?.click());
        expect(container.textContent).toContain("Classifier concern.");
        act(() => useUiStore.getState().setAuthorityHintsVisible(false));
        expect(container.textContent?.includes("Classifier concern.")).toBe(mode === "auto");
        expect(container.textContent).toContain("Actual command failure");
        act(() => useUiStore.getState().setAuthorityHintsVisible(true));
        expect(container.textContent).toContain("Classifier concern.");
      } finally {
        act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("uses resolved row keys for reused call ids in bundles and gated calls", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const earlierScope = { attachmentId: "earlier", turnId: "t" };
    const laterScope = { attachmentId: "later", turnId: "t" };
    const messages: UIMessage[] = [
      {
        id: "earlier-message",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "execute",
            toolCallId: "reused",
            state: "output-error",
            input: { command: "echo earlier" },
            errorText: "Old error",
            toolMetadata: { [SESSION_TOOL_CALL_SCOPE_METADATA_KEY]: earlierScope },
          },
        ],
      },
      {
        id: "later-message",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "execute",
            toolCallId: "reused",
            state: "approval-requested",
            input: { command: "echo later" },
            approval: { id: "approval" },
            toolMetadata: { [SESSION_TOOL_CALL_SCOPE_METADATA_KEY]: laterScope },
          },
        ],
      },
    ];
    const reviews = [earlierScope, laterScope].map((scope, index) => ({
      sequence: index + 1,
      afterMessageId: null,
      toolCallId: "reused",
      tool: "execute",
      scope,
      mode: "shadow" as const,
      reason: index === 0 ? "Earlier concern" : "Later concern",
    }));
    const [row] = projectTranscriptRows([messages], [], [], reviews);
    if (row === undefined) throw new Error("expected a turn");
    try {
      act(() => root.render(<ChatTranscriptRow row={row} context={context} live={false} />));
      const disclosures = container.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Show details"]',
      );
      expect(disclosures).toHaveLength(2);
      act(() => disclosures[0]!.click());
      expect(container.textContent).toContain("Earlier concern");
      expect(container.textContent).not.toContain("Later concern");
      act(() => disclosures[1]!.click());
      expect(
        [...container.querySelectorAll('[data-slot="authority-review"]')].map(
          (node) => node.textContent,
        ),
      ).toEqual(["Would block execute: Earlier concern", "Would block execute: Later concern"]);
      // Placement comes only from the portable projection. Moving a scoped
      // review to the other resolved call must clear the previous row's group.
      const [movedRow] = projectTranscriptRows(
        [messages],
        [],
        [],
        [{ ...reviews[0]!, scope: laterScope }, reviews[1]!],
      );
      if (movedRow === undefined) throw new Error("expected a turn");
      act(() => root.render(<ChatTranscriptRow row={movedRow} context={context} live={false} />));
      const earlierTool = container.querySelector(
        '[data-slot="refusal-explanation"]',
      )!.parentElement!;
      expect(earlierTool.querySelectorAll('[data-slot="authority-review"]')).toHaveLength(0);
      expect(
        [...container.querySelectorAll('[data-slot="authority-review"]')].map(
          (node) => node.textContent,
        ),
      ).toEqual(["Would block execute: Earlier concern", "Would block execute: Later concern"]);
      const groups = activityBundleRenders.mock.lastCall![0].authorityReviews as ReadonlyMap<
        string,
        readonly TranscriptAuthorityReview[]
      >;
      expect([...groups.keys()]).toEqual(["later-message:0"]);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

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
      options: [
        { id: "once", label: "Allow once", description: null },
        { id: "session", label: "Allow for this Session", description: null },
      ],
    };
    const html = renderToStaticMarkup(
      <ChatTurn
        live={false}
        context={{
          ...context,
          interactions: new Map([[interaction.id, interaction]]),
          approvalFailures: approvalAnswerFailures([
            {
              event: {
                payload: {
                  kind: "command.receipt.recorded",
                  receipt: {
                    id: "receipt",
                    commandId: "answer",
                    sequence: 1,
                    recordedAt: 1,
                    status: "rejected",
                    code: "PI_APPROVAL_NOT_REMEMBERED",
                    detail: "disk full",
                  },
                },
              },
            },
          ]),
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
    (code) => {
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
            approvalFailures: approvalAnswerFailures([
              {
                event: {
                  payload: {
                    kind: "command.receipt.recorded",
                    receipt: {
                      id: "receipt",
                      commandId: "answer",
                      sequence: 1,
                      recordedAt: 1,
                      status: "rejected",
                      code,
                      detail: "delivery failed",
                    },
                  },
                },
              },
            ]),
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
    "gives an unmatched %s classifier verdict a disclosure, never a message bubble",
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
      expect(html).toContain("<details");
      expect(/<details[^>]* open=""/.test(html)).toBe(mode === "auto");
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
