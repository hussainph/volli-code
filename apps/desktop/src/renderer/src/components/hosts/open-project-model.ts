/**
 * "Open a project on <host>…", as its sheet reads it: pure. Modern hosts
 * answer the HOST-scoped workspaces catalog before any Workspace is open.
 * Legacy rows still carry their SSH catalog's prefix and ticket counts;
 * HOST rows don't invent either. Open/Close remain desktop registry actions.
 *
 * Every state that is not a list says one line and offers one recovery: a
 * retry, "New project…", or Re-add, or a legacy command to run once on the host, with Copy.
 * Words: the host's own name, "project" and "this Mac"; never Workspace.
 */
import type {
  HostWorkspace,
  HostWorkspaceCreateResult,
  RemoteHostProject,
  RemoteHostProjects,
  RemoteProjectFailure,
} from "@volli/shared";

/** Modern rows intentionally have no prefix or ticket count. */
export type HostProject = RemoteHostProject | HostWorkspace;
export interface HostProjectsListing {
  readonly hostId: string;
  readonly projects: readonly HostProject[];
  readonly adds: RemoteHostProjects["adds"];
  readonly omitted?: number;
}
export type ProjectFailure =
  | RemoteProjectFailure
  | (Extract<HostWorkspaceCreateResult, { ok: false }>["failure"] & { readonly command: null });
export type ProjectCreateResult =
  | { readonly ok: true; readonly project: HostProject }
  | { readonly ok: false; readonly failure: ProjectFailure };

/** The host's list, as the sheet holds it while it reads, and after. */
export type ProjectListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly listing: HostProjectsListing }
  | { readonly kind: "error"; readonly message: string };

/** One project on the host, as its row says it. */
export interface ProjectRowView {
  readonly id: string;
  readonly name: string;
  /** `AC · /srv/volli/acme · 3 tickets` */
  readonly meta: string;
  /** Already open on this Mac: the row offers Close instead of Open. */
  readonly opened: boolean;
}

const tickets = (count: number): string => (count === 1 ? "1 ticket" : `${count} tickets`);

/** The host's projects, by name, each marked when this Mac has it open. */
export function projectRows(
  projects: readonly HostProject[],
  opened: ReadonlySet<string>,
): readonly ProjectRowView[] {
  return projects
    .map((project) => ({
      id: project.id,
      name: project.name,
      meta:
        "prefix" in project
          ? `${project.prefix} · ${project.path} · ${tickets(project.tickets)}`
          : project.path,
      opened: opened.has(project.id),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The one recovery a notice offers. */
export type NoticeRecovery =
  | { readonly kind: "retry"; readonly label: string }
  | { readonly kind: "new"; readonly label: string }
  | { readonly kind: "copy"; readonly command: string }
  | { readonly kind: "re-add"; readonly label: string };

/** A state's one line and one recovery. */
export interface ProjectNotice {
  readonly line: string;
  readonly recovery: NoticeRecovery;
}

/**
 * What the sheet says instead of (or under) its list: why it could not read
 * the host, that the host has no project yet, or the one command that lets
 * this Mac add one. `null` while it reads, and for a list with nothing to add.
 */
export function listNotice(state: ProjectListState, hostName: string): ProjectNotice | null {
  if (state.kind === "loading") return null;
  if (state.kind === "error") {
    return { line: state.message, recovery: { kind: "retry", label: "Try again" } };
  }
  const { adds, projects } = state.listing;
  switch (adds.kind) {
    case "needs-operator":
      return {
        line: `Run this once on ${hostName} so this Mac can add projects there.`,
        recovery: { kind: "copy", command: adds.command },
      };
    case "user-install":
      return {
        line: `Update ${hostName} to create projects from here`,
        recovery: { kind: "re-add", label: "Re-add" },
      };
    case "ready":
      return projects.length > 0
        ? null
        : {
            line: `No projects on ${hostName} yet.`,
            recovery: { kind: "new", label: "New project…" },
          };
  }
}

/**
 * Whether the list offers "New project…" beside it: only on a host that
 * listed and can take one. Every other state has its own one recovery
 * (Try again, the command to Copy, or New project… as the empty state's).
 */
export function canCreate(state: ProjectListState): boolean {
  return state.kind === "ready" && state.listing.adds.kind === "ready";
}

/** What the person typed in "New project…": a git URL to clone, or a folder on the host. */
export type ProjectSource =
  | { readonly kind: "git"; readonly gitUrl: string }
  | { readonly kind: "path"; readonly path: string };

const SCP_LIKE = /^[^\s/@]+@[^\s/:]+:\S/u;

/** Reads the one field: a URL (or `git@host:path`) is cloned, anything else is a folder. */
export function projectSource(text: string): ProjectSource | null {
  const value = text.trim();
  if (value === "") return null;
  return value.includes("://") || SCP_LIKE.test(value)
    ? { kind: "git", gitUrl: value }
    : { kind: "path", path: value };
}

/**
 * Why the field cannot be sent yet, in one line, or `null`. The host judges
 * the rest (a folder it cannot see, a URL it will not clone) in its own.
 */
export function sourceProblem(source: ProjectSource | null, hostName: string): string | null {
  if (source === null) return null;
  // A token rides in a query, a fragment or a URL's password: it never leaves this window.
  if (
    source.kind === "git" &&
    (/[?#%]/u.test(source.gitUrl) || /:\/\/[^/@]*:[^/@]*@/u.test(source.gitUrl))
  ) {
    return `Use the repository's plain URL: a token goes in Sign-ins on ${hostName}, not in the URL.`;
  }
  if (source.kind === "path" && !source.path.startsWith("/") && !source.path.startsWith("~/")) {
    return `A folder on ${hostName} is a full path, like /srv/volli/app.`;
  }
  return null;
}

/** The field's hint: where a clone goes, which a folder is not. */
export function sourceHint(source: ProjectSource | null, modern = false): string {
  return source?.kind === "git"
    ? modern
      ? "Cloned on the host, then added."
      : "Cloned into /srv/volli on the host, then added."
    : "A git URL, or a folder already on the host.";
}

/** The busy line while a create runs. */
export function creatingLine(source: ProjectSource, hostName: string): string {
  return source.kind === "git" ? `Cloning on ${hostName}…` : `Adding it on ${hostName}…`;
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "That didn’t work.";

/** The toast for a call that threw rather than answered. */
export function failedLine(
  what: "open" | "close" | "create",
  name: string,
  error: unknown,
): string {
  const verb = what === "open" ? "open" : what === "close" ? "close" : "add";
  return `Couldn’t ${verb} ${name}: ${messageOf(error)}`;
}

/** How many times the sheet asks for a sudo password before it stops asking. */
export const SUDO_TRIES = 2;

/**
 * What a create's refusal offers beside its line: the sudo password field
 * (asked again once after a wrong one), Sign-ins on the host (a token for
 * the git host), or just trying again.
 */
export type FailureRecovery =
  | { readonly kind: "password"; readonly again: boolean }
  | { readonly kind: "sign-ins"; readonly label: string }
  | { readonly kind: "retry" };

export function failureRecovery(
  failure: ProjectFailure,
  hostName: string,
  tries: number,
): FailureRecovery {
  switch (failure.code) {
    case "needs-password":
      return { kind: "password", again: false };
    case "wrong-password":
      return tries < SUDO_TRIES ? { kind: "password", again: true } : { kind: "retry" };
    case "needs-credential":
      return { kind: "sign-ins", label: `Sign-ins on ${hostName}…` };
    default:
      return { kind: "retry" };
  }
}

/** One id for an accepted intent, including explicit retries after an ambiguous answer. */
export function createProjectIntent(newId: () => string = () => crypto.randomUUID()) {
  let accepted: { key: string; commandId: string } | null = null;
  return {
    edited() {
      accepted = null;
    },
    accept(source: ProjectSource, name: string): string {
      const key = JSON.stringify([source, name.trim()]);
      if (accepted?.key !== key) accepted = { key, commandId: newId() };
      return accepted.commandId;
    },
  };
}
