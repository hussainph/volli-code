/**
 * The Accounts half of Model Access: which providers this profile can reach,
 * and the sign-in that changes the answer.
 *
 * Signing in happens here rather than in a terminal, and the flow it drives is
 * a conversation with up to four kinds of question — a provider may ask for a
 * key, a project id, a menu choice, or a code pasted back from a browser — and
 * four kinds of statement it makes while working. All eight are real: Cloudflare
 * asks three questions in a row, Google Vertex four, Anthropic opens a browser
 * and races a pasted code against a loopback callback, and xAI shows a device
 * code and polls.
 *
 * **The panel is a control, not a wizard.** A step's label is the provider's own
 * `message`, because the provider is the one who knows whether it wants "the"
 * API key or an account id, and any wording invented here would be a second,
 * less accurate copy of it. Nothing explains what a step is for beyond what the
 * step says.
 *
 * `auth-url` and `device-code` are the two exceptions the repo's copy rule
 * grants, and they are affordance exceptions rather than prose ones: one needs
 * a link that opens, the other a code that copies, and no label alone is either.
 *
 * **Nothing here claims a credential works.** No provider offers a validation
 * call, so a completed sign-in means a credential was stored and nothing more.
 * The panel closes, the snapshot reloads, and the row says what it now finds —
 * a wrong key surfaces on first use, and any "Connected" here would be a
 * guess dressed as a receipt.
 */

import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import * as React from "react";
import type {
  ModelAccessProvider,
  ModelAccessSignInEvent,
  ModelAccessSignInPrompt,
  ModelAccessSignInType,
} from "@volli/shared";

import {
  accountAction,
  applySignInUpdate,
  deepLinkedAction,
  IDLE_SIGN_IN_VIEW,
  orderedAccounts,
  providerAccessLabel,
  retireAnsweredPrompt,
  type DeepLinkedAction,
  type SignInView,
} from "@renderer/components/pages/model-access-accounts-model";
import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Spinner } from "@renderer/components/ui/spinner";
import {
  useModelAccessClient,
  type ModelAccessSignInSession,
} from "@renderer/lib/model-access-client";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/** How long a copied code holds its verdict before the button goes back to offering. */
const COPY_FEEDBACK_MS = 1200;

export function ModelAccessAccounts({
  providers,
  loading,
  autoSignInProviderId,
  onRecover,
  onChanged,
}: {
  providers: readonly ModelAccessProvider[];
  loading: boolean;
  /**
   * A provider a blocker sent the user here to sign in to (VC-53). The matching
   * row presses its own offered action on arrival — starting its one sign-in
   * method, or opening the choice when the provider offers several, because two
   * methods are two accounts with two bills and neither may be picked for the
   * user. Spent by the pane above as it is taken, so this arrives on the first
   * visit only (see `deepLinkedAction`).
   */
  autoSignInProviderId?: string;
  /** The `retry` half of recovery — a refresh of the whole snapshot. */
  onRecover(provider: ModelAccessProvider): void | Promise<void>;
  /** A credential was stored or removed; the snapshot no longer describes the profile. */
  onChanged(): void | Promise<void>;
}) {
  if (providers.length === 0) return null;
  return (
    <SettingsSection title="Accounts">
      {orderedAccounts(providers).map((provider) => (
        <ProviderAccount
          key={provider.id}
          provider={provider}
          loading={loading}
          onArrival={deepLinkedAction(provider, autoSignInProviderId)}
          onRecover={onRecover}
          onChanged={onChanged}
        />
      ))}
    </SettingsSection>
  );
}

function ProviderAccount({
  provider,
  loading,
  onArrival,
  onRecover,
  onChanged,
}: {
  provider: ModelAccessProvider;
  loading: boolean;
  /** What a deep-linked arrival presses here, or `none` on an ordinary visit. */
  onArrival: DeepLinkedAction;
  onRecover(provider: ModelAccessProvider): void | Promise<void>;
  onChanged(): void | Promise<void>;
}) {
  const client = useModelAccessClient();
  // The handle and what it has said are two states rather than one, because
  // they end at different moments: the panel keeps showing a failure after the
  // attempt behind it is gone, and only the handle decides whether this row is
  // currently running one.
  const [session, setSession] = React.useState<ModelAccessSignInSession | null>(null);
  const [view, setView] = React.useState<SignInView>(IDLE_SIGN_IN_VIEW);
  const [starting, setStarting] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  // Read by the resolve handler of a call that may outlive this row: an attempt
  // whose opener is gone has nobody to answer its next question, so it is
  // cancelled rather than left parked on the provider's one attempt slot.
  const mounted = React.useRef(true);
  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const busy = loading || starting || signingOut;

  // The deep-linked sign-in, honored once and only once.
  //
  // `sign-in` means this row offers exactly one method and the press that sent
  // the user here already named the provider, so the method is started. Two
  // methods (`choose`) keep the choice with the user via the control's own
  // menu, opened rather than answered. Anything else — a reachable provider,
  // one whose refresh merely needs retrying — is left alone; see
  // `deepLinkedAction`.
  //
  // The ref is the second half of the one-shot: it holds across a snapshot
  // reload or a cancelled attempt, so nothing re-fires while this row stays
  // mounted. The store spending the request is what guards the NEXT visit,
  // where a fresh row would arrive with a fresh ref.
  const startOnArrival = onArrival === "sign-in" ? (provider.signIn[0]?.type ?? null) : null;
  const autoStarted = React.useRef(false);
  const startSignInRef = React.useRef(startSignIn);
  startSignInRef.current = startSignIn;
  React.useEffect(() => {
    if (startOnArrival === null || autoStarted.current) return;
    autoStarted.current = true;
    void startSignInRef.current(startOnArrival);
  }, [startOnArrival]);

  async function startSignIn(type: ModelAccessSignInType): Promise<void> {
    if (client === null || session !== null || starting) return;
    setStarting(true);
    setView(IDLE_SIGN_IN_VIEW);
    try {
      const started = await client.beginSignIn(provider.id, type, (update) => {
        setView((current) => applySignInUpdate(current, update));
        if (update.kind !== "settled") return;
        // The handle is spent on every ending. A failure keeps its panel open
        // with nothing running behind it; the other two endings close it, and
        // what changed is a question for the reloaded snapshot rather than for
        // a message this row could compose about its own request.
        setSession(null);
        if (update.outcome.kind === "signed-in") void onChanged();
      });
      if (!mounted.current) {
        void started.cancel().catch(() => undefined);
        return;
      }
      setSession(started);
    } catch (error) {
      toastError(`Couldn't start sign-in: ${errorMessage(error)}`);
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  async function answer(promptId: string, value: string): Promise<void> {
    if (session === null || view.answering) return;
    setView((current) => ({ ...current, answering: true }));
    try {
      await session.respond(promptId, value);
      // The next question — or the ending — arrives on the update channel; this
      // only retires the one just answered so its input cannot be sent twice.
      setView((current) => retireAnsweredPrompt(current, promptId));
    } catch (error) {
      toastError(`Couldn't send that answer: ${errorMessage(error)}`);
      setView((current) => ({ ...current, answering: false }));
    }
  }

  async function cancel(): Promise<void> {
    if (session === null) return;
    const spent = session;
    setSession(null);
    setView(IDLE_SIGN_IN_VIEW);
    try {
      await spent.cancel();
    } catch {
      // The attempt is already gone from this row's view, and main's copy ends
      // with the window at the latest. Nothing here is worth interrupting for.
    }
  }

  async function signOut(): Promise<void> {
    if (client === null || signingOut) return;
    setSigningOut(true);
    try {
      await client.signOut(provider.id);
      await onChanged();
    } catch (error) {
      toastError(`Couldn't sign out of ${provider.label}: ${errorMessage(error)}`);
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  }

  return (
    <>
      <SettingsRow label={provider.label} testId={`account-${provider.id}`}>
        <span className="text-ui text-muted-foreground">{providerAccessLabel(provider)}</span>
        {session !== null ? (
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : (
          <>
            {provider.hasStoredCredential ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void signOut()}>
                {signingOut ? "Signing out…" : "Sign out"}
              </Button>
            ) : null}
            <SignInControl
              provider={provider}
              busy={busy}
              autoOpenChoice={onArrival === "choose"}
              onRetry={() => void onRecover(provider)}
              onSignIn={(type) => void startSignIn(type)}
            />
          </>
        )}
      </SettingsRow>
      {session !== null || view.failure !== null ? (
        <SignInPanel
          view={view}
          testId={`sign-in-${provider.id}`}
          onAnswer={(promptId, value) => void answer(promptId, value)}
          onDismissFailure={() => setView(IDLE_SIGN_IN_VIEW)}
        />
      ) : null}
    </>
  );
}

/**
 * The row's one action, whichever it is.
 *
 * A provider offering two methods gets a menu rather than two buttons: they are
 * alternatives, not independent things to do, and they are different accounts
 * with different bills — which is why the menu shows the provider's own labels
 * ("Sign in with SuperGrok or X Premium") instead of "API key" and "OAuth".
 */
function SignInControl({
  provider,
  busy,
  autoOpenChoice = false,
  onRetry,
  onSignIn,
}: {
  provider: ModelAccessProvider;
  busy: boolean;
  /** A deep-linked arrival lands with the method menu already open. */
  autoOpenChoice?: boolean;
  onRetry(): void;
  onSignIn(type: ModelAccessSignInType): void;
}) {
  const action = accountAction(provider);
  if (action === "none") return null;
  if (action === "retry") {
    return (
      <Button size="sm" variant="secondary" disabled={busy} onClick={onRetry}>
        Retry
      </Button>
    );
  }
  const only = provider.signIn[0];
  if (action === "sign-in" && only !== undefined) {
    return (
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onSignIn(only.type)}>
        Sign in
      </Button>
    );
  }
  return (
    <DropdownMenu defaultOpen={autoOpenChoice}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" disabled={busy}>
          Sign in
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {provider.signIn.map((method) => (
          <DropdownMenuItem key={method.type} onSelect={() => onSignIn(method.type)}>
            {method.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The attempt, under the row it belongs to.
 *
 * Full width and undivided from the row above, because the two are one unit:
 * the row already names the provider, so the panel never repeats it and never
 * grows a title. It sits on its own surface so the section still reads as a
 * list with one row currently doing something.
 */
function SignInPanel({
  view,
  testId,
  onAnswer,
  onDismissFailure,
}: {
  view: SignInView;
  testId: string;
  onAnswer(promptId: string, value: string): void;
  onDismissFailure(): void;
}) {
  const { prompt, event, failure } = view;
  return (
    <div
      data-testid={testId}
      className="mb-2 flex flex-col gap-2 rounded-md border border-border bg-background/30 p-2"
    >
      {event !== null ? <SignInEventView event={event} /> : null}
      {failure !== null ? (
        <div className="flex items-start justify-between gap-4">
          <p className="text-ui leading-5 text-destructive">{failure}</p>
          <Button size="sm" variant="ghost" onClick={onDismissFailure}>
            Dismiss
          </Button>
        </div>
      ) : prompt !== null ? (
        <SignInPromptView
          prompt={prompt}
          answering={view.answering}
          onAnswer={(value) => onAnswer(prompt.promptId, value)}
        />
      ) : event?.kind === "device-code" ? null : (
        <Waiting />
      )}
    </div>
  );
}

/** A step, asked in the provider's words and answered with one control. */
function SignInPromptView({
  prompt,
  answering,
  onAnswer,
}: {
  prompt: ModelAccessSignInPrompt;
  answering: boolean;
  onAnswer(value: string): void;
}) {
  const [value, setValue] = React.useState("");
  const inputId = React.useId();
  // A fresh field per step: a value typed for one question must never be the
  // default of the next, and for a `secret` step the draft must not outlive it.
  React.useEffect(() => setValue(""), [prompt.promptId]);

  if (prompt.kind === "select") {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-ui font-medium" htmlFor={inputId}>
          {prompt.message}
        </label>
        <Select disabled={answering} onValueChange={onAnswer}>
          <SelectTrigger id={inputId} className="w-full">
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            {prompt.options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.description === null
                  ? option.label
                  : `${option.label} · ${option.description}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  const secret = prompt.kind === "secret";
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(submit) => {
        submit.preventDefault();
        if (value.length > 0 && !answering) onAnswer(value);
      }}
    >
      <label className="text-ui font-medium" htmlFor={inputId}>
        {prompt.message}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          value={value}
          type={secret ? "password" : "text"}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          // A pasted authorization code carries the whitespace of whatever it
          // was copied out of, and a provider comparing it verbatim rejects it.
          className={cn("flex-1", prompt.kind === "manual-code" && "font-mono")}
          placeholder={prompt.placeholder ?? undefined}
          disabled={answering}
          onChange={(change) => setValue(change.target.value)}
        />
        <Button type="submit" size="sm" disabled={answering || value.trim().length === 0}>
          Continue
        </Button>
      </div>
    </form>
  );
}

/** What the flow is doing, or what it needs opened or copied to go on. */
function SignInEventView({ event }: { event: ModelAccessSignInEvent }) {
  switch (event.kind) {
    case "progress":
      return <Waiting message={event.message} />;
    case "info":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-ui leading-5 text-muted-foreground">{event.message}</p>
          {event.links.map((link) => (
            <ExternalLinkButton key={link.url} url={link.url} label={link.label ?? "Open"} />
          ))}
        </div>
      );
    case "auth-url":
      return (
        <div className="flex flex-col gap-2">
          {event.instructions === null ? null : (
            <p className="text-ui leading-5 text-muted-foreground">{event.instructions}</p>
          )}
          <ExternalLinkButton url={event.url} label="Open sign-in page" />
        </div>
      );
    case "device-code":
      return (
        <div className="flex flex-col gap-2">
          <DeviceCode code={event.userCode} />
          <ExternalLinkButton url={event.verificationUri} label="Open verification page" />
        </div>
      );
  }
}

/**
 * The code, in a face that tells `0` from `O` and `1` from `l`.
 *
 * It is transcribed by hand into another window, so the glyphs have to survive
 * being read aloud off a screen. Copy is offered because that is the one way to
 * transcribe it without reading it at all.
 */
function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex items-center gap-2">
      <code className="rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-sm tracking-[0.2em] tabular-nums">
        {code}
      </code>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={copied ? "Code copied" : "Copy code"}
        onClick={() => void copyDeviceCode(code).then((state) => setCopied(state === "copied"))}
      >
        {copied ? <CheckCircleIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

/** The clipboard write, behind an injectable boundary so a test never needs a real one. */
export async function copyDeviceCode(
  code: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = navigator.clipboard,
): Promise<"copied" | "failed"> {
  try {
    if (clipboard === undefined) return "failed";
    await clipboard.writeText(code);
    return "copied";
  } catch {
    return "failed";
  }
}

/**
 * The app's one sanctioned external-open seam: a `window.open` of an http(s)
 * target never opens a BrowserWindow — main's `setWindowOpenHandler` denies it
 * and routes the url to `shell.openExternal`. No new IPC needed.
 */
function ExternalLinkButton({ url, label }: { url: string; label: string }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      className="self-start"
      onClick={() => window.open(url, "_blank", "noopener")}
    >
      <ArrowSquareOutIcon className="size-3.5" />
      {label}
    </Button>
  );
}

function Waiting({ message }: { message?: string }) {
  return (
    <div className="flex items-center gap-2 text-ui text-muted-foreground">
      <Spinner className="size-3.5" />
      {message === undefined ? null : <span>{message}</span>}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
