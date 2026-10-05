/** Credential inventory is metadata-only; replacement is a write-only IPC. */
import * as React from "react";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import type { Project } from "@volli/shared";
import type { CredentialStatus, SecretMetadata } from "../../../../../ipc/secrets";

import { Empty, PrefSection, SectionAction } from "@renderer/components/settings/kit";
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
import { toastError } from "@renderer/lib/toast";

export function SecretsPane({ project }: { project: Project }) {
  const [secrets, setSecrets] = React.useState<readonly SecretMetadata[]>([]);
  const [credentials, setCredentials] = React.useState<CredentialStatus | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
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
        toastError("Couldn't load credentials.");
      }
    })();
    return () => {
      current = false;
    };
  }, [project.id, revision]);

  return (
    <PrefSection
      title="Secrets"
      icon={KeyIcon}
      action={<SectionAction label="Refresh" onAct={refresh} />}
    >
      {credentials !== null && LOCKED_LINE[credentials.state] !== undefined ? (
        <LockedCredentials
          line={LOCKED_LINE[credentials.state]!}
          resettable={credentials.state !== "refused"}
          onChanged={refresh}
        />
      ) : null}
      {status === "loading" ? (
        <Empty>Loading credentials…</Empty>
      ) : status === "error" ? (
        <Empty>Couldn't load credentials. Refresh to try again.</Empty>
      ) : secrets.length === 0 ? (
        <Empty>No saved credentials</Empty>
      ) : (
        secrets.map((secret) => <SecretRow key={secret.id} secret={secret} onChanged={refresh} />)
      )}
    </PrefSection>
  );
}

/** One line per state that keeps stored secrets out of use (VC-641). */
const LOCKED_LINE: Partial<Record<CredentialStatus["state"], string>> = {
  locked: "Saved secrets are locked.",
  refused: "Saved secrets are refused: their key file is not private.",
  corrupt: "Saved secrets can't be read.",
};

function LockedCredentials({
  line,
  resettable,
  onChanged,
}: {
  line: string;
  /** A refused key configuration is fixed, never reset (VC-641). */
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
              Project and Always secrets are set aside, not deleted, and you enter them again.
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

function SecretRow({ secret, onChanged }: { secret: SecretMetadata; onChanged: () => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  const latch = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const fieldId = React.useId();
  const scope = { session: "Session", project: "Project", always: "Always" }[secret.scope];

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
    <div
      data-slot="secret-inventory-row"
      className="flex flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-ui font-medium">{secret.name}</p>
          <p className="text-label text-muted-foreground">
            Scope: {scope} · Last used:{" "}
            {secret.lastUsedAt === null ? "Never" : new Date(secret.lastUsedAt).toLocaleString()}
          </p>
        </div>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void act("revoke")}>
          Revoke
        </Button>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act("replace");
        }}
      >
        <label htmlFor={fieldId} className="text-ui">
          Replacement credential
        </label>
        <Input
          ref={input}
          id={fieldId}
          type="password"
          className="w-64"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <Button type="submit" disabled={busy}>
          Replace
        </Button>
      </form>
    </div>
  );
}
