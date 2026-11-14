/** Settings account rows use the existing sign-in client and pure auth model. */
import { LoadingLabel } from "@renderer/components/ui/loading-label";

import {
  ExternalIcon,
  SuccessIcon,
  CopyIcon,
  SearchIcon,
  IntegrationIcon,
} from "@renderer/components/ui/icon";

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
  reauthenticationMethod,
  IDLE_SIGN_IN_VIEW,
  partitionAccounts,
  retireAnsweredPrompt,
  type DeepLinkedAction,
  type SignInView,
} from "@renderer/components/pages/model-access-accounts-model";
import { Empty, ItemRow, PrefSection } from "@renderer/components/settings/kit";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { IdentityTile } from "@renderer/components/ui/identity-tile";
import { Notice } from "@renderer/components/ui/notice";
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
import { ModelMark } from "@renderer/components/models/model-identity";
import { availableProviderRows, providerStatus } from "./provider-accounts-model";

const COPY_FEEDBACK_MS = 1200;

export function ModelAccessAccounts({
  providers,
  autoSignInProviderId,
  reauthenticate,
  onRecover,
  onChanged,
}: {
  providers: readonly ModelAccessProvider[];
  autoSignInProviderId?: string;
  /** A stopped chat asked to sign in to that provider again with this method (VC-1236). */
  reauthenticate?: ModelAccessSignInType;
  onRecover(provider: ModelAccessProvider): void | Promise<void>;
  onChanged(): void | Promise<void>;
}) {
  const { connected, available } = partitionAccounts(providers);
  const row = (provider: ModelAccessProvider) => (
    <ProviderAccount
      key={provider.id}
      provider={provider}
      onArrival={deepLinkedAction(provider, autoSignInProviderId)}
      reauthenticateWith={reauthenticationMethod(provider, autoSignInProviderId, reauthenticate)}
      onRecover={onRecover}
      onChanged={onChanged}
    />
  );

  if (providers.length === 0) return null;
  return (
    <>
      <PrefSection title="Signed in" icon={SuccessIcon}>
        <div data-slot="model-access-accounts" className="px-4">
          {connected.length === 0 ? (
            <Empty illustration="mcp">No connected accounts</Empty>
          ) : (
            connected.map(row)
          )}
        </div>
      </PrefSection>

      {available.length > 0 ? (
        <FilteredAccounts
          providers={available}
          requestedProviderId={autoSignInProviderId}
          row={row}
        />
      ) : null}
    </>
  );
}

function FilteredAccounts({
  providers,
  requestedProviderId,
  row,
}: {
  providers: readonly ModelAccessProvider[];
  requestedProviderId?: string;
  row: (provider: ModelAccessProvider) => React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const shown = availableProviderRows(providers, query, expanded, requestedProviderId);
  return (
    <PrefSection
      title="Available to connect"
      icon={IntegrationIcon}
      action={
        <InputGroup className="search-capsule w-56">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            aria-label="Search providers"
            placeholder="Search providers"
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
      }
    >
      <div data-slot="model-access-accounts-available" className="px-4">
        {shown.length === 0 ? (
          <Empty
            illustration="search"
            action={{ label: "Clear search", onAction: () => setQuery("") }}
          >
            No matching providers
          </Empty>
        ) : (
          shown.map(row)
        )}
        {!expanded && !query.trim() && shown.length < providers.length ? (
          <Button size="sm" variant="ghost" className="my-2" onClick={() => setExpanded(true)}>
            Show all {providers.length} providers
          </Button>
        ) : null}
      </div>
    </PrefSection>
  );
}

function ProviderAccount({
  provider,
  onArrival,
  reauthenticateWith = null,
  onRecover,
  onChanged,
}: {
  provider: ModelAccessProvider;
  onArrival: DeepLinkedAction;
  /** The method a sign-in-again request starts here, even at a connected account. */
  reauthenticateWith?: ModelAccessSignInType | null;
  onRecover(provider: ModelAccessProvider): void | Promise<void>;
  onChanged(): void | Promise<void>;
}) {
  const client = useModelAccessClient();
  const [session, setSession] = React.useState<ModelAccessSignInSession | null>(null);
  const [view, setView] = React.useState<SignInView>(IDLE_SIGN_IN_VIEW);
  const [starting, setStarting] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const busy = starting || signingOut;

  const startOnArrival =
    reauthenticateWith ?? (onArrival === "sign-in" ? (provider.signIn[0]?.type ?? null) : null);
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
      <ItemRow
        name={null}
        leading={
          <IdentityTile>
            <ModelMark
              model={{ providerId: provider.id, modelId: "", label: provider.label }}
              providerLabel={provider.label}
              by="provider"
              className="size-4"
            />
          </IdentityTile>
        }
        testId={`account-${provider.id}`}
      >
        {providerStatus(provider) ? (
          <span className="text-label text-muted-foreground">{providerStatus(provider)}</span>
        ) : null}
        {session !== null ? (
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : (
          <>
            {provider.hasStoredCredential ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Sign out of ${provider.label}`}
                disabled={busy}
                onClick={() => void signOut()}
              >
                {signingOut ? <LoadingLabel>Signing out</LoadingLabel> : "Sign out"}
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
      </ItemRow>
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

function SignInControl({
  provider,
  busy,
  autoOpenChoice = false,
  onRetry,
  onSignIn,
}: {
  provider: ModelAccessProvider;
  busy: boolean;
  autoOpenChoice?: boolean;
  onRetry(): void;
  onSignIn(type: ModelAccessSignInType): void;
}) {
  const action = accountAction(provider);
  if (action === "none") return null;
  if (action === "retry") {
    return (
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Retry ${provider.label}`}
        disabled={busy}
        onClick={onRetry}
      >
        Retry
      </Button>
    );
  }
  const only = provider.signIn[0];
  if (action === "sign-in" && only !== undefined) {
    return (
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Sign in to ${provider.label}`}
        disabled={busy}
        onClick={() => onSignIn(only.type)}
      >
        Sign in
      </Button>
    );
  }
  return (
    <DropdownMenu defaultOpen={autoOpenChoice}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Sign in to ${provider.label}`}
          disabled={busy}
        >
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
      className="mb-2 flex flex-col gap-2 rounded-md border border-border bg-(--surface-quaternary) p-2"
    >
      {event !== null ? <SignInEventView event={event} /> : null}
      {failure !== null ? (
        <Notice
          tone="error"
          announce
          title="Couldn't connect account"
          detail={failure}
          actions={
            <Button size="sm" variant="ghost" onClick={onDismissFailure}>
              Dismiss
            </Button>
          }
        />
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

function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex items-center gap-2">
      <code className="rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-ui tracking-wide tabular-nums">
        {code}
      </code>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={copied ? "Code copied" : "Copy code"}
        onClick={() => void copyDeviceCode(code).then((state) => setCopied(state === "copied"))}
      >
        {copied ? <SuccessIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

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

function ExternalLinkButton({ url, label }: { url: string; label: string }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      className="self-start"
      onClick={() => window.open(url, "_blank", "noopener")}
    >
      <ExternalIcon className="size-3.5" />
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
