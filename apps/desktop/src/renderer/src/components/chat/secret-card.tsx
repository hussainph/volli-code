/** Person-only credential controls, outside the transcript and interaction resolver.
 * Values live only in the password DOM node until the dedicated IPC write.
 */
import * as React from "react";
import type { SecretRequestMetadata, SecretScope } from "../../../../ipc/secrets";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { toastError } from "@renderer/lib/toast";

export function SecretCards({ sessionId }: { sessionId: string }) {
  const [requests, setRequests] = React.useState<readonly SecretRequestMetadata[]>([]);
  const settled = React.useRef(new Set<string>());

  React.useEffect(() => {
    const api = window.api?.secrets;
    if (api === undefined) return;
    const list = api.list;
    let current = true;
    let reading = false;
    let failed = false;
    async function poll(): Promise<void> {
      if (reading) return;
      reading = true;
      try {
        const result = await list();
        if (!current) return;
        if (!result.ok) throw new Error("Credential metadata unavailable");
        setRequests(result.requests.filter((request) => request.sessionId === sessionId));
        failed = false;
      } catch {
        if (current && !failed) toastError("Couldn't load credential requests.");
        failed = true;
      } finally {
        reading = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  return requests
    .filter((request) => request.sessionId === sessionId && !settled.current.has(request.id))
    .map((request) => (
      <SecretCard
        key={request.id}
        request={request}
        onSettled={() => {
          settled.current.add(request.id);
          setRequests((previous) => previous.filter((item) => item.id !== request.id));
        }}
      />
    ));
}

function SecretCard({
  request,
  onSettled,
}: {
  request: SecretRequestMetadata;
  onSettled: () => void;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const latch = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [scope, setScope] = React.useState<SecretScope>("session");
  const titleId = React.useId();
  const fieldId = React.useId();
  const scopeId = React.useId();

  async function act(kind: "submit" | "decline"): Promise<void> {
    if (latch.current) return;
    // Clear before IPC or any render. Never copy this into React/store state.
    const value = kind === "submit" ? (input.current?.value ?? "") : "";
    if (input.current !== null) input.current.value = "";
    if (kind === "submit" && value.length === 0) {
      toastError("Enter a credential first.");
      return;
    }
    latch.current = true;
    setBusy(true);
    try {
      const result =
        kind === "submit"
          ? await window.api.secrets.submit({ requestId: request.id, value, scope })
          : await window.api.secrets.decline(request.id);
      if (!result.ok) throw new Error("Credential action failed");
      onSettled();
    } catch {
      // Neither an exception nor agent metadata is safe error copy.
      toastError(
        kind === "submit"
          ? "Couldn't submit the credential."
          : "Couldn't decline the credential request.",
      );
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby={titleId}
      data-slot="secret-card"
      className="pointer-events-auto mb-2 flex flex-col gap-2 rounded-xl border border-border bg-background p-4 text-ui text-foreground shadow-raised"
    >
      <h2 id={titleId} className="font-medium">
        Credential requested
      </h2>
      <dl className="flex flex-wrap gap-x-4 gap-y-2 text-muted-foreground">
        <div>
          <dt className="inline">Session: </dt>
          <dd className="inline">{request.sessionLabel}</dd>
        </div>
        <div>
          <dt className="inline">Project: </dt>
          <dd className="inline">{request.projectLabel}</dd>
        </div>
      </dl>
      {request.agentSays !== null && (
        <div data-slot="secret-agent-purpose" className="rounded-control border border-border p-2">
          <p className="font-medium">The agent says</p>
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
            {request.agentSays}
          </p>
        </div>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act("submit");
        }}
      >
        <label htmlFor={fieldId}>{request.name}</label>
        <Input
          ref={input}
          id={fieldId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={scopeId}>Scope</label>
          <select
            id={scopeId}
            value={scope}
            disabled={busy}
            className="h-7 rounded-control border border-border bg-background px-2 text-ui outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => {
              const next = event.target.value;
              if (next === "session" || next === "project" || next === "always") setScope(next);
            }}
          >
            <option value="session">Session</option>
            <option value="project">Project</option>
            <option value="always">Always</option>
          </select>
          <Button type="submit" disabled={busy}>
            Submit credential
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void act("decline")}
          >
            Decline
          </Button>
        </div>
      </form>
      <p className="text-label text-muted-foreground">
        Exact-output redaction is best effort; encoded output can leak.
      </p>
    </section>
  );
}
