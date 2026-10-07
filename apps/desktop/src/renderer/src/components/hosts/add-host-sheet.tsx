/**
 * Add a host over SSH (VC-700 PR 3; VC-615 flow 1, ported from the lab's
 * `#host-add` in its "Checklist" direction, the owner's pick).
 *
 * Type `you@box` (or a `~/.ssh/config` alias) and Connect; desktop main
 * connects, checks the system, uploads and installs Volli host, starts it,
 * pairs this Mac and opens the connection, streaming each step here. A step
 * reads as a noun while it waits and a verb while it runs; a stopped flow
 * says one line and offers one recovery plus Back; the log is one click away
 * under Details. It ends on the host's facts: when it starts on its own (a
 * Mac's at login) and, for an install without sudo, that its agents share
 * your account.
 *
 * Mounted only while `cloud` is on (`HostsChrome`). "Pair with a code…" is
 * VC-575's and stays out; so do the lab's sign-ins and transport choice
 * (VC-702, and Tailscale later).
 */
import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import type { AddHostLogLine, RemoteHost } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { remoteHostOf, remoteHosts, useRemoteHostsStore } from "@renderer/stores/remote-hosts";

import {
  cancelNeedsConfirmation,
  changedHostKeyCommand,
  flowBadge,
  questionPrompt,
  readyFacts,
  readySummary,
  stepRows,
  validTarget,
  type AddHostFlowView,
  type QuestionPrompt,
} from "./add-host-model";
import { EASE_OUT, HostGlyph, StepMark, SwapText, useMotionTiming } from "./host-parts";
import { useAddHostFlow, type AddHostFlow, type NumberedLogLine } from "./use-add-host-flow";

/** The sheet, open while the remote-hosts store says so. */
export function AddHostSheet() {
  const open = useRemoteHostsStore((state) => state.addHost.open);
  const target = useRemoteHostsStore((state) => state.addHost.target);
  // Visibility does not own the flow. Keep following while the body is detached.
  const flow = useAddHostFlow(remoteHosts(), target, toastError);
  const { phase, setTarget, resetFinished, reattach } = flow;
  React.useEffect(() => {
    if (open) {
      setTarget(target);
      reattach();
    } else resetFinished();
  }, [open, target, setTarget, resetFinished, reattach]);
  React.useEffect(() => {
    useRemoteHostsStore.setState({
      addHostActivity:
        phase.kind === "flow" && phase.view?.status !== "cancelled"
          ? {
              name: phase.view?.name ?? phase.target,
              status: phase.lost ? "failed" : (phase.view?.status ?? "running"),
            }
          : phase.kind === "entry" && phase.starting
            ? { name: phase.target, status: "running" }
            : null,
    });
  }, [phase]);
  React.useEffect(() => () => useRemoteHostsStore.setState({ addHostActivity: null }), []);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        useRemoteHostsStore.getState().closeAddHost();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        // Anchored from the top, not centred: the sheet changes height as
        // the flow moves, and a centred sheet would move its title each time.
        // Capped to the window: its middle scrolls, its footer always shows.
        // Arrives as the lab's does (260 ms, from .96 and 8 px low), leaves faster.
        className={cn(
          "top-[14vh] flex max-h-[80vh] max-w-[30rem] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[30rem]",
          "data-[state=open]:duration-[260ms] data-[state=open]:zoom-in-96 data-[state=open]:slide-in-from-bottom-2",
          "data-[state=closed]:duration-150 data-[state=closed]:zoom-out-98 data-[state=closed]:slide-out-to-bottom-1",
        )}
      >
        <MotionConfig reducedMotion="user">
          {open ? <AddHostBody flow={flow} /> : null}
        </MotionConfig>
      </DialogContent>
    </Dialog>
  );
}

function AddHostBody({ flow }: { flow: AddHostFlow }) {
  const { phase } = flow;
  return (
    // The address and the checklist cross over: one lets go, the other settles.
    <AnimatePresence initial={false} mode="popLayout">
      <Screen key={phase.kind}>
        {phase.kind === "entry" ? (
          <EntryScreen
            flow={flow}
            target={phase.target}
            error={phase.error}
            starting={phase.starting}
          />
        ) : (
          <FlowScreen
            flow={flow}
            target={phase.target}
            view={phase.view === null ? null : { ...phase.view, facts: phase.facts }}
            log={phase.log}
            omitted={phase.omitted}
            lost={phase.lost}
            busy={phase.busy}
            cancelling={phase.cancelling}
          />
        )}
      </Screen>
    </AnimatePresence>
  );
}

/**
 * Screen to screen inside the sheet, the lab's: the old lets go at once, the
 * new settles in from a little below. A motion element, so `popLayout` takes
 * the old one out of flow while it fades.
 */
function Screen({ children, ref }: { children: React.ReactNode; ref?: React.Ref<HTMLDivElement> }) {
  const timed = useMotionTiming();
  return (
    <motion.div
      ref={ref}
      className="flex min-h-0 flex-1 flex-col"
      initial={{ opacity: 0, y: 6, filter: "blur(2px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, transition: timed({ duration: 0.1 }) }}
      transition={timed({ duration: 0.24, ease: EASE_OUT, delay: 0.04 })}
    >
      {children}
    </motion.div>
  );
}

/* ── The address ───────────────────────────────────────────────────────── */

function EntryScreen({
  flow,
  target,
  error,
  starting,
}: {
  flow: AddHostFlow;
  target: string;
  error: string | null;
  starting: boolean;
}) {
  const valid = validTarget(target);
  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) flow.connect();
      }}
    >
      <div className="px-6 pt-6 pb-4">
        <DialogTitle>Add a host</DialogTitle>
      </div>
      <div className="flex flex-col gap-2 px-6 pb-4">
        <div className="relative">
          <TerminalWindowIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            aria-label="SSH destination"
            aria-invalid={error !== null || undefined}
            value={target}
            placeholder="user@host"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-9 pl-9 font-mono text-sm"
            onChange={(event) => flow.setTarget(event.target.value)}
          />
        </div>
        <p
          className={cn(
            "px-1 text-ui",
            error === null ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {error ?? "Uses this Mac’s ssh: your keys, agent and ~/.ssh/config."}
        </p>
      </div>
      <div className="flex items-center justify-end border-t border-border/60 px-4 py-4">
        <Button size="sm" type="submit" disabled={!valid || starting}>
          Connect
        </Button>
      </div>
    </form>
  );
}

/* ── The checklist ─────────────────────────────────────────────────────── */

function FlowScreen({
  flow,
  target,
  view,
  log,
  omitted,
  lost,
  busy,
  cancelling,
}: {
  flow: AddHostFlow;
  target: string;
  view: AddHostFlowView | null;
  log: readonly NumberedLogLine[];
  omitted: number;
  lost: boolean;
  busy: boolean;
  cancelling: boolean;
}) {
  const timed = useMotionTiming();
  const hosts = useRemoteHostsStore((state) => state.hosts);
  const [details, setDetails] = React.useState(false);
  const [confirm, setConfirm] = React.useState<"back" | "cancel" | null>(null);
  React.useEffect(() => setConfirm(null), [view?.question?.id, view?.status, view?.failure?.code]);
  // Whether the sudo field has text: "Run it" waits for some. Never the text itself.
  const [hasPassword, setHasPassword] = React.useState(false);
  const questionId = view?.question?.id ?? null;
  React.useEffect(() => setHasPassword(false), [questionId]);
  const name = view?.name ?? target;
  const done = view?.status === "done";
  const host = remoteHostOf(hosts, view?.hostId ?? null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-4 px-6 pt-6 pb-4">
        <HostGlyph
          // The OS as soon as the check finds it, not only once the host is kept.
          os={host?.os ?? view?.facts.os ?? null}
          size="md"
          badge={view === null ? null : flowBadge(view)}
        />
        <div className="min-w-0">
          <DialogTitle className="truncate">
            <SwapText>
              {done
                ? host?.reachability?.state.status === "ready"
                  ? `${name} is ready`
                  : `${name} · Connected over SSH`
                : name}
            </SwapText>
          </DialogTitle>
          <DialogDescription className={cn("truncate text-ui", !done && "font-mono")}>
            {done && view !== null ? readySummary(view, host) : target}
          </DialogDescription>
        </div>
      </div>
      {done && view !== null ? (
        <ReadyBody view={view} host={host} />
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto" data-slot="add-host-body">
            <ol aria-label="Steps" className="flex flex-col px-6 pb-4">
              {view === null
                ? null
                : stepRows(view).map((row) => (
                    <li key={row.id} className="flex h-8 items-center gap-2" data-step={row.id}>
                      <StepMark status={row.mark} />
                      <SwapText
                        className={cn(
                          "min-w-0 flex-1 text-ui transition-colors duration-200",
                          row.mark === "pending" ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {row.label}
                      </SwapText>
                      {row.detail === null ? null : (
                        <span className="shrink-0 text-ui text-muted-foreground">{row.detail}</span>
                      )}
                    </li>
                  ))}
            </ol>
            <Stopped
              flow={flow}
              view={view}
              name={name}
              lost={lost}
              busy={busy || cancelling || confirm !== null}
              onPasswordText={setHasPassword}
            />
            <AnimatePresence initial={false}>
              {details ? (
                <motion.div
                  key="log"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={timed({ duration: 0.16 })}
                  className="px-6 pb-4"
                >
                  <LogView lines={log} omitted={omitted} detail={view?.failure?.detail ?? null} />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-4">
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              aria-expanded={details}
              onClick={() => setDetails((value) => !value)}
            >
              Details
              <CaretDownIcon
                className={cn(
                  "size-3 transition-transform duration-200 ease-out motion-reduce:transition-none",
                  details && "rotate-180",
                )}
              />
            </Button>
            <span className="flex-1" />
            <Actions
              flow={flow}
              view={view}
              name={name}
              lost={lost}
              busy={busy || cancelling}
              hasPassword={hasPassword}
              confirm={confirm}
              setConfirm={setConfirm}
              cancelling={cancelling}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** The one line a stopped flow says, and whatever it needs typed or compared. */
function Stopped({
  flow,
  view,
  name,
  lost,
  busy,
  onPasswordText,
}: {
  flow: AddHostFlow;
  view: AddHostFlowView | null;
  name: string;
  lost: boolean;
  busy: boolean;
  onPasswordText: (has: boolean) => void;
}) {
  const timed = useMotionTiming();
  let body: React.ReactNode = null;
  if (lost) {
    body = <Line tone="error">Lost track of this add. Close and re-open to reconnect.</Line>;
  } else if (view?.status === "failed" && view.failure !== null) {
    const command =
      view.failure.code === "host-key-changed"
        ? changedHostKeyCommand(view.target, view.failure.detail)
        : null;
    body = (
      <>
        <Line tone="error">{view.failure.line}</Line>
        {command === null ? null : <CommandLine command={command} />}
      </>
    );
  } else if (view?.status === "question" && view.question !== null) {
    body = (
      <QuestionBody
        prompt={questionPrompt(view.question, name)}
        flow={flow}
        busy={busy}
        onPasswordText={onPasswordText}
      />
    );
  }
  return (
    <AnimatePresence initial={false}>
      {body === null ? null : (
        <motion.div
          key={view?.question?.kind ?? view?.failure?.code ?? (lost ? "lost" : "none")}
          className="flex flex-col gap-2 px-6 pb-4"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={timed({ duration: 0.22, ease: EASE_OUT, delay: 0.06 })}
        >
          {body}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Line({ tone, children }: { tone: "error" | "attention"; children: React.ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn("text-ui", tone === "error" ? "text-destructive" : "text-attention")}
    >
      {children}
    </p>
  );
}

function QuestionBody({
  prompt,
  flow,
  busy,
  onPasswordText,
}: {
  prompt: QuestionPrompt;
  flow: AddHostFlow;
  busy: boolean;
  onPasswordText: (has: boolean) => void;
}) {
  switch (prompt.kind) {
    case "host-key":
      return (
        <>
          <Line tone="attention">{prompt.line}</Line>
          <ul aria-label="Host key fingerprints" className="flex flex-col gap-1">
            {prompt.fingerprints.map((entry) => (
              <li key={entry.fingerprint} className="flex items-start gap-2 text-ui">
                <span className="w-16 shrink-0 text-muted-foreground">{entry.type}</span>
                {/* Whole, and selectable: a fingerprint is compared character by character. */}
                <span className="min-w-0 font-mono break-all select-text">{entry.fingerprint}</span>
              </li>
            ))}
          </ul>
          <p className="text-ui text-muted-foreground">
            Compare it with the host’s own before you trust it.
          </p>
        </>
      );
    case "existing-hostd":
    case "identity-changed":
      return (
        <>
          <Line tone="attention">{prompt.line}</Line>
          <p className="text-ui text-muted-foreground">{prompt.note}</p>
        </>
      );
    case "already-paired":
    case "unknown":
      return <Line tone="attention">{prompt.line}</Line>;
    case "sudo-password":
      return <SudoBody prompt={prompt} flow={flow} busy={busy} onPasswordText={onPasswordText} />;
  }
}

/** sudo's command, and its password: straight to main, never kept here. */
function SudoBody({
  prompt,
  flow,
  busy,
  onPasswordText,
}: {
  prompt: Extract<QuestionPrompt, { kind: "sudo-password" }>;
  flow: AddHostFlow;
  busy: boolean;
  /** Whether the field has text: all its owner learns of it. */
  onPasswordText: (has: boolean) => void;
}) {
  // Uncontrolled: the password lives in the field alone, never in React state
  // or props. Submit reads it once, clears the field, and hands it to main.
  const field = React.useRef<HTMLInputElement>(null);
  const submit = () => {
    const input = field.current;
    if (input === null || input.value.length === 0 || busy) return;
    const password = input.value;
    input.value = "";
    onPasswordText(false);
    flow.sudoPassword(password);
  };
  return (
    <>
      <Line tone={prompt.retry ? "error" : "attention"}>{prompt.line}</Line>
      <CommandLine command={prompt.command} />
      <form
        id="add-host-sudo"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          ref={field}
          autoFocus
          type="password"
          autoComplete="off"
          aria-label={prompt.placeholder}
          placeholder={prompt.placeholder}
          className="h-9 text-sm"
          defaultValue=""
          disabled={busy}
          onInput={(event) => onPasswordText(event.currentTarget.value.length > 0)}
        />
      </form>
      {prompt.userInstall === null ? null : (
        <p className="flex items-start gap-2 text-ui text-muted-foreground">
          <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>No sudo? Install it for your account only. {prompt.userInstall.note}</span>
        </p>
      )}
    </>
  );
}

/** The footer's buttons: the stopped flow's recovery and Back, or Cancel while it runs. */
function Actions({
  flow,
  view,
  name,
  lost,
  busy,
  hasPassword,
  confirm,
  setConfirm,
  cancelling,
}: {
  flow: AddHostFlow;
  view: AddHostFlowView | null;
  name: string;
  lost: boolean;
  busy: boolean;
  /** The sudo field has text: "Run it" waits for some. */
  hasPassword: boolean;
  confirm: "back" | "cancel" | null;
  setConfirm: (intent: "back" | "cancel" | null) => void;
  cancelling: boolean;
}) {
  const close = useRemoteHostsStore.getState().closeAddHost;
  const cancel = () => flow.leave(close);
  const request = (intent: "back" | "cancel") => {
    if (lost || cancelNeedsConfirmation(view)) setConfirm(intent);
    else if (intent === "back") flow.back();
    else void cancel();
  };
  if (confirm !== null)
    return (
      <div
        role="group"
        aria-label={`Cancel adding ${name}?`}
        className="flex flex-wrap items-center justify-end gap-2"
      >
        <p className="w-full text-ui text-attention">
          Cancel adding {name}? Files already uploaded or installed stay on the host.
        </p>
        <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => setConfirm(null)}>
          Keep going
        </Button>
        <Button
          size="sm"
          disabled={cancelling}
          onClick={() => {
            setConfirm(null);
            if (confirm === "back") flow.back();
            else void cancel();
          }}
        >
          Cancel add
        </Button>
      </div>
    );
  // answer/retry stays outstanding while main runs the resumed steps.
  // Cancellation is an independent intent even before its next view arrives.
  if (busy && !lost)
    return (
      <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => request("cancel")}>
        Cancel
      </Button>
    );
  const back = (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => request("back")}>
      Back
    </Button>
  );
  if (lost) {
    return (
      <>
        <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => request("cancel")}>
          Cancel
        </Button>
        <Button size="sm" onClick={close}>
          Close
        </Button>
      </>
    );
  }
  if (view?.status === "failed" && view.failure !== null) {
    const { recovery } = view.failure;
    return recovery.action === "retry" ? (
      <>
        {back}
        <Button size="sm" disabled={busy} onClick={() => flow.retry(recovery.from)}>
          {recovery.label}
        </Button>
      </>
    ) : (
      <Button size="sm" onClick={() => request("back")}>
        {recovery.label}
      </Button>
    );
  }
  if (view?.status === "question" && view.question !== null) {
    const prompt = questionPrompt(view.question, name);
    switch (prompt.kind) {
      case "host-key":
        return (
          <>
            {back}
            <Button
              size="sm"
              disabled={busy}
              onClick={() => flow.answer({ kind: "accept-host-key" })}
            >
              {prompt.action}
            </Button>
          </>
        );
      case "existing-hostd":
        return (
          <>
            {prompt.adopt === null ? (
              back
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => flow.answer({ kind: "adopt" })}
              >
                {prompt.adopt}
              </Button>
            )}
            <Button size="sm" disabled={busy} onClick={() => flow.answer({ kind: "update" })}>
              {prompt.action}
            </Button>
          </>
        );
      case "already-paired":
        return (
          <>
            {back}
            <Button size="sm" disabled={busy} onClick={() => flow.answer({ kind: "open" })}>
              {prompt.action}
            </Button>
          </>
        );
      case "identity-changed":
        return (
          <>
            {back}
            <Button size="sm" disabled={busy} onClick={() => flow.answer({ kind: "repair" })}>
              {prompt.action}
            </Button>
          </>
        );
      case "sudo-password":
        return (
          <>
            {prompt.userInstall === null ? (
              back
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => flow.answer({ kind: "user-install" })}
              >
                {prompt.userInstall.label}
              </Button>
            )}
            <Button size="sm" type="submit" form="add-host-sudo" disabled={busy || !hasPassword}>
              {prompt.action}
            </Button>
          </>
        );
      case "unknown":
        return back;
    }
  }
  return (
    <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => request("cancel")}>
      Cancel
    </Button>
  );
}

/* ── Ready ─────────────────────────────────────────────────────────────── */

function ReadyBody({ view, host }: { view: AddHostFlowView; host: RemoteHost | undefined }) {
  const timed = useMotionTiming();
  const facts = readyFacts(view, host);
  return (
    <motion.div
      className="flex min-h-0 flex-col"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={timed({ duration: 0.28, ease: EASE_OUT, delay: 0.12 })}
    >
      {facts.length === 0 ? null : (
        <ul aria-label="About this host" className="flex flex-col gap-1 px-6 pb-4">
          {facts.map((fact) => (
            <li key={fact} className="flex items-center gap-2 text-ui text-muted-foreground">
              <InfoIcon aria-hidden className="size-3.5 shrink-0" />
              {fact}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-4">
        {host === undefined ? null : (
          // The next step after adding a box (VC-710): a project on it.
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const store = useRemoteHostsStore.getState();
              store.closeAddHost();
              store.openProjectSheet(host.id);
            }}
          >
            Open a project on {host.name}…
          </Button>
        )}
        <Button size="sm" autoFocus onClick={() => useRemoteHostsStore.getState().closeAddHost()}>
          Done
        </Button>
      </div>
    </motion.div>
  );
}

/* ── Parts ─────────────────────────────────────────────────────────────── */

/** A command the person may want to run themselves, with Copy. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <div className="flex h-8 items-center gap-2 rounded-control border border-border bg-muted/50 pr-1 pl-4 font-mono text-ui">
      <span aria-hidden className="text-muted-foreground select-none">
        $
      </span>
      <span className="min-w-0 flex-1 break-all select-text">{command}</span>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() => {
          if (!navigator.clipboard) {
            toastError("Couldn’t copy the command. Select it and copy manually.");
            return;
          }
          void navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => toastError("Couldn’t copy the command. Select it and copy manually."),
          );
        }}
        className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? (
          <CheckIcon weight="bold" className="size-3.5 text-positive" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
}

const fieldText = (fields: AddHostLogLine["fields"]): string =>
  Object.entries(fields)
    .filter(([key]) => key !== "component" && key !== "flowId")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");

/**
 * What ran on the box, in the box's terminal colours rather than the app's:
 * a window onto another machine should look like one. Never a secret (main
 * logs none).
 */
function LogView({
  lines,
  omitted,
  detail,
}: {
  lines: readonly NumberedLogLine[];
  omitted: number;
  detail: string | null;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines.length]);
  return (
    <div
      ref={scroller}
      role="log"
      aria-label="Details"
      className="h-40 overflow-y-auto rounded-lg border border-white/5 bg-[#101012] px-4 py-2 font-mono text-ui leading-5 text-white/60 shadow-raised"
    >
      {lines.length === 0 && detail === null ? (
        <div className="text-white/35">Nothing yet</div>
      ) : null}
      {omitted === 0 ? null : (
        <div className="text-white/35">
          {omitted === 1 ? "1 earlier line omitted" : `${omitted} earlier lines omitted`}
        </div>
      )}
      {lines.map(({ seq, line }) => (
        <div
          key={seq}
          className={cn(
            "break-words whitespace-pre-wrap",
            line.level === "warn" && "text-[#e3b341]",
            line.level === "error" && "text-[#ff7b72]",
          )}
        >
          {line.message}
          {Object.keys(line.fields).length === 0 ? null : (
            <span className="text-white/35"> {fieldText(line.fields)}</span>
          )}
        </div>
      ))}
      {detail === null ? null : (
        <div className="mt-1 break-words whitespace-pre-wrap text-[#ff7b72]">{detail}</div>
      )}
    </div>
  );
}
