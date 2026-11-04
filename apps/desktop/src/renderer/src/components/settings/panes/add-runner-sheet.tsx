import * as React from "react";
import { CONTROL_W } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@renderer/components/ui/dialog";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import { Notice } from "@renderer/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { toastError } from "@renderer/lib/toast";
import { runnerInstallCommand } from "./runner-install-command";
import {
  runnerSetupFailure,
  type InstallGrant,
  type InstallStatus,
  type RunnerSetup,
} from "./runner-setup";

export interface RunnerSheetProps {
  setup: RunnerSetup;
  appVersion: string;
  server: string | null;
  site?: string | null;
  onClose(): void;
  restoreFocus?(): void;
}

export function AddRunnerSheet(props: RunnerSheetProps) {
  const [variant, setVariant] = React.useState<"token" | "environment" | "sudo">("token");
  const variantId = React.useId();
  return (
    <RunnerInstallSheet
      {...props}
      title="Add a runner"
      description="Run this command on your Linux box."
    >
      {(grant, name) => (
        <>
          <div className="flex items-center justify-between gap-4">
            <label htmlFor={variantId} className="text-ui">
              Install command
            </label>
            <Select value={variant} onValueChange={(next) => setVariant(next as typeof variant)}>
              <SelectTrigger id={variantId} className={CONTROL_W.lg}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="token">User install</SelectItem>
                <SelectItem value="environment">Environment variable</SelectItem>
                <SelectItem value="sudo">System install (sudo)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <RunnerCopy
            value={runnerInstallCommand({
              appVersion: props.appVersion,
              token: grant.installToken,
              name,
              server: props.server,
              site: props.site,
              variant,
            })}
            label="Copy command"
          />
        </>
      )}
    </RunnerInstallSheet>
  );
}

/** Shared token lifecycle for the terminal and cloud-init paths. Closing keeps a copied token valid. */
export function RunnerInstallSheet({
  setup,
  appVersion,
  server,
  site,
  onClose,
  restoreFocus,
  title,
  description,
  children,
}: RunnerSheetProps & {
  title: string;
  description: string;
  children: (grant: InstallGrant, name: string) => React.ReactNode;
}) {
  const [name, setName] = React.useState("");
  const [grant, setGrant] = React.useState<InstallGrant | null>(null);
  const [status, setStatus] = React.useState<InstallStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [watchFailed, setWatchFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [expired, setExpired] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (grant === null) return;
    setWatchFailed(false);
    const stop = setup.watch(
      grant.installTokenId,
      (next) => {
        setStatus(next);
        setWatchFailed(false);
      },
      () => setWatchFailed(true),
    );
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, grant.expiresAt - Date.now()),
    );
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, [setup, grant, attempt]);
  const create = async () => {
    try {
      runnerInstallCommand({ appVersion, server, site, name, token: "validation-only" });
    } catch {
      setError("Couldn’t prepare the command. Use a runner name without control characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (grant !== null) await setup.revoke(grant.installTokenId);
      const next = await setup.create(name);
      if (!mounted.current) return;
      setStatus(null);
      setExpired(false);
      setGrant(next);
    } catch (failure) {
      const message = runnerSetupFailure(
        failure,
        "Couldn’t create the install command. Check your connection and try again.",
      );
      if (mounted.current) setError(message);
      else toastError(message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const revoke = async () => {
    if (grant === null) return;
    setBusy(true);
    setError(null);
    try {
      await setup.revoke(grant.installTokenId);
      if (mounted.current) {
        setGrant(null);
        setStatus(null);
      }
    } catch (failure) {
      const message = runnerSetupFailure(failure, "Couldn’t revoke the token. Try again.");
      if (mounted.current) setError(message);
      else toastError(message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const used = status?.state === "used";
  const inactive = status?.state === "expired" || status?.state === "revoked" || (!used && expired);
  const online = used && status.runner?.status === "online" && !watchFailed;
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {grant === null ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void create();
              }}
            >
              <label className="flex flex-col gap-2 text-ui">
                Runner name
                <Input
                  autoFocus
                  value={name}
                  maxLength={80}
                  placeholder="Use the box’s hostname"
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <Button type="submit" disabled={busy}>
                {busy ? <LoadingLabel>Creating</LoadingLabel> : "Create install command"}
              </Button>
            </form>
          ) : online ? (
            <p role="status" className="text-ui text-positive">
              {status.runner!.name} is online. Pick it in the composer.
            </p>
          ) : (
            <>
              {!inactive && !used ? (
                <>
                  {children(grant, name)}
                  <p className="text-ui text-muted-foreground">
                    One use, valid for 1 hour. Keep this token private. Closing this sheet does not
                    revoke it.
                  </p>
                </>
              ) : null}
              <p role="status" className="text-ui text-muted-foreground">
                {inactive ? (
                  "This token has expired or been revoked."
                ) : used ? (
                  <LoadingLabel>
                    {`${status.runner?.name ?? "Runner"} is linked. Waiting for it to come online`}
                  </LoadingLabel>
                ) : (
                  <LoadingLabel>Waiting for the box</LoadingLabel>
                )}
              </p>
              {watchFailed ? (
                <Notice
                  tone="error"
                  title="Couldn’t read the runner’s status."
                  announce
                  actions={
                    <Button variant="outline" size="xs" onClick={() => setAttempt((n) => n + 1)}>
                      Retry status
                    </Button>
                  }
                />
              ) : null}
            </>
          )}
          {busy ? (
            <p role="status" className="text-ui text-muted-foreground">
              You can close this sheet. Your request may still finish.
            </p>
          ) : null}
          {error === null ? null : <Notice tone="error" title={error} announce />}
        </DialogBody>
        {grant === null ? null : (
          <DialogFooter>
            {!used && !inactive ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void revoke()}>
                Revoke token
              </Button>
            ) : null}
            {inactive ? (
              <Button size="sm" disabled={busy} onClick={() => void create()}>
                Create a fresh command
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={onClose}>
              Done
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RunnerCopy({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setCopied(false);
    setFailed(false);
  }, [value]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <pre className="max-h-64 overflow-auto rounded-control border border-border bg-muted p-4 font-mono text-ui break-all whitespace-pre-wrap select-text">
        {value}
      </pre>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setFailed(false);
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(value))
            .then(
              () => setCopied(true),
              () => setFailed(true),
            );
        }}
      >
        {copied ? "Copied" : label}
      </Button>
      {failed ? (
        // No "Copy error" beside it: the clipboard just refused this sheet.
        <Notice
          tone="error"
          title="Couldn’t copy. Select the text and copy it manually."
          copyText=""
          announce
        />
      ) : null}
    </div>
  );
}
