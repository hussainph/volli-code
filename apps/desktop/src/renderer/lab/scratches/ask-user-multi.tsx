/** VC-749: the existing card over the Pi adapter's multi-question record. */
import * as React from "react";
import {
  type RendererSessionInteraction,
  type SessionInteractionPrompt,
  promptId,
} from "@volli/shared";
import type { InteractionSubmission } from "@volli/session-presentation";

import { SecretCards } from "@renderer/components/chat/secret-card";
import { InteractionCard } from "@renderer/components/chat/interaction-ui";
import { Button } from "@renderer/components/ui/button";

export const title = "Ask user · one or three questions";
export const note = "Question, permission and credential cards · light/dark via Lab theme";

function interaction(longText: boolean, single: boolean): RendererSessionInteraction {
  const prompts: SessionInteractionPrompt[] = [
    {
      id: promptId(0),
      label: longText
        ? "Which scope should this change cover? The existing question card already collects every answer, so this decision only changes the tool and its adapter.\n\nKeep single-question calls unchanged, preserve frozen Sessions, and make sure an older build can still read and answer the stored interaction. Choose the smallest scope that unblocks the same implementation step."
        : "Which scope should this change cover?",
      detail: null,
      options: [
        {
          id: "choice:0",
          label: longText
            ? "Tool and adapter only, keeping the existing interaction card, keyboard behavior, stored prompt shape and older readers unchanged"
            : "Tool and adapter only",
          description: null,
        },
        { id: "choice:1", label: "Include renderer changes", description: null },
      ],
      multiple: false,
      custom: true,
    },
    {
      id: promptId(1),
      label: "Which checks should run before handoff?",
      detail: null,
      options: [
        { id: "choice:0", label: "Focused tests", description: null },
        { id: "choice:1", label: "Typecheck", description: null },
        {
          id: "choice:2",
          label: longText
            ? "Keyboard and narrow-pane lab check with long question text and wrapping option labels"
            : "Lab check",
          description: null,
        },
      ],
      multiple: false,
      custom: true,
    },
    {
      id: promptId(2),
      label: "What should the handoff be called?",
      detail: null,
      options: [],
      multiple: false,
      custom: true,
    },
  ];
  const first = prompts[0]!;
  return {
    // askUserInteractionId("call-multi") in the Pi adapter.
    id: "ask-user:call-multi",
    attachmentId: "attach-lab",
    kind: "question",
    title: first.label,
    detail: null,
    options: first.options,
    multiple: first.multiple,
    prompts: single ? prompts.slice(0, 1) : prompts,
    native: { id: null, detail: null },
  };
}

const permission: RendererSessionInteraction = {
  id: "permission:lab",
  attachmentId: "attach-lab",
  kind: "permission",
  title: "Run focused tests",
  detail: "pnpm exec vp test run",
  multiple: false,
  options: [
    { id: "once", label: "Allow once", description: null },
    { id: "always", label: "Allow always", description: null },
    { id: "reject", label: "Reject", description: null },
  ],
  native: { id: null, detail: null },
};
const credential: RendererSessionInteraction = {
  id: "credential:lab",
  attachmentId: "attach-lab",
  kind: "question",
  title: "Credential requested",
  detail: null,
  options: [],
  multiple: false,
  native: { id: null, detail: null },
  credential: {
    id: "credential:lab",
    name: "DEPLOY_TOKEN",
    sessionId: "session-lab",
    sessionLabel: "Deploy session",
    projectId: "project-lab",
    projectLabel: "Website",
    agentSays: "Access for deployment",
  },
};

export default function AskUserMultiScratch() {
  const [single, setSingle] = React.useState(false);
  const [narrow, setNarrow] = React.useState(false);
  const [longText, setLongText] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [sent, setSent] = React.useState<InteractionSubmission[]>([]);
  const [withdrawn, setWithdrawn] = React.useState(false);
  const reset = () => {
    setRevision((value) => value + 1);
    setSent([]);
    setWithdrawn(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          aria-pressed={single}
          onClick={() => {
            setSingle(!single);
            reset();
          }}
        >
          {single ? "Three questions" : "One question"}
        </Button>
        <Button variant="outline" aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>
          Narrow pane
        </Button>
        <Button
          variant="outline"
          aria-pressed={longText}
          onClick={() => {
            setLongText(!longText);
            reset();
          }}
        >
          Long text
        </Button>
        <Button variant="outline" onClick={reset}>
          Reset
        </Button>
      </div>
      <div
        className="grid w-full max-w-full items-start gap-4"
        style={{
          width: narrow ? 320 : 1100,
          gridTemplateColumns: narrow ? "minmax(0,1fr)" : "minmax(0,2fr) minmax(0,1fr)",
        }}
      >
        <div style={{ containerType: "size", height: 600 }}>
          <InteractionCard
            key={revision}
            interaction={interaction(longText, single)}
            onResolve={(submission) => setSent((previous) => [...previous, submission])}
            onWithdraw={() => setWithdrawn(true)}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <InteractionCard
            key={`permission:${revision}`}
            interaction={permission}
            onResolve={() => undefined}
          />
          <SecretCards
            key={`credential:${revision}`}
            sessionId="session-lab"
            interactions={[credential]}
          />
        </div>
      </div>
      <output className="text-sm" aria-live="polite">
        Submissions: {sent.length}
        {withdrawn ? " · Withdrawn" : ""}
      </output>
      <pre className="max-w-full overflow-auto rounded-lg border border-border p-4 text-xs">
        {JSON.stringify(sent, null, 2)}
      </pre>
    </div>
  );
}
