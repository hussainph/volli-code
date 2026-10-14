import type { IpcRequest } from "@volli/host-protocol/ipc";
import { ACTIVITY_METADATA_KEY, type BackgroundShellState } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import type { ApiOverrides } from "../fake-api";

import { ActivityBundle, ToolRow } from "@renderer/components/chat/activity-ui";
import { RunningBashProvider } from "@renderer/components/chat/running-bash-control";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";

export const title = "Running bash · move to background";
export const note = "Real tool rows: running, moved, at capacity, unsupported and nested.";
const BEFORE = "00000000-0000-4000-8000-000000000001";
const CAP = "00000000-0000-4000-8000-000000000002";
const COLLAPSED = "00000000-0000-4000-8000-000000000003";

function shell(shellId: string, sessionId: string): BackgroundShellState {
  return {
    shellId,
    sessionId,
    projectId: "p",
    ticketId: null,
    command: "pnpm dev",
    title: null,
    state: "running",
    code: null,
    signal: null,
    startedAt: 1,
    exitedAt: null,
    pid: 123,
  };
}
export function seed() {
  useBackgroundShellsStore.getState().receiveAll([1, 2, 3, 4].map((id) => shell(`cap-${id}`, CAP)));
}
export const api: ApiOverrides = {
  sessionRpc: {
    async request(request: IpcRequest) {
      if (request.path !== "shells.moveToBackground")
        return { ok: false, error: { code: "NOT_FOUND", message: "Not in this fixture" } };
      const { sessionId } = request.input as { sessionId: string };
      useBackgroundShellsStore.getState().receive(shell("moved-shell", sessionId));
      return { ok: true, data: { shellId: "moved-shell" } };
    },
    cancel() {},
    onEvent: () => () => {},
  },
};
function bash(id: string, running: boolean, supported: boolean): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "volli.activity",
    toolCallId: id,
    state: "output-available",
    preliminary: running,
    input: { command: "pnpm dev --host localhost" },
    output: {
      content: [
        {
          type: "text",
          text: running
            ? "Vite ready on localhost:5300"
            : [
                "Moved command to background shell moved-shell.",
                "It keeps running. A notice will arrive when it exits; use shell_output to read it or shell_kill to end it.",
                "Output so far:",
                "Vite ready on localhost:5300",
              ].join("\n"),
        },
      ],
      details: supported ? { backgroundable: true } : {},
    },
    toolMetadata: {
      [ACTIVITY_METADATA_KEY]: {
        kind: "run-command",
        nativeToolName: "bash",
        subject: { label: "pnpm dev --host localhost", path: null, lineRange: null },
        outcome: null,
        startedAt: 1,
        endedAt: running ? null : 2,
      },
    } as DynamicToolUIPart["toolMetadata"],
  };
}
export default function RunningBashScratch() {
  const moved = useBackgroundShellsStore((state) => state.byId["moved-shell"] !== undefined);
  return (
    <div className="mx-auto max-w-content space-y-6">
      {[
        {
          label: moved ? "Moved · turn continues" : "Running · click Move to background",
          sessionId: BEFORE,
          part: bash("before", !moved, !moved),
        },
        { label: "Moved · settled receipt", sessionId: BEFORE, part: bash("after", false, false) },
        {
          label: "At capacity · 4 running background shells",
          sessionId: CAP,
          part: bash("cap", true, true),
        },
        {
          label: "Old frozen Session · no background-shell support",
          sessionId: BEFORE,
          part: bash("frozen", true, false),
        },
        {
          label: "Unsupported foreground path",
          sessionId: BEFORE,
          part: bash("unsupported", true, false),
        },
        {
          label: "Nested Code Mode shell · visible unsupported reason",
          sessionId: BEFORE,
          part: bash("program/nested/bash", true, false),
        },
        {
          label: "Collapsed activity · focus composer and press Ctrl+Shift+B",
          sessionId: COLLAPSED,
          part: bash("collapsed", !moved, !moved),
        },
      ].map(({ label, sessionId, part }) => (
        <section key={part.toolCallId} className="space-y-2">
          <h2 className="text-label text-muted-foreground">{label}</h2>
          <RunningBashProvider sessionId={sessionId} active>
            {part.toolCallId === "collapsed" ? (
              <>
                <ActivityBundle rows={[{ kind: "tool", key: part.toolCallId, part }]} />
                <textarea
                  aria-label="Composer"
                  placeholder="Focus here for Ctrl+Shift+B"
                  className="w-full bg-background text-ui text-foreground"
                />
              </>
            ) : (
              <ToolRow part={part} />
            )}
          </RunningBashProvider>
        </section>
      ))}
    </div>
  );
}
