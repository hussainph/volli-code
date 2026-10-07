/**
 * "Open a project on <host>…" (VC-710), as its sheet reads it: pure. The
 * host's projects are read from it over SSH each time the sheet opens
 * (`hosts.projects`); a row opens one on this Mac (`hosts.openWorkspace`),
 * and "New project…" makes one there from a git URL or a folder on the host
 * (`hosts.createProject`), then opens it.
 *
 * Every state that is not a list says one line and offers one recovery: a
 * retry, "New project…", or a command to run once on the host, with Copy.
 * Words: the host's own name, "project" and "this Mac"; never Workspace.
 */
import type { RemoteHostProject, RemoteHostProjects, RemoteProjectFailure } from "@volli/shared";

/** The host's list, as the sheet holds it while it reads, and after. */
export type ProjectListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly listing: RemoteHostProjects }
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
  projects: readonly RemoteHostProject[],
  opened: ReadonlySet<string>,
): readonly ProjectRowView[] {
  return projects
    .map((project) => ({
      id: project.id,
      name: project.name,
      meta: `${project.prefix} · ${project.path} · ${tickets(project.tickets)}`,
      opened: opened.has(project.id),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The one recovery a notice offers. */
export type NoticeRecovery =
  | { readonly kind: "retry"; readonly label: string }
  | { readonly kind: "new"; readonly label: string }
  | { readonly kind: "copy"; readonly command: string };

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
      return projects.length > 0
        ? null
        : {
            line: `${hostName} runs Volli as your login, so this Mac can’t add projects to it.`,
            recovery: { kind: "retry", label: "Refresh" },
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

/** Whether "New project…" is offered: never where the login cannot add one. */
export function canCreate(state: ProjectListState): boolean {
  return state.kind !== "ready" || state.listing.adds.kind !== "user-install";
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
  if (source.kind === "path" && !source.path.startsWith("/") && !source.path.startsWith("~/")) {
    return `A folder on ${hostName} is a full path, like /srv/volli/app.`;
  }
  return null;
}

/** The field's hint: where a clone goes, which a folder is not. */
export function sourceHint(source: ProjectSource | null): string {
  return source?.kind === "git"
    ? "Cloned into /srv/volli on the host, then added."
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
  failure: RemoteProjectFailure,
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
