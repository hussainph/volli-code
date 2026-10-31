/**
 * Settings → Account (VC-884): the Volli Cloud account on this Mac. Signed
 * out, two buttons, GitHub and Google, that open the browser; signed in, who
 * you are, Sign out, and Delete account (one confirm, the one irreversible
 * action; a pending deletion offers Restore until its date).
 *
 * Signed in against the backend, the GitHub section (VC-897): connect,
 * reconnect or disconnect the person's GitHub account, and the GitHub
 * accounts the Volli GitHub App is installed on, with Install on an account.
 * Only where the deployment has a GitHub App, and not while a deletion is
 * pending (requesting one revokes GitHub); main follows each browser round
 * trip and this pane follows main's snapshot.
 *
 * Shown with cloud on or for configured stable preview enrollment. Main
 * owns the sign-in; this pane reads its snapshot and never sees a token.
 *
 * **The launch (VC-889).** Signing in or out restarts Volli into the other
 * store. In a local launch, a completed sign-in offers "Restart to open Volli
 * Cloud" (a toast, and a row that stays until the restart); in a cloud
 * launch, Sign out confirms, then signs out and restarts.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BuildingsIcon } from "@phosphor-icons/react/dist/csr/Buildings";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { GoogleLogoIcon } from "@phosphor-icons/react/dist/csr/GoogleLogo";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import {
  PREVIEW_AGREEMENT_VERSION,
  PREVIEW_AGREEMENT_URL,
  PREVIEW_PRIVACY_URL,
} from "@volli/shared";
import type {
  AccountConnection,
  AccountGithubInstallation,
  AccountGithubSnapshot,
  AccountSnapshot,
  AccountSummary,
} from "@volli/shared";

import {
  Empty,
  Health,
  ItemRow,
  PrefRow,
  PrefSection,
  SectionAction,
} from "@renderer/components/settings/kit";
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
import { toast } from "sonner";

import { SignOutRestartDialog } from "@renderer/components/cloud/sign-out-restart";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Input } from "@renderer/components/ui/input";
import { Button } from "@renderer/components/ui/button";
import { toastError } from "@renderer/lib/toast";
import { isExperimentOn, useExperimentsStore } from "@renderer/stores/experiments";
import { launchStore } from "@renderer/stores/launch";

import {
  useAccount,
  useAccountGithub,
  type AccountCommands,
  type AccountGithubCommands,
  type AccountRpc,
} from "./use-account";

const BUTTONS: readonly {
  connection: AccountConnection;
  label: string;
  icon: typeof GithubLogoIcon;
}[] = [
  { connection: "github", label: "Continue with GitHub", icon: GithubLogoIcon },
  { connection: "google", label: "Continue with Google", icon: GoogleLogoIcon },
];

/** Runs a command; a failure is a toast with what main said. */
function act(run: () => Promise<unknown>, what: string): void {
  run().catch((error: unknown) => {
    toastError(error instanceof Error && error.message !== "" ? error.message : `${what} failed.`);
  });
}

function Failure({ text }: { text: string | null }) {
  return text !== null ? (
    <p role="alert" className="text-ui text-destructive">
      {text}
    </p>
  ) : null;
}

function SignIn({ snapshot, commands }: { snapshot: AccountSnapshot; commands: AccountCommands }) {
  const [inviteCode, setInviteCode] = React.useState("");
  const [agreementAccepted, setAgreementAccepted] = React.useState(false);
  const waiting = snapshot.state === "signing-in";
  return (
    <PrefSection
      title="Sign in"
      icon={UserCircleIcon}
      action={
        waiting ? (
          <SectionAction label="Cancel" onAct={() => act(commands.cancelSignIn, "Cancel")} />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2" data-testid="account-sign-in">
        <Input
          aria-label="Preview invite code"
          placeholder="Invite code (optional)"
          value={inviteCode}
          onChange={(event) => setInviteCode(event.target.value)}
          disabled={waiting}
          maxLength={128}
        />
        <label className="text-ui flex items-center gap-2">
          <Checkbox
            aria-label="Accept Preview Agreement"
            checked={agreementAccepted}
            onCheckedChange={(checked) => setAgreementAccepted(checked === true)}
            disabled={waiting}
          />
          <span>
            I agree to the{" "}
            <a href={PREVIEW_AGREEMENT_URL} target="_blank" rel="noopener noreferrer">
              Preview Agreement
            </a>{" "}
            and acknowledge the{" "}
            <a href={PREVIEW_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
              Privacy notice
            </a>
            .
          </span>
        </label>
        {BUTTONS.map(({ connection, label, icon: Icon }) => (
          <Button
            key={connection}
            variant="outline"
            disabled={waiting || snapshot.state === "restoring" || !agreementAccepted}
            onClick={() => {
              const code = inviteCode.trim();
              if (code !== "" && code.length < 16) {
                toastError("Invite codes are at least 16 characters.");
                return;
              }
              act(
                () => commands.signIn(connection, code || undefined, PREVIEW_AGREEMENT_VERSION),
                "Sign-in",
              );
            }}
          >
            <Icon />
            {waiting && snapshot.signingInWith === connection ? "Waiting for the browser…" : label}
          </Button>
        ))}
        <Failure text={snapshot.failure} />
      </div>
    </PrefSection>
  );
}

const CONNECTION = {
  synced: { state: "ready", label: "Connected" },
  unreachable: { state: "waiting", label: "Offline" },
  refused: { state: "error", label: "Not accepted" },
} as const satisfies Record<
  Exclude<AccountSummary["backend"], "none">,
  { state: "ready" | "waiting" | "error"; label: string }
>;

function purgeDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { dateStyle: "long" });
}

/** Whether this signed-in account opens Volli Cloud on the next launch, from a local one. */
function restartOffered(account: AccountSummary): boolean {
  return (
    launchStore() === "local" &&
    account.backend === "synced" &&
    account.userId !== null &&
    account.deletionPurgeAfter === null
  );
}

const SELECTION = {
  all: "All repositories",
  selected: "Selected repositories",
} as const satisfies Record<AccountGithubInstallation["repositorySelection"], string>;

/** The GitHub connection: Connect, Reconnect, or who is connected and Disconnect. */
function GithubConnection({
  snapshot,
  commands,
}: {
  snapshot: AccountGithubSnapshot;
  commands: AccountGithubCommands;
}) {
  const { connection, waiting } = snapshot;
  const connecting = waiting === "connect";
  const active = connection?.status === "active";
  return (
    <PrefSection
      title="GitHub"
      icon={GithubLogoIcon}
      action={
        connecting ? (
          <SectionAction label="Cancel" onAct={() => act(commands.cancel, "Cancel")} />
        ) : active ? (
          <SectionAction label="Disconnect" onAct={() => act(commands.disconnect, "Disconnect")} />
        ) : undefined
      }
    >
      <PrefRow label="Account">
        {connection !== null ? (
          <span className="text-ui">
            @{connection.login}
            {connection.name !== null ? (
              <span className="text-muted-foreground"> · {connection.name}</span>
            ) : null}
          </span>
        ) : null}
        {!active ? (
          <Button
            size="sm"
            variant="outline"
            // An install in flight does not block this: a start replaces it.
            disabled={connecting}
            onClick={() => act(commands.connect, "Connect")}
          >
            <GithubLogoIcon />
            {connecting
              ? "Waiting for the browser…"
              : connection?.status === "needs_reconnect"
                ? "Reconnect"
                : "Connect"}
          </Button>
        ) : null}
      </PrefRow>
      <Failure text={snapshot.failure} />
    </PrefSection>
  );
}

function openConfigure(url: string): void {
  // main's window-open handler denies the window and sends an http(s) URL to the browser.
  window.open(url, "_blank", "noopener");
}

/** The GitHub accounts the App is installed on, and Install on an account. */
function GithubAccounts({
  snapshot,
  commands,
}: {
  snapshot: AccountGithubSnapshot;
  commands: AccountGithubCommands;
}) {
  const installing = snapshot.waiting === "install";
  const { installations } = snapshot;
  return (
    <PrefSection
      title="GitHub accounts"
      icon={BuildingsIcon}
      action={
        <div className="flex items-center gap-1">
          <SectionAction
            label={installing ? "Waiting for the browser…" : "Install on an account"}
            icon={installing ? undefined : PlusIcon}
            disabled={installing}
            onAct={() => act(commands.install, "Install")}
          />
          {installing ? (
            <SectionAction label="Cancel" onAct={() => act(commands.cancel, "Cancel")} />
          ) : null}
        </div>
      }
    >
      {installations === null ? null : installations.length === 0 ? (
        <Empty>No GitHub accounts yet.</Empty>
      ) : (
        <div data-testid="github-installations">
          {installations.map((installation) => (
            <ItemRow
              key={installation.installationId}
              name={installation.accountLogin}
              meta={
                installation.suspended
                  ? `${SELECTION[installation.repositorySelection]} · Suspended`
                  : SELECTION[installation.repositorySelection]
              }
            >
              <Button
                size="xs"
                variant="ghost"
                onClick={() => openConfigure(installation.configureUrl)}
              >
                Configure on GitHub
                <ArrowSquareOutIcon />
              </Button>
            </ItemRow>
          ))}
        </div>
      )}
      {snapshot.requested ? (
        // The backend cannot tell an owner's approval request from a cancel on GitHub.
        <p role="status" className="text-ui text-muted-foreground">
          If you asked an organization owner to approve, Volli will show the account here once they
          do.
        </p>
      ) : null}
    </PrefSection>
  );
}

/** The account's GitHub half; nothing at all where the deployment has no GitHub App. */
function Github({ rpc }: { rpc: AccountRpc | undefined }) {
  const { view, commands, retry } = useAccountGithub(rpc);
  if (view.kind === "loading") return null;
  if (view.kind === "failed" || view.snapshot.state === "failed") {
    return (
      <PrefSection
        title="GitHub"
        icon={GithubLogoIcon}
        action={<SectionAction label="Retry" onAct={retry} />}
      >
        <Empty>
          {view.kind === "failed"
            ? view.message
            : (view.snapshot.failure ?? "Couldn't read your GitHub connection.")}
        </Empty>
      </PrefSection>
    );
  }
  const { snapshot } = view;
  if (snapshot.state !== "ready") return null;
  return (
    <>
      <GithubConnection snapshot={snapshot} commands={commands} />
      {snapshot.connection?.status === "active" ? (
        <GithubAccounts snapshot={snapshot} commands={commands} />
      ) : null}
    </>
  );
}

function SignedIn({
  account,
  failure,
  commands,
  rpc,
}: {
  account: AccountSummary;
  failure: string | null;
  commands: AccountCommands;
  rpc: AccountRpc | undefined;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const cloudLaunch = launchStore() === "cloud";
  const cloudEnabled = useExperimentsStore((state) => isExperimentOn(state.snapshot, "cloud"));
  return (
    <>
      <PrefSection
        title="Account"
        icon={UserCircleIcon}
        action={
          <SectionAction
            label="Sign out"
            icon={SignOutIcon}
            onAct={() => (cloudLaunch ? setSigningOut(true) : act(commands.signOut, "Sign out"))}
          />
        }
      >
        <PrefRow label="Name">
          <span className="text-ui">{account.displayName}</span>
        </PrefRow>
        {account.email !== null ? (
          <PrefRow label="Email">
            <span className="text-ui">{account.email}</span>
          </PrefRow>
        ) : null}
        {account.backend !== "none" ? (
          <PrefRow label="Volli Cloud">
            <Health state={CONNECTION[account.backend].state}>
              {CONNECTION[account.backend].label}
            </Health>
          </PrefRow>
        ) : null}
        {account.backend === "refused" ? <Failure text={failure} /> : null}
        {restartOffered(account) ? (
          <PrefRow label="Board">
            <Button size="sm" variant="outline" onClick={() => act(commands.relaunch, "Restart")}>
              Restart to open Volli Cloud
            </Button>
          </PrefRow>
        ) : null}
      </PrefSection>
      {/* Keyed by the person: another sign-in reads its own connection. A
          pending deletion has revoked GitHub; a restore reads it afresh. */}
      {(cloudLaunch || cloudEnabled) &&
      account.backend === "synced" &&
      account.userId !== null &&
      account.deletionPurgeAfter === null ? (
        <Github key={account.userId} rpc={rpc} />
      ) : null}
      {account.backend !== "none" ? (
        <PrefSection title="Deletion" icon={TrashIcon}>
          {account.deletionPurgeAfter !== null ? (
            <PrefRow label="Scheduled">
              <span className="text-ui">{purgeDate(account.deletionPurgeAfter)}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => act(commands.cancelDeletion, "Restore")}
              >
                Restore account
              </Button>
            </PrefRow>
          ) : (
            <PrefRow label="Account">
              <Button
                size="sm"
                variant="destructive"
                disabled={account.userId === null}
                onClick={() => setConfirming(true)}
              >
                Delete account…
              </Button>
            </PrefRow>
          )}
        </PrefSection>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your Volli account?</AlertDialogTitle>
            <AlertDialogDescription>
              Your account is deleted in 30 days. Until then you can restore it here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={() => act(commands.requestDeletion, "Delete account")}
            >
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SignOutRestartDialog
        open={signingOut}
        onOpenChange={setSigningOut}
        {...(rpc === undefined ? {} : { rpc })}
      />
    </>
  );
}

/**
 * The moment a sign-in completes in a local launch, one toast offers the
 * restart into Volli Cloud; "Later" is dismissing it (the row stays).
 */
function useRestartOffer(snapshot: AccountSnapshot | null, commands: AccountCommands): void {
  const previous = React.useRef<AccountSnapshot | null>(null);
  React.useEffect(() => {
    const before = previous.current;
    previous.current = snapshot;
    if (before === null || snapshot === null || snapshot.account === null) return;
    const offeredBefore = before.account !== null && restartOffered(before.account);
    if (offeredBefore || !restartOffered(snapshot.account)) return;
    toast("Restart to open Volli Cloud", {
      id: "cloud-restart-offer",
      duration: Infinity,
      action: { label: "Restart now", onClick: () => act(commands.relaunch, "Restart") },
      cancel: { label: "Later", onClick: () => {} },
    });
  }, [snapshot, commands]);
}

/** `rpc` is the tier client; a test passes its own. */
export function AccountPane({ rpc }: { rpc?: AccountRpc } = {}) {
  const { view, commands, retry } = useAccount(rpc);
  useRestartOffer(view.kind === "ready" ? view.snapshot : null, commands);
  if (view.kind === "loading") {
    return (
      <PrefSection title="Account" icon={UserCircleIcon}>
        <Empty>Checking your sign-in…</Empty>
      </PrefSection>
    );
  }
  if (view.kind === "failed") {
    return (
      <PrefSection
        title="Account"
        icon={UserCircleIcon}
        action={<SectionAction label="Retry" onAct={retry} />}
      >
        <Empty>{view.message}</Empty>
      </PrefSection>
    );
  }
  const { snapshot } = view;
  if (snapshot.state === "unconfigured") {
    return (
      <PrefSection title="Account" icon={UserCircleIcon}>
        <Empty>This build has no Volli Cloud sign-in.</Empty>
      </PrefSection>
    );
  }
  if (snapshot.state === "signed-in" && snapshot.account !== null) {
    return (
      <SignedIn
        account={snapshot.account}
        failure={snapshot.failure}
        commands={commands}
        rpc={rpc}
      />
    );
  }
  return <SignIn snapshot={snapshot} commands={commands} />;
}
