/**
 * What crosses the desktop's own IPC bridge (VC-608; HP § Command catalog,
 * "Doors are projections").
 *
 * The bridge is router-generic (`@volli/host-protocol/ipc-server`): it
 * dispatches any path its routers publish through tRPC, under the same
 * router context and error envelope the WebSocket uses. What it serves is
 * decided here, once, for every procedure of every router it is handed: a
 * total table, so a procedure added to any of those routers fails
 * `pnpm typecheck` here until someone decides whether the desktop window may
 * reach it. A deliberate exclusion is written down, never an omission.
 *
 * The renderer's client is typed from the same table ({@link DesktopIpcRouter}),
 * so a withheld procedure is not even a method on it.
 */
import type { IpcClientRouter } from "@volli/host-protocol/ipc";

import type { AnyRouter } from "@trpc/server";

import type { BoardRouter } from "./board-router";
import type { RouterProcedurePaths } from "./catalog";
import type { DesktopRouter } from "./desktop-router";
import type { AppRouter } from "./index";

/**
 * The routers the desktop's IPC bridge serves, composed by
 * `src/main/session-rpc-ipc.ts`: the Session router, the board router
 * (VC-565) the renderer reads and writes the board through with `cloud` on,
 * and the desktop-only tier's (VC-608). An area router joins here when its
 * area moves.
 */
export type DesktopIpcRouters = AppRouter | BoardRouter | DesktopRouter;

/** Every procedure path those routers publish: each router's, together. */
export type DesktopIpcRouterPath = RouterProcedurePaths<DesktopIpcRouters>;

/**
 * How one procedure crosses the desktop's IPC bridge:
 *
 * - `ipc`: served to the desktop's own window;
 * - `lab-only`: development diagnostics. No production transport serves
 *   them: a production client has no debug pane to feed and no business
 *   reading a diagnostic log over the channel it runs Sessions on;
 * - `websocket-only`: the host protocol's own, for a network caller (the
 *   welcome a handshake negotiated, which the window never has; the socket's
 *   Session reads, Workspace-scoped; a remote host's sign-ins, owned by the
 *   asking connection, VC-702). The renderer keeps its own listing.
 */
export type DesktopIpcExposure = "ipc" | "lab-only" | "websocket-only";

/**
 * A total classification of every path some routers publish: a path with no
 * row, or a row naming no path, fails `pnpm typecheck` (an object literal
 * checked against it with `satisfies`).
 */
export type IpcExposureTable<Routers extends AnyRouter> = {
  readonly [Path in RouterProcedurePaths<Routers>]: DesktopIpcExposure;
};

export const DESKTOP_IPC_EXPOSURE = Object.freeze({
  "settings.experiments": "ipc",
  "settings.setExperiment": "ipc",
  "modelAccess.inspect": "ipc",
  "modelAccess.defaults": "ipc",
  "modelAccess.setDefault": "ipc",
  "modelAccess.hiddenModels": "ipc",
  "modelAccess.setHiddenModels": "ipc",
  "modelAccess.compactionPolicy": "ipc",
  "modelAccess.setCompactionPolicy": "ipc",
  "modelAccess.codeModePolicy": "ipc",
  "modelAccess.setCodeModePolicy": "ipc",
  "modelAccess.pickerView": "ipc",
  "modelAccess.setPickerView": "ipc",
  "sessions.create": "ipc",
  "sessions.attach": "ipc",
  "session.snapshot": "ipc",
  "session.history": "ipc",
  "session.projection": "ipc",
  "session.subscribe": "ipc",
  "session.command": "ipc",
  "session.cancelQueued": "ipc",
  "session.editQueued": "ipc",
  "session.cancelInteraction": "ipc",
  "session.reconcile": "ipc",
  // This Mac's own log (VC-699): the dev log viewer's local stream, the same
  // `host.logs` operations a remote host serves over the WebSocket.
  "logs.tail": "ipc",
  "logs.follow": "ipc",
  "session.list": "websocket-only",
  "session.show": "websocket-only",
  "session.peek": "websocket-only",
  "session.answer": "websocket-only",
  "session.subscribeQueue": "websocket-only",
  // A remote host's Session listing (VC-713): the window keeps its own
  // listing IPC (`volli:session-list`), whose rows these are.
  "session.listing": "websocket-only",
  "session.listingForTicket": "websocket-only",
  "protocol.welcome": "websocket-only",
  "protocol.hostWelcome": "websocket-only",
  // Sign-ins on a remote host (VC-702): a connection owns its flows, and the
  // desktop's own window signs in over its own Model Access IPC.
  "signIns.status": "websocket-only",
  "signIns.setApiKey": "websocket-only",
  "signIns.signOut": "websocket-only",
  "signIns.start": "websocket-only",
  "signIns.subscribe": "websocket-only",
  "signIns.answer": "websocket-only",
  "signIns.cancel": "websocket-only",
  "signIns.setGitCredential": "websocket-only",
  "signIns.clearGitCredential": "websocket-only",
  "auth.callback.deliver": "websocket-only",
  "labDiagnostics.list": "lab-only",
  "labDiagnostics.subscribe": "lab-only",
  // The board (VC-565): the desktop window's board with `cloud` on, the same
  // operations a WebSocket client reaches under `board.read`/`board.write`.
  "board.snapshot": "ipc",
  "board.roster": "ipc",
  "board.changes": "ipc",
  "board.projectFolder": "ipc",
  "board.ticketBody": "ipc",
  "board.archivedTickets": "ipc",
  "board.ticketEvents": "ipc",
  "board.latestSignals": "ipc",
  "board.statusEntries": "ipc",
  "board.comments": "ipc",
  "ticket.move": "ipc",
  "board.updateProject": "ipc",
  "board.setSkillModes": "ipc",
  "board.setSessionDefaults": "ipc",
  "board.createTicket": "ipc",
  "board.moveTickets": "ipc",
  "board.setPriority": "ipc",
  "board.updateTicket": "ipc",
  "board.setLabels": "ipc",
  "board.archiveTicket": "ipc",
  "board.unarchiveTicket": "ipc",
  "board.deleteTicket": "ipc",
  "board.createComment": "ipc",
  "board.updateComment": "ipc",
  "board.removeComment": "ipc",
  "board.setLabelColor": "ipc",
  // The desktop-only tier: the window's by definition (`DESKTOP_ENTRIES`).
  // Its compatibility classes (VC-725) govern the schema gate, not exposure:
  // host commands (`project.reorder`, `worktree.trimSettings`) are
  // additive-only across supported skew, while the client-local families
  // (`hosts.*`, `hostAdd.*`, `hostSignIns.*`, `hostLink.*`) ship with this
  // renderer and main in one bundle and are not cross-version promises.
  "project.reorder": "ipc",
  "worktree.trimSettings": "ipc",
  "hosts.snapshot": "ipc",
  "hosts.subscribe": "ipc",
  "hosts.retry": "ipc",
  "hosts.updateHost": "ipc",
  "hosts.cancelScheduledUpdate": "ipc",
  "hosts.signIn": "ipc",
  "hosts.forget": "ipc",
  "hostAdd.start": "ipc",
  "hostAdd.subscribe": "ipc",
  "hostAdd.answer": "ipc",
  "hostAdd.sudoPassword": "ipc",
  "hostAdd.retry": "ipc",
  "hostAdd.cancel": "ipc",
  // Sign-ins on a remote host, from this desktop (VC-702 PR 2).
  "hostSignIns.status": "ipc",
  "hostSignIns.macKeys": "ipc",
  "hostSignIns.sendFromThisMac": "ipc",
  "hostSignIns.setApiKey": "ipc",
  "hostSignIns.setGitCredential": "ipc",
  "hostSignIns.run": "ipc",
  "hostSignIns.answer": "ipc",
  "hostSignIns.cancel": "ipc",
  "hosts.rename": "ipc",
  "hosts.devices": "ipc",
  "hosts.projects": "ipc",
  "hosts.createProject": "ipc",
  "hosts.openWorkspace": "ipc",
  "hosts.closeWorkspace": "ipc",
  "hostAdd.facts": "ipc",
  "hostAdd.active": "ipc",
  // The Workspace link relay (VC-711).
  "hostLink.query": "ipc",
  "hostLink.mutate": "ipc",
  "hostLink.subscribe": "ipc",
} satisfies IpcExposureTable<DesktopIpcRouters>);

type Exposure = typeof DESKTOP_IPC_EXPOSURE;

/** The paths the desktop's own window reaches over IPC. */
export type DesktopIpcPath = {
  [Path in keyof Exposure]: Exposure[Path] extends "ipc" ? Path : never;
}[keyof Exposure];

/** {@link DesktopIpcPath}, at runtime: what the bridge serves. */
export const DESKTOP_IPC_PATHS: readonly DesktopIpcPath[] = Object.freeze(
  (Object.keys(DESKTOP_IPC_EXPOSURE) as (keyof Exposure)[]).filter(
    (path): path is DesktopIpcPath => DESKTOP_IPC_EXPOSURE[path] === "ipc",
  ),
);

/** The desktop renderer's client router: the served paths, with the procedures' own types. */
export type DesktopIpcRouter = IpcClientRouter<DesktopIpcRouters, DesktopIpcPath>;
