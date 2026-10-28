import * as React from "react";
import { BuildingsIcon } from "@phosphor-icons/react/dist/csr/Buildings";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { SignInIcon } from "@phosphor-icons/react/dist/csr/SignIn";
import { newId } from "@volli/shared/cloud";

import { Empty } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { toastError } from "@renderer/lib/toast";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceSwitcher } from "./use-workspace-switcher";

type Switcher = ReturnType<typeof useWorkspaceSwitcher>;
type Preview = Awaited<ReturnType<Switcher["commands"]["preview"]>>;

function previewFailure(preview: Preview): string | null {
  switch (preview.status) {
    case "valid":
    case "already_member":
      return null;
    case "expired":
      return "This invite has expired.";
    case "email_mismatch":
      return `Sign in with ${"email" in preview ? preview.email : "the invited address"} to use this invite.`;
    case "suspended":
      return "Your membership is suspended. Ask a Workspace admin.";
    default:
      return "This invite is no longer valid.";
  }
}

/** A live Workspace choice, never a second board cache. Mounted only in a cloud rail. */
export function WorkspaceSwitcher(props: Parameters<typeof useWorkspaceSwitcher>[0] = {}) {
  const state = useWorkspaceSwitcher(props);
  const workspace = useCloudWorkspaceStore((s) => s.workspace);
  const [dialog, setDialog] = React.useState<"new" | "join" | null>(null);
  const [switching, setSwitching] = React.useState(false);
  const pending = React.useRef(false);
  const select = async (id: string) => {
    if (pending.current) return;
    pending.current = true;
    setSwitching(true);
    try {
      await state.commands.select(id);
    } catch (error) {
      toastError(error instanceof Error ? error.message : "Couldn’t open the Workspace.");
    } finally {
      pending.current = false;
      setSwitching(false);
    }
  };
  const locked = state.readOnly || switching;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={workspace?.name ?? "Workspaces"}
            className="app-region-no-drag flex size-9 shrink-0 items-center justify-center rounded-control border border-border text-ui font-medium text-muted-foreground hover:bg-muted"
          >
            {workspace === null ? (
              <BuildingsIcon className="size-4" />
            ) : (
              workspace.name.slice(0, 1).toUpperCase()
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-64">
          {state.workspaces.kind === "ready" ? (
            <DropdownMenuRadioGroup
              value={workspace?.id ?? ""}
              onValueChange={(id) => void select(id)}
            >
              {state.workspaces.value.map((row) => (
                <DropdownMenuRadioItem
                  key={row.workspaceId}
                  value={row.workspaceId}
                  disabled={locked}
                >
                  <BuildingsIcon />
                  {row.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          ) : (
            <Empty>
              {state.workspaces.kind === "failed"
                ? state.workspaces.message
                : state.readOnly
                  ? "Volli Cloud is offline."
                  : "Loading Workspaces…"}
            </Empty>
          )}
          {state.mine.kind === "failed" && <Empty>{state.mine.message}</Empty>}
          {(state.workspaces.kind === "failed" || state.mine.kind === "failed") && (
            <DropdownMenuItem onSelect={state.retry}>
              <ArrowClockwiseIcon />
              Retry
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={locked} onSelect={() => setDialog("new")}>
            <PlusIcon />
            New workspace…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={locked} onSelect={() => setDialog("join")}>
            <SignInIcon />
            Join a workspace…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={workspace === null}
            onSelect={() => useUiStore.getState().setSettingsOpen(true, "workspace")}
          >
            <GearIcon />
            Workspace settings…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog !== null && (
        <WorkspaceDialog key={dialog} kind={dialog} state={state} close={() => setDialog(null)} />
      )}
    </>
  );
}

function WorkspaceDialog({
  kind,
  state,
  close,
}: {
  kind: "new" | "join";
  state: Switcher;
  close: () => void;
}) {
  const [value, setValue] = React.useState("");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef(false);
  // Retrying a create keeps its idempotency key, rather than making a second Workspace.
  const [workspaceId] = React.useState(() => newId("workspace"));
  const run = async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toastError(error instanceof Error ? error.message : "That didn’t work.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const failure = preview === null ? null : previewFailure(preview);
  const submit = () =>
    run(async () => {
      if (kind === "new") {
        await state.commands.create(workspaceId, value.trim());
        close();
      } else if (preview === null) {
        setPreview(await state.commands.preview(value.trim()));
      } else if (failure === null) {
        await state.commands.joinCode(value.trim());
        close();
      }
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === "new" ? "New workspace" : "Join a workspace"}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            autoFocus
            aria-label={kind === "new" ? "Workspace name" : "Invite code"}
            placeholder={kind === "new" ? "Name" : "Invite code"}
            value={value}
            disabled={busy}
            onChange={(event) => {
              setValue(event.target.value);
              setPreview(null);
            }}
          />
          {preview !== null &&
            (failure !== null ? (
              <p role="status" className="text-ui text-muted-foreground">
                {failure}
              </p>
            ) : (
              "workspaceName" in preview && (
                <p className="text-ui">
                  {preview.workspaceName} · {preview.role[0]!.toUpperCase() + preview.role.slice(1)}{" "}
                  · from {preview.invitedByName}
                </p>
              )
            ))}
          <DialogFooter>
            <Button
              type="submit"
              size="sm"
              disabled={busy || state.readOnly || value.trim() === "" || failure !== null}
            >
              {kind === "new"
                ? "Create"
                : preview === null
                  ? "Preview"
                  : preview.status === "already_member"
                    ? "Open workspace"
                    : "Join"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
