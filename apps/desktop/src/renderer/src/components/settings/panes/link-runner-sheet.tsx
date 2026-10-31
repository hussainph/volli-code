import * as React from "react";
import { Button } from "@renderer/components/ui/button";
import { toastError } from "@renderer/lib/toast";
import { Input } from "@renderer/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@renderer/components/ui/dialog";
import { runnerSetupFailure, type LinkPreview, type RunnerSetup } from "./runner-setup";

export function LinkRunnerSheet({
  setup,
  onClose,
  restoreFocus,
}: {
  setup: RunnerSetup;
  onClose(): void;
  restoreFocus?(): void;
}) {
  const [code, setCode] = React.useState("");
  const [preview, setPreview] = React.useState<Extract<LinkPreview, { ok: true }> | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<"approve" | "deny" | null>(null);
  const [expired, setExpired] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (preview === null) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, preview.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [preview]);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await setup.preview(code.trim());
      if (!mounted.current) return;
      if (answer.ok) {
        setExpired(false);
        setPreview(answer);
      } else
        setError(
          answer.code === "rate_limited"
            ? "Too many attempts. Wait a minute before trying again."
            : "That code is invalid or expired. Get a new code from the runner.",
        );
    } catch (failure) {
      const message = runnerSetupFailure(
        failure,
        "Couldn’t check that code. Check your connection and try again.",
      );
      if (mounted.current) setError(message);
      else toastError(message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const decide = async (decision: "approve" | "deny") => {
    if (preview === null) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await setup.decide(preview.requestId, code.trim(), decision);
      if (!mounted.current) return;
      if (answer.ok) setDone(decision);
      else {
        setPreview(null);
        setError("That request is no longer available. Get a new code from the runner.");
      }
    } catch (failure) {
      const message = runnerSetupFailure(
        failure,
        "Couldn’t save your decision. Check your connection and try again.",
      );
      if (mounted.current) setError(message);
      else toastError(message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (restoreFocus) {
            event.preventDefault();
            restoreFocus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Link a runner</DialogTitle>
          <DialogDescription>
            Enter the code shown by volli-runner link on your machine.
          </DialogDescription>
        </DialogHeader>
        {done !== null ? (
          <>
            <p role="status" className="text-ui">
              {done === "approve"
                ? `${preview?.hostname} is approved. Waiting for the runner to finish linking.`
                : "Link request denied."}
            </p>
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </>
        ) : preview === null ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && code.trim()) void check();
            }}
          >
            <label className="flex flex-col gap-2 text-ui">
              Runner code
              <Input
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="ABCD-EFGH"
                maxLength={32}
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <Button type="submit" disabled={busy || !code.trim()}>
              {busy ? "Checking…" : "Check code"}
            </Button>
          </form>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-2 text-ui">
              <dt className="text-muted-foreground">Machine</dt>
              <dd className="break-all">{preview.hostname}</dd>
              <dt className="text-muted-foreground">System</dt>
              <dd>
                {preview.distro ?? preview.os} · {preview.arch}
              </dd>
              <dt className="text-muted-foreground">IP address</dt>
              <dd>{preview.ip ?? "Not reported"}</dd>
              <dt className="text-muted-foreground">Requested</dt>
              <dd>{new Date(preview.requestedAt).toLocaleString()}</dd>
            </dl>
            <p className="text-ui text-muted-foreground">
              Only approve a machine you own. This machine will run your Sessions with your GitHub
              access and your model connections. Its reported name and IP are hints, not proof of
              identity.
            </p>
            {expired ? (
              <p role="alert" className="text-ui text-destructive">
                This code has expired. Get a new code from the runner.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setError(null);
                }}
              >
                Another code
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || expired}
                onClick={() => void decide("deny")}
              >
                Deny
              </Button>
              <Button size="sm" disabled={busy || expired} onClick={() => void decide("approve")}>
                Approve runner
              </Button>
            </div>
          </>
        )}
        {busy ? (
          <p role="status" className="text-ui text-muted-foreground">
            You can close this sheet. Your request may still finish.
          </p>
        ) : null}
        {error === null ? null : (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
