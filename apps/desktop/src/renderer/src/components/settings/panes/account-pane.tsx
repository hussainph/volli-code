/**
 * Settings → Account (VC-884): the Volli Cloud account on this Mac. Signed
 * out, two buttons, GitHub and Google, that open the browser; signed in, who
 * you are, Sign out, and Delete account (one confirm, the one irreversible
 * action; a pending deletion offers Restore until its date).
 *
 * Shown only with `cloud` on: the category does not exist otherwise. Main
 * owns the sign-in; this pane reads its snapshot and never sees a token.
 *
 * **The launch (VC-889).** Signing in or out restarts Volli into the other
 * store. In a local launch, a completed sign-in offers "Restart to open Volli
 * Cloud" (a toast, and a row that stays until the restart); in a cloud
 * launch, Sign out confirms, then signs out and restarts.
 */
import * as React from "react";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { GoogleLogoIcon } from "@phosphor-icons/react/dist/csr/GoogleLogo";
import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import type { AccountConnection, AccountSnapshot, AccountSummary } from "@volli/shared";

import {
  Empty,
  Health,
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
import { Button } from "@renderer/components/ui/button";
import { toastError } from "@renderer/lib/toast";
import { launchStore } from "@renderer/stores/launch";

import { useAccount, type AccountCommands, type AccountRpc } from "./use-account";

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

function SignIn({ snapshot, commands }: { snapshot: AccountSnapshot; commands: AccountCommands }) {
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
        {BUTTONS.map(({ connection, label, icon: Icon }) => (
          <Button
            key={connection}
            variant="outline"
            disabled={waiting || snapshot.state === "restoring"}
            onClick={() => act(() => commands.signIn(connection), "Sign-in")}
          >
            <Icon />
            {waiting && snapshot.signingInWith === connection ? "Waiting for the browser…" : label}
          </Button>
        ))}
        {snapshot.failure !== null ? (
          <p role="alert" className="text-ui text-destructive">
            {snapshot.failure}
          </p>
        ) : null}
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
  return launchStore() === "local" && account.backend === "synced" && account.userId !== null;
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
  return (
    <>
      <PrefSection
        title="Account"
        icon={UserCircleIcon}
        action={
          <SectionAction
            label="Sign out"
            icon={SignOutIcon}
            onAct={() =>
              cloudLaunch ? setSigningOut(true) : act(commands.signOut, "Sign out")
            }
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
        {account.backend === "refused" && failure !== null ? (
          <p role="alert" className="text-ui text-destructive">
            {failure}
          </p>
        ) : null}
        {restartOffered(account) ? (
          <PrefRow label="Board">
            <Button size="sm" variant="outline" onClick={() => act(commands.relaunch, "Restart")}>
              Restart to open Volli Cloud
            </Button>
          </PrefRow>
        ) : null}
      </PrefSection>
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
