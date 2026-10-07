/**
 * "Open a project on <host>…" (VC-710): the host's projects, read from it
 * over the HOST connection each time the sheet opens (SSH only for older hosts),
 * each with Open (or Close, once this Mac
 * has it open), and "New project…", which makes one there from a git URL or
 * a folder on the host, then opens it.
 *
 * Opened from the switcher (a host with no project open here), Settings →
 * Hosts → <host> → Projects, ⌘K, and the add flow's Done. Every state that is
 * not a list says one line and offers one recovery (`open-project-model.ts`).
 * Mounted only while `cloud` is on (`HostsChrome`).
 *
 * **Lifetimes.** A fresh body per opening; every answer that lands after the
 * body is gone, or after a newer read began, is dropped. Nothing here holds a
 * link or a stream: main owns those.
 */
import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { FolderSimpleIcon } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import type { RemoteHost } from "@volli/shared";
import { toast } from "sonner";

import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import {
  createProjectOnHost,
  projectsOnHost,
  usesLegacyProjects,
  readdHostToUpdate,
  remoteHostOf,
  remoteHosts,
  useRemoteHostsStore,
} from "@renderer/stores/remote-hosts";

import { CommandLine } from "./add-host-sheet";
import { useHostSignInSheet } from "./sign-ins/remote-host-sign-in-source";
import { EASE_OUT, HostGlyph, useMotionTiming } from "./host-parts";
import {
  canCreate,
  creatingLine,
  createProjectIntent,
  failedLine,
  failureRecovery,
  listNotice,
  projectRows,
  projectSource,
  sourceHint,
  sourceProblem,
  type ProjectListState,
  type ProjectFailure,
  type ProjectNotice,
} from "./open-project-model";

/** The sheet, open while the remote-hosts store says so. */
export function OpenProjectSheet() {
  const open = useRemoteHostsStore((state) => state.openProject.open);
  const hostId = useRemoteHostsStore((state) => state.openProject.hostId);
  const start = useRemoteHostsStore((state) => state.openProject.start);
  const opening = useRemoteHostsStore((state) => state.openProject.opening);
  const hosts = useRemoteHostsStore((state) => state.hosts);
  const host = remoteHostOf(hosts, hostId);
  // A host forgotten while its sheet is open: the sheet goes with it.
  const shown = open && host !== undefined;
  return (
    <Dialog
      open={shown}
      onOpenChange={(next) => {
        if (!next) useRemoteHostsStore.getState().closeProjectSheet();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          "top-[14vh] flex max-h-[80vh] max-w-[30rem] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[30rem]",
          "data-[state=open]:duration-[260ms] data-[state=open]:zoom-in-96 data-[state=open]:slide-in-from-bottom-2",
          "data-[state=closed]:duration-150 data-[state=closed]:zoom-out-98 data-[state=closed]:slide-out-to-bottom-1",
        )}
      >
        <MotionConfig reducedMotion="user">
          {shown ? (
            // A fresh body per opening, and per host: nothing of another survives.
            <OpenProjectBody
              key={`${opening}:${host.id}`}
              host={host}
              start={start}
              opening={opening}
            />
          ) : null}
        </MotionConfig>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Closes the sheet only while it is still `opening`'s: a late answer from an
 * earlier opening never dismisses a newer one.
 */
function closeOpening(opening: number): void {
  const store = useRemoteHostsStore.getState();
  if (store.openProject.opening === opening) store.closeProjectSheet();
}

/** Whether this body is still the one on screen: answers that land after it are dropped. */
function useAlive(): () => boolean {
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return React.useCallback(() => alive.current, []);
}

function OpenProjectBody({
  host,
  start,
  opening,
}: {
  host: RemoteHost;
  start: "list" | "new";
  opening: number;
}) {
  // Every late answer is checked against this: the body is this opening's, and
  // unmounts when the sheet closes, the host goes, cloud turns off, or another opens.
  const alive = useAlive();
  const close = React.useCallback(() => closeOpening(opening), [opening]);
  const [screen, setScreen] = React.useState<"list" | "new">(start);
  const [state, setState] = React.useState<ProjectListState>({ kind: "loading" });
  const [busy, setBusy] = React.useState<string | null>(null);
  const reads = React.useRef(0);
  const read = React.useCallback(() => {
    const mine = (reads.current += 1);
    setState({ kind: "loading" });
    projectsOnHost(host).then(
      (listing) => {
        if (alive() && reads.current === mine) setState({ kind: "ready", listing });
      },
      (error: unknown) => {
        if (!alive() || reads.current !== mine) return;
        setState({
          kind: "error",
          message:
            error instanceof Error && error.message !== ""
              ? error.message
              : `Couldn’t reach ${host.name}.`,
        });
      },
    );
  }, [alive, host]);
  React.useEffect(read, [read]);

  /** Opens one of the host's projects here, then the sheet is done. */
  const open = React.useCallback(
    async (id: string, name: string): Promise<boolean> => {
      try {
        await remoteHosts().openWorkspace(host.id, id);
      } catch (error) {
        if (alive()) toastError(failedLine("open", name, error));
        return false;
      }
      // Opened; what this view says about it is only this view's to say.
      if (!alive()) return true;
      toast(`Opened ${name} on ${host.name}`);
      close();
      return true;
    },
    [alive, close, host.id, host.name],
  );

  return (
    <AnimatePresence initial={false} mode="popLayout">
      <Screen key={screen}>
        <Header
          host={host}
          title={
            screen === "list" ? `Open a project on ${host.name}` : `New project on ${host.name}`
          }
        />
        {screen === "list" ? (
          <ListScreen
            host={host}
            onDone={close}
            state={state}
            busy={busy}
            onRetry={read}
            onNew={() => setScreen("new")}
            onOpen={(id, name) => {
              setBusy(id);
              void open(id, name).finally(() => {
                if (alive()) setBusy(null);
              });
            }}
            onClose={(id, name) => {
              setBusy(id);
              remoteHosts()
                .closeWorkspace(host.id, id)
                .then(
                  () => {
                    if (alive()) toast(`Closed ${name} on this Mac`);
                  },
                  (error: unknown) => {
                    if (alive()) toastError(failedLine("close", name, error));
                  },
                )
                .finally(() => {
                  if (alive()) setBusy(null);
                });
            }}
          />
        ) : (
          <NewProjectScreen
            host={host}
            alive={alive}
            onDismiss={close}
            onRefresh={read}
            onBack={() => setScreen("list")}
            onOpen={open}
          />
        )}
      </Screen>
    </AnimatePresence>
  );
}

function Screen({ children, ref }: { children: React.ReactNode; ref?: React.Ref<HTMLDivElement> }) {
  const timed = useMotionTiming();
  return (
    <motion.div
      ref={ref}
      className="flex min-h-0 flex-1 flex-col"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: timed({ duration: 0.1 }) }}
      transition={timed({ duration: 0.22, ease: EASE_OUT, delay: 0.04 })}
    >
      {children}
    </motion.div>
  );
}

function Header({ host, title }: { host: RemoteHost; title: string }) {
  return (
    <div className="flex shrink-0 items-center gap-4 px-6 pt-6 pb-4">
      <HostGlyph os={host.os} size="md" />
      <div className="min-w-0">
        <DialogTitle className="truncate">{title}</DialogTitle>
        <DialogDescription className="truncate font-mono text-ui">{host.target}</DialogDescription>
      </div>
    </div>
  );
}

/* ── The list ──────────────────────────────────────────────────────────── */

function ListScreen({
  host,
  onDone,
  state,
  busy,
  onRetry,
  onNew,
  onOpen,
  onClose,
}: {
  host: RemoteHost;
  onDone: () => void;
  state: ProjectListState;
  busy: string | null;
  onRetry: () => void;
  onNew: () => void;
  onOpen: (id: string, name: string) => void;
  onClose: (id: string, name: string) => void;
}) {
  const claims = useHostConnectionStore((store) => store.projects);
  const opened = React.useMemo(
    () =>
      new Set(
        Object.entries(claims)
          .filter(([, claim]) => claim.hostId === host.id)
          .map(([id]) => id),
      ),
    [claims, host.id],
  );
  const rows = state.kind === "ready" ? projectRows(state.listing.projects, opened) : [];
  const notice = listNotice(
    usesLegacyProjects(host) && host.mode === "user"
      ? {
          kind: "ready",
          listing: { hostId: host.id, projects: [], adds: { kind: "user-install" } },
        }
      : state,
    host.name,
  );
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" data-slot="open-project-body">
        {state.kind === "loading" ? (
          <div className="flex h-16 items-center justify-center gap-2 text-ui text-muted-foreground">
            <Spinner />
            Reading {host.name}’s projects…
          </div>
        ) : null}
        {rows.length > 0 ? (
          <ul aria-label={`Projects on ${host.name}`} className="flex flex-col">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 rounded-row px-2 py-2"
                data-project-row={row.id}
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
                  <FolderSimpleIcon aria-hidden className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium">{row.name}</span>
                  <span className="block truncate text-ui text-muted-foreground">{row.meta}</span>
                </span>
                {busy === row.id ? <Spinner className="text-muted-foreground" /> : null}
                {row.opened ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    aria-label={`Close ${row.name} on this Mac`}
                    onClick={() => onClose(row.id, row.name)}
                  >
                    Close
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    aria-label={`Open ${row.name}`}
                    onClick={() => onOpen(row.id, row.name)}
                  >
                    Open
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {notice === null ? null : (
          <Notice
            notice={notice}
            onRetry={onRetry}
            onNew={onNew}
            onReAdd={() => {
              useRemoteHostsStore.getState().closeProjectSheet();
              readdHostToUpdate(host.id);
            }}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-4">
        {canCreate(state) && notice?.recovery.kind !== "new" ? (
          <Button size="sm" variant="ghost" onClick={onNew}>
            <PlusIcon />
            New project…
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  );
}

/** One line, and its one recovery. */
function Notice({
  notice,
  onRetry,
  onNew,
  onReAdd,
}: {
  notice: ProjectNotice;
  onReAdd: () => void;
  onRetry: () => void;
  onNew: () => void;
}) {
  const { recovery } = notice;
  return (
    <div role="status" className="flex flex-col gap-2 px-2 py-4">
      <p className="text-ui text-muted-foreground">{notice.line}</p>
      {recovery.kind === "copy" ? (
        <CommandLine command={recovery.command} />
      ) : (
        <div>
          <Button
            size="sm"
            variant={recovery.kind === "new" ? "default" : "secondary"}
            onClick={
              recovery.kind === "new" ? onNew : recovery.kind === "re-add" ? onReAdd : onRetry
            }
          >
            {recovery.kind === "new" ? <PlusIcon /> : <ArrowClockwiseIcon />}
            {recovery.label}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── New project ───────────────────────────────────────────────────────── */

function NewProjectScreen({
  host,
  alive,
  onDismiss,
  onRefresh,
  onBack,
  onOpen,
}: {
  host: RemoteHost;
  alive: () => boolean;
  onDismiss: () => void;
  onRefresh: () => void;
  onBack: () => void;
  onOpen: (id: string, name: string) => Promise<boolean>;
}) {
  const [text, setText] = React.useState("");
  const [name, setName] = React.useState("");
  const [running, setRunning] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<ProjectFailure | null>(null);
  // The sudo password field is uncontrolled: its text is read once, on
  // submit, and cleared at once. Only whether it has any lives in state.
  const password = React.useRef<HTMLInputElement>(null);
  const [hasPassword, setHasPassword] = React.useState(false);
  const [tries, setTries] = React.useState(0);
  const intent = React.useRef(createProjectIntent());
  const modern = !usesLegacyProjects(host);
  const blocked = !modern && host.mode === "user";
  const source = projectSource(text);
  const problem = sourceProblem(source, host.name, modern);
  const recovery = failure === null ? null : failureRecovery(failure, host.name, tries);
  const asking = recovery?.kind === "password";
  const ready =
    !blocked && source !== null && problem === null && running === null && (!asking || hasPassword);

  const create = (): void => {
    if (source === null || problem !== null) return;
    let sudoPassword: string | null = null;
    if (asking && password.current !== null) {
      sudoPassword = password.current.value;
      password.current.value = "";
      setHasPassword(false);
      setTries((count) => count + 1);
    } else {
      setTries(0);
    }
    setFailure(null);
    setRunning(creatingLine(source, host.name));
    const label = name.trim();
    createProjectOnHost(
      host,
      {
        commandId: intent.current.accept(source, label),
        source: source.kind === "git" ? { gitUrl: source.gitUrl } : { path: source.path },
        ...(label === "" ? {} : { name: label }),
      },
      sudoPassword === null || sudoPassword === "" ? undefined : sudoPassword,
    )
      .then(
        async (result) => {
          // A view gone (closed, another host's, cloud off) starts nothing more:
          // the project the host made stays there, to open from its list.
          if (!alive()) return;
          if (!result.ok) {
            setFailure(result.failure);
            if (result.failure.code === "target-exists") onRefresh();
            return;
          }
          await onOpen(result.project.id, result.project.name);
        },
        (error: unknown) => {
          if (alive())
            setFailure({
              code: "unavailable",
              message: failedLine("create", host.name, error),
              command: null,
            });
        },
      )
      .finally(() => {
        if (alive()) setRunning(null);
      });
  };

  if (blocked)
    return (
      <div className="px-6 pb-4">
        <Notice
          notice={{
            line: `Update ${host.name} to create projects from here`,
            recovery: { kind: "re-add", label: "Re-add" },
          }}
          onRetry={onBack}
          onNew={onBack}
          onReAdd={() => {
            onDismiss();
            readdHostToUpdate(host.id);
          }}
        />
      </div>
    );

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) create();
      }}
    >
      <div className="flex flex-col gap-2 px-6 pb-4">
        <Input
          autoFocus
          aria-label={`Git URL or folder on ${host.name}`}
          aria-invalid={problem !== null || undefined}
          value={text}
          placeholder="git@github.com:you/app.git or /srv/volli/app"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={running !== null}
          className="h-9 font-mono text-sm"
          onChange={(event) => {
            intent.current.edited();
            setFailure(null);
            setText(event.target.value);
          }}
        />
        <p
          className={cn(
            "px-1 text-ui",
            problem === null ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {problem ?? sourceHint(source, modern)}
        </p>
        <Input
          aria-label="Name (optional)"
          value={name}
          placeholder="Name (optional: the folder’s)"
          disabled={running !== null}
          className="h-9 text-sm"
          onChange={(event) => {
            intent.current.edited();
            setFailure(null);
            setName(event.target.value);
          }}
        />
        {running === null ? null : (
          <p role="status" className="flex items-center gap-2 px-1 text-ui text-muted-foreground">
            <Spinner />
            {running}
          </p>
        )}
        {failure === null ? null : (
          <div role="alert" className="flex flex-col gap-2 px-1 pt-2">
            <p className="text-ui text-destructive">{failure.message}</p>
            {failure.command === null ? null : <CommandLine command={failure.command} />}
            {asking ? (
              <Input
                ref={password}
                autoFocus
                type="password"
                autoComplete="off"
                aria-label={`Your password on ${host.name}`}
                placeholder={`Your password on ${host.name}`}
                className="h-9 text-sm"
                onChange={(event) => setHasPassword(event.target.value.length > 0)}
              />
            ) : null}
            {recovery?.kind === "sign-ins" ? (
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    onDismiss();
                    useHostSignInSheet
                      .getState()
                      .open({ hostId: host.id, hostName: host.name, providerId: null });
                  }}
                >
                  <KeyIcon />
                  {recovery.label}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-4">
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={running !== null}
          onClick={onBack}
        >
          <CaretLeftIcon />
          Back
        </Button>
        <span className="flex-1" />
        <Button size="sm" type="submit" disabled={!ready}>
          {failure === null ? "Create and open" : asking ? "Clone with sudo" : "Try again"}
        </Button>
      </div>
    </form>
  );
}
