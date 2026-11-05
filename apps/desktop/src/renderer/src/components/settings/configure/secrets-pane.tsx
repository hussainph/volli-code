import { LoadingLabel } from "@renderer/components/ui/loading-label";
/** Credential inventory is metadata-only; replacement is a write-only IPC. */
import * as React from "react";
import { KeyIcon, MoreIcon, EditIcon, DeleteIcon } from "@renderer/components/ui/icon";

import type { Project } from "@volli/shared";
import type { CredentialStatus, SecretMetadata } from "../../../../../ipc/secrets";

import { AsyncSection, DataTable, Cell, SectionAction } from "@renderer/components/settings/kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { toastError } from "@renderer/lib/toast";

export function SecretsPane({ project }: { project: Project }) {
  const [secrets, setSecrets] = React.useState<readonly SecretMetadata[]>([]);
  const [credentials, setCredentials] = React.useState<CredentialStatus | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [editing, setEditing] = React.useState<SecretMetadata | null>(null);
  const [revoking, setRevoking] = React.useState<SecretMetadata | null>(null);
  const revokeLatch = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);

  React.useEffect(() => {
    let current = true;
    setStatus("loading");
    setSecrets([]);
    setCredentials(null);
    void (async () => {
      try {
        const result = await window.api.secrets.list(project.id);
        if (!current) return;
        if (!result.ok) throw new Error("Credential metadata unavailable");
        setSecrets(result.secrets);
        setCredentials(result.credentials);
        setStatus("ready");
      } catch {
        if (!current) return;
        setStatus("error");
      }
    })();
    return () => {
      current = false;
    };
  }, [project.id, revision]);

  async function revoke() {
    if (!revoking || revokeLatch.current) return;
    revokeLatch.current = true;
    setBusy(true);
    try {
      const result = await window.api.secrets.revoke(revoking.id);
      if (!result.ok) throw new Error("Refused");
      setRevoking(null);
      refresh();
    } catch {
      toastError("Couldn't revoke the credential.");
    } finally {
      revokeLatch.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <AsyncSection
        title="Secrets"
        icon={KeyIcon}
        action={status === "ready" ? <SectionAction label="Refresh" onAct={refresh} /> : undefined}
        state={
          status === "loading"
            ? { status: "loading" }
            : status === "error"
              ? { status: "error", message: "Couldn't load credentials.", onRetry: refresh }
              : { status: "ready", data: secrets }
        }
        before={
          credentials !== null && LOCKED_LINE[credentials.state] !== undefined ? (
            <LockedCredentials
              line={REASON_LINE[credentials.reason ?? ""] ?? LOCKED_LINE[credentials.state]!}
              resettable={
                credentials.state !== "refused" &&
                credentials.reason !== "busy" &&
                credentials.reason !== "lock-unusable"
              }
              onChanged={refresh}
            />
          ) : undefined
        }
      >
        {(items) =>
          items.length === 0 &&
          credentials !== null &&
          LOCKED_LINE[credentials.state] !== undefined ? null : (
            <DataTable
              label="Saved credentials"
              items={items}
              keyOf={(s) => s.id}
              search={(s) => `${s.name} ${scopeLabel(s)}`}
              placeholder="Search secrets"
              minWidth={600}
              empty="No secrets"
              emptyIllustration="secret"
              columns={[
                { key: "name", header: "Name", cell: (s) => <Cell strong>{s.name}</Cell> },
                {
                  key: "scope",
                  header: "Scope",
                  width: "6rem",
                  cell: (s) => <Cell muted>{scopeLabel(s)}</Cell>,
                },
                {
                  key: "used",
                  header: "Last used",
                  width: "9rem",
                  cell: (s) => (
                    <Cell muted>
                      {s.lastUsedAt === null ? "Never" : new Date(s.lastUsedAt).toLocaleString()}
                    </Cell>
                  ),
                },
                {
                  key: "value",
                  header: "Value",
                  width: "8rem",
                  cell: (s) => (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Replace ${s.name}`}
                      onClick={() => setEditing(s)}
                    >
                      <span className="font-mono">••••••••</span>
                    </Button>
                  ),
                },
                {
                  key: "actions",
                  header: "Actions",
                  headerHidden: true,
                  width: "2.5rem",
                  align: "end",
                  cell: (s) => (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`More actions for ${s.name}`}
                        >
                          <MoreIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(s)}>
                          <EditIcon />
                          Replace
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setRevoking(s)}>
                          <DeleteIcon />
                          Revoke…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ),
                },
              ]}
            />
          )
        }
      </AsyncSection>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Replace {editing?.name}</DialogTitle>
          </DialogHeader>
          {editing && (
            <SecretEditor
              key={editing.id}
              secret={editing}
              onChanged={() => {
                setEditing(null);
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents using this {revoking ? scopeLabel(revoking).toLowerCase() : "saved"} credential
              will need you to enter it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={busy} onClick={() => void revoke()}>
              {busy ? <LoadingLabel>Revoking</LoadingLabel> : "Revoke"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
function scopeLabel(secret: SecretMetadata) {
  return { session: "Session", project: "Project", always: "Always" }[secret.scope];
}

/** One line per state that keeps stored secrets out of use (VC-641). */
const LOCKED_LINE: Partial<Record<CredentialStatus["state"], string>> = {
  locked: "Saved secrets are locked.",
  refused: "Saved secrets can't be used until their key file is private.",
  corrupt: "Saved secrets can't be read.",
};

/**
 * Reasons that are not the store's own problem (VC-642): another Volli process
 * holding the lock for a moment, or a lock file to fix. Neither offers Reset:
 * the saved secrets may be perfectly good.
 */
const REASON_LINE: Partial<Record<string, string>> = {
  busy: "Saved secrets are busy in another Volli process.",
  "lock-unusable": "Saved secrets can't be used until their lock file is repaired.",
};

function LockedCredentials({
  line,
  resettable,
  onChanged,
}: {
  line: string;
  /** A refused key configuration or a lock problem is fixed, never reset (VC-641, VC-642). */
  resettable: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  async function act(kind: "unlock" | "reset"): Promise<void> {
    setBusy(true);
    try {
      const result =
        kind === "unlock" ? await window.api.secrets.unlock() : await window.api.secrets.reset();
      if (!result.ok) throw new Error("Credential action failed");
      if (kind === "unlock" && LOCKED_LINE[result.credentials.state] !== undefined) {
        toastError("Saved secrets are still locked.");
      }
    } catch {
      toastError(
        kind === "unlock" ? "Couldn't unlock saved secrets." : "Couldn't reset saved secrets.",
      );
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <div
      data-slot="secret-credentials-status"
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-4"
    >
      <p className="text-ui">{line}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => void act("unlock")}>
          Try again
        </Button>
        {resettable ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Reset…
          </Button>
        ) : null}
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset saved secrets?</AlertDialogTitle>
            <AlertDialogDescription>
              This sets aside saved Project and Always secrets. You will need to enter them again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void act("reset");
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SecretEditor({ secret, onChanged }: { secret: SecretMetadata; onChanged: () => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  const latch = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const fieldId = React.useId();
  React.useEffect(() => {
    const field = input.current;
    return () => {
      if (field) field.value = "";
    };
  }, []);

  async function act(kind: "replace" | "revoke"): Promise<void> {
    if (latch.current) return;
    const value = kind === "replace" ? (input.current?.value ?? "") : "";
    if (input.current !== null) input.current.value = "";
    if (kind === "replace" && value.length === 0) {
      toastError("Enter a replacement credential first.");
      return;
    }
    latch.current = true;
    setBusy(true);
    try {
      const result =
        kind === "replace"
          ? await window.api.secrets.replace({ id: secret.id, value })
          : await window.api.secrets.revoke(secret.id);
      if (!result.ok) throw new Error("Credential action failed");
      onChanged();
    } catch {
      toastError(
        kind === "replace" ? "Couldn't replace the credential." : "Couldn't revoke the credential.",
      );
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void act("replace");
      }}
    >
      <label htmlFor={fieldId} className="text-ui font-medium">
        Replacement credential
      </label>
      <Input
        ref={input}
        id={fieldId}
        type="password"
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
      <Button type="submit" disabled={busy}>
        {busy ? <LoadingLabel>Replacing</LoadingLabel> : "Replace"}
      </Button>
    </form>
  );
}
