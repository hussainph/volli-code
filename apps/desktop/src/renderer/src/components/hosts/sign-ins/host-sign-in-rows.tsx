/**
 * The sign-in rows for one host (VC-702), ported from the lab's
 * `#host-sign-ins` "Per sign-in" direction (PR #745): each row chooses where
 * its sign-in comes from, and the only sentence on the surface is the trust
 * boundary. The add-host Checklist's last step and Settings → Hosts both
 * render this one component (VC-700 PR 3 places it).
 *
 * The rows draw {@link HostSignInSnapshot} and call the controller: nothing
 * here decides policy, holds a credential, or talks to a host.
 */
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";

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
import { Segmented } from "@renderer/components/ui/segmented";
import { Spinner } from "@renderer/components/ui/spinner";
import { cn } from "@renderer/lib/utils";

import type { HostSignInController, HostSignInSnapshot } from "./host-sign-in-controller";
import {
  IDLE,
  statusLine,
  trustLine,
  wantsPaste,
  type RowFlow,
  type SignInRowView,
  type SignInSource,
} from "./host-sign-in-model";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** Reads a controller the React way: one snapshot per change. */
export function useHostSignIns(controller: HostSignInController): HostSignInSnapshot {
  React.useEffect(() => {
    void controller.refresh();
  }, [controller]);
  return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}

export function HostSignInRows({
  hostName,
  snapshot,
  controller,
  className,
}: {
  hostName: string;
  snapshot: HostSignInSnapshot;
  controller: HostSignInController;
  className?: string;
}) {
  // A row's choice of source is the person's, until they make it the row's default holds.
  const [chosen, setChosen] = React.useState<Readonly<Record<string, SignInSource>>>({});
  const rows = snapshot.rows ?? [];
  const sourceOf = (row: SignInRowView): SignInSource => chosen[row.key] ?? row.source;
  const sendsFromMac = rows.some(
    (row) => row.state !== "signed-in" && row.macHasKey && sourceOf(row) === "mac",
  );
  const confirming = rows.find((row) => snapshot.flows[row.key]?.kind === "confirm-send");

  if (snapshot.rows === null) {
    return (
      <div
        className={cn("flex items-center gap-2 px-2 py-4 text-ui text-muted-foreground", className)}
      >
        {snapshot.unreachable ? (
          <>
            <span className="min-w-0 flex-1">{hostName} cannot be reached right now</span>
            {/* Its one recovery (AM2): read the host again. */}
            <Button size="sm" variant="secondary" onClick={() => void controller.refresh()}>
              Retry
            </Button>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-col gap-px rounded-row border border-border/70 bg-muted/30 p-1">
        {rows.map((row) => (
          <SignInRow
            key={row.key}
            row={row}
            flow={snapshot.flows[row.key] ?? IDLE}
            hostName={hostName}
            source={sourceOf(row)}
            onSource={(source) => setChosen((current) => ({ ...current, [row.key]: source }))}
            controller={controller}
          />
        ))}
      </div>
      <AddGitHost controller={controller} />
      <p className="flex items-center gap-1 px-2 text-ui text-muted-foreground">
        <LockSimpleIcon aria-hidden className="size-3.5 shrink-0" />
        {trustLine(hostName, sendsFromMac)}
      </p>
      <SendConfirm
        hostName={hostName}
        row={confirming ?? null}
        onCancel={(row) => controller.cancel(row.key)}
        onConfirm={(row) => void controller.confirmSend(row.id)}
      />
    </div>
  );
}

/** A host name only: the token is pasted in that host's row, never held here. */
function AddGitHost({ controller }: { controller: Pick<HostSignInController, "addGitHost"> }) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  const errorId = React.useId();
  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="self-start text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        Add a git host…
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-1 px-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!controller.addGitHost(value)) {
          setInvalid(true);
          return;
        }
        setValue("");
        setInvalid(false);
        setOpen(false);
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          autoComplete="off"
          aria-label="Git host"
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          placeholder="gitlab.com"
          className="h-8 flex-1 font-mono"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
        />
        <Button size="sm" type="submit" variant="secondary">
          Add
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {invalid ? (
        <p id={errorId} role="alert" className="text-ui text-attention">
          Enter a host name with an optional port.
        </p>
      ) : null}
    </form>
  );
}

/**
 * The confirm before this Mac's key leaves it. Its body is the trust
 * boundary itself, word for word: the person agrees to exactly that.
 */
function SendConfirm({
  hostName,
  row,
  onCancel,
  onConfirm,
}: {
  hostName: string;
  row: SignInRowView | null;
  onCancel: (row: SignInRowView) => void;
  onConfirm: (row: SignInRowView) => void;
}) {
  return (
    <AlertDialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open && row !== null) onCancel(row);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Send this Mac’s {row?.label ?? ""} key to {hostName}?
          </AlertDialogTitle>
          <AlertDialogDescription>{trustLine(hostName, true)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => row !== null && onConfirm(row)}>Send</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One sign-in; its steps open beneath it. */
export function SignInRow({
  row,
  flow,
  hostName,
  source,
  onSource,
  controller,
}: {
  row: SignInRowView;
  flow: RowFlow;
  hostName: string;
  source: SignInSource;
  onSource: (source: SignInSource) => void;
  controller: Pick<
    HostSignInController,
    "requestSend" | "beginKeyEntry" | "submitKey" | "beginSignIn" | "answer" | "cancel" | "openPage"
  >;
}) {
  const open = flow.kind === "key-entry" || flow.kind === "saving" || flow.kind === "signing-in";
  const busy = flow.kind === "sending" || flow.kind === "saving";
  const choosable = row.kind === "provider" && row.macHasKey && row.subscription;
  return (
    <div
      className={cn(
        "rounded-control transition-colors duration-150",
        open && "bg-background shadow-raised",
      )}
      data-row={row.key}
    >
      <div className="flex items-center gap-2 px-2 py-2">
        <ProviderMark id={row.id} name={row.label} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-medium">{row.label}</div>
          <div
            className={cn(
              "flex items-center gap-1 truncate text-ui",
              row.state === "expired" || flow.kind === "failed"
                ? "text-attention"
                : "text-muted-foreground",
            )}
          >
            {row.state === "signed-in" && flow.kind === "idle" ? (
              <CheckIcon weight="bold" className="size-3 text-positive" />
            ) : null}
            <span className="truncate">{statusLine(row, flow, hostName)}</span>
          </div>
        </div>
        {busy ? <Spinner className="text-muted-foreground" /> : null}
        {choosable && !open && !busy ? (
          <Segmented
            ariaLabel={`Where ${row.label} signs in`}
            value={source}
            size="sm"
            options={[
              { key: "mac", label: "This Mac" },
              { key: "host", label: "On host" },
            ]}
            onChange={onSource}
          />
        ) : null}
        {!open && !busy ? <RowAction row={row} source={source} controller={controller} /> : null}
        {open || flow.kind === "failed" ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => controller.cancel(row.key)}
          >
            {flow.kind === "failed" ? "Dismiss" : "Cancel"}
          </Button>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 px-2 pt-1 pb-4 pl-10">
              {flow.kind === "key-entry" || flow.kind === "saving" ? (
                <KeyEntry
                  label={row.kind === "git" ? `Push token for ${row.id}` : `${row.label} API key`}
                  hostName={hostName}
                  disabled={flow.kind === "saving"}
                  onSave={(value) => void controller.submitKey(row, value)}
                />
              ) : null}
              {flow.kind === "signing-in" && flow.deviceCode !== null ? (
                <DeviceCode
                  code={flow.deviceCode.userCode}
                  page={flow.deviceCode.verificationUri}
                  onOpen={() => controller.openPage(flow.deviceCode!.verificationUri)}
                />
              ) : null}
              {wantsPaste(flow) && flow.kind === "signing-in" ? (
                <PasteRedirect
                  prominent={flow.relay === "paste" || flow.relay === "failed"}
                  message={flow.prompt?.message ?? ""}
                  onPaste={(value) => void controller.answer(row.id, value)}
                />
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The one act a row offers at rest, by where its sign-in comes from. */
function RowAction({
  row,
  source,
  controller,
}: {
  row: SignInRowView;
  source: SignInSource;
  controller: Pick<HostSignInController, "requestSend" | "beginKeyEntry" | "beginSignIn">;
}) {
  const again = row.state === "expired";
  const variant = again ? "default" : "secondary";
  if (row.state === "signed-in") return null;
  if (row.kind === "provider" && source === "mac" && row.macHasKey) {
    return (
      <Button size="sm" variant={variant} onClick={() => controller.requestSend(row.id)}>
        Send from this Mac
      </Button>
    );
  }
  if (row.kind === "provider" && row.subscription) {
    return (
      <Button size="sm" variant={variant} onClick={() => controller.beginSignIn(row.id)}>
        {again ? "Sign in again" : "Sign in"}
      </Button>
    );
  }
  if (row.takesKey) {
    return (
      <Button size="sm" variant={variant} onClick={() => controller.beginKeyEntry(row.key)}>
        {again ? "Replace key" : "Add key"}
      </Button>
    );
  }
  return null;
}

/**
 * The code is the thing you compare, so it is drawn large and copyable; the
 * button opens the page you type it into. After that the row waits on its
 * own, and turns signed-in by itself.
 */
function DeviceCode({ code, page, onOpen }: { code: string; page: string; onOpen: () => void }) {
  const [copied, setCopied] = React.useState(false);
  const site = siteOf(page);
  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(code).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
        className="group flex h-9 items-center gap-2 rounded-control border border-dashed border-border px-4 font-mono text-sm tracking-widest transition-colors hover:border-solid hover:bg-muted/50"
        aria-label={`Copy code ${code}`}
      >
        {code}
        <span className="text-muted-foreground">
          {copied ? (
            <CheckIcon weight="bold" className="size-3.5 text-positive" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </span>
      </button>
      <Button size="sm" onClick={onOpen}>
        Open {site}
        <ArrowSquareOutIcon />
      </Button>
    </div>
  );
}

/** The host name of a page, for its button: "accounts.x.ai". */
export function siteOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the provider’s page";
  }
}

function KeyEntry({
  label,
  hostName,
  disabled,
  onSave,
}: {
  label: string;
  hostName: string;
  disabled: boolean;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = React.useState("");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.length > 0) onSave(value);
      }}
    >
      <Input
        autoFocus
        type="password"
        autoComplete="off"
        aria-label={`${label}, stored on ${hostName}`}
        className="h-8 flex-1 font-mono"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button size="sm" type="submit" disabled={disabled || value.length === 0}>
        Save
      </Button>
    </form>
  );
}

/**
 * The paste fallback: the address the browser ended on, or the code the
 * provider showed. Quiet while the relay is listening (it is the backup);
 * the row's whole ask when the relay could not listen.
 */
function PasteRedirect({
  prominent,
  message,
  onPaste,
}: {
  prominent: boolean;
  message: string;
  onPaste: (value: string) => void;
}) {
  const [value, setValue] = React.useState("");
  return (
    <form
      className={cn("flex items-center gap-2", !prominent && "opacity-80")}
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim().length > 0) onPaste(value.trim());
      }}
    >
      <Input
        autoFocus={prominent}
        aria-label={message.length > 0 ? message : "Paste the address your browser ends on"}
        placeholder="http://localhost:…/callback?code=…"
        className="h-8 flex-1 font-mono"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button
        size="sm"
        type="submit"
        variant={prominent ? "default" : "secondary"}
        disabled={value.trim().length === 0}
      >
        Continue
      </Button>
    </form>
  );
}

const PROVIDER_TINT: Record<string, string> = {
  anthropic: "bg-[#d97757]/15 text-[#c4623f]",
  openai: "bg-foreground/10 text-foreground",
  openrouter: "bg-[#6467f2]/15 text-[#5558e3]",
};

/** A monogram, not a logo: Volli redistributes no third-party marks. */
export function ProviderMark({ id, name }: { id: string; name: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-sm font-mono text-ui font-semibold",
        PROVIDER_TINT[id] ?? "bg-muted text-foreground",
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
