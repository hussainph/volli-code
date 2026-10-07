/**
 * What each host state SAYS (VC-576, ported from the VC-615 lab's
 * `#host-health`): the Island's one line and one action, the chip's badge,
 * the switcher's meta line and the detail under the current host, and the
 * toast a recovery earns. Pure, so every state's words are tested here and
 * the views only draw them.
 *
 * Copy follows T20: people see projects and machines ("This Mac",
 * "hetzner-1"), never Workspace, venue or Worker.
 */
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import {
  isBlocking,
  type HostIncompatibility,
  type HostLinkView,
  type HostRecord,
  type HostSignIn,
} from "@renderer/stores/host-connection";

/** The badge on a host's tile. `null` draws none. */
export type HostBadge = "fail" | "attention" | "offline" | null;

export type HostSurfaceTone = "quiet" | "attention" | "error";
export type HostSurfaceIcon = "reconnect" | "offline" | "warning";

/** The one thing a surface's button does. */
export type HostSurfaceAction =
  | { readonly kind: "retry"; readonly label: "Retry now" }
  | { readonly kind: "update-host"; readonly label: "Re-add to update" }
  | { readonly kind: "update-app"; readonly label: "Update Volli" }
  | { readonly kind: "manage-hosts"; readonly label: "Manage hosts…" }
  | { readonly kind: "forget-project"; readonly label: "Forget"; readonly workspaceId: string };

/** One line, at most one action: what the Island says for a state that needs saying. */
export interface HostSurface {
  readonly tone: HostSurfaceTone;
  readonly icon: HostSurfaceIcon;
  readonly line: string;
  /** Quiet trailing context: the countdown. */
  readonly meta?: string;
  readonly action?: HostSurfaceAction;
  /**
   * Waits out {@link HOST_RECONNECT_GRACE_MS} before it shows, so a link that
   * drops for a second and comes back never said anything.
   */
  readonly graced: boolean;
}

/** VC-615's grace: "Reconnecting" says nothing for its first 1.5 s. */
export const HOST_RECONNECT_GRACE_MS = 1_500;

const RETRY: HostSurfaceAction = { kind: "retry", label: "Retry now" };
const UPDATE_HOST: HostSurfaceAction = { kind: "update-host", label: "Re-add to update" };
const UPDATE_APP: HostSurfaceAction = { kind: "update-app", label: "Update Volli" };
const MANAGE_HOSTS: HostSurfaceAction = { kind: "manage-hosts", label: "Manage hosts…" };

/** Whole seconds until `retryAt`, never below zero. */
export function retryCountdown(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/**
 * The Island's words for a host, or `null` when the page should say nothing:
 * open, an available update (the switcher's business, not a banner's) and an
 * expired sign-in (the chip's badge) all stay quiet here.
 */
export function hostSurface(host: HostRecord, now: number): HostSurface | null {
  if (host.update?.status === "running") {
    return { tone: "quiet", icon: "reconnect", line: `Updating ${host.name}`, graced: false };
  }
  const link = host.link;
  switch (link.status) {
    case "connecting":
      return { tone: "quiet", icon: "reconnect", line: `Connecting to ${host.name}`, graced: true };
    case "reconnecting":
      return {
        tone: "quiet",
        icon: "reconnect",
        line: `Reconnecting to ${host.name}`,
        graced: true,
      };
    case "offline": {
      const seconds = link.retryAt === null ? null : retryCountdown(link.retryAt, now);
      return {
        tone: "quiet",
        icon: "offline",
        line: `Can’t reach ${host.name} · Read-only`,
        ...(seconds === null ? {} : { meta: seconds > 0 ? `Retrying in ${seconds}s` : "Retrying" }),
        action: RETRY,
        graced: false,
      };
    }
    case "incompatible":
      if (link.refusalCode === "workspace-unknown") {
        return {
          tone: "error",
          icon: "warning",
          line: `This project isn’t on ${host.name} any more`,
          ...(link.workspaceId === undefined
            ? {}
            : {
                action: {
                  kind: "forget-project",
                  label: "Forget",
                  workspaceId: link.workspaceId,
                } as const,
              }),
          graced: false,
        };
      }
      if (link.reason === "refused" && link.refusalCode) {
        return {
          tone: "error",
          icon: "warning",
          line: `${host.name} refused this connection (${link.refusalCode}) · Read-only`,
          action: MANAGE_HOSTS,
          graced: false,
        };
      }
      return incompatibleSurface(host, link.reason, link.requiredVersion);
    case "open":
    case "version-skewed":
      return null;
  }
}

function incompatibleSurface(
  host: HostRecord,
  reason: HostIncompatibility,
  requiredVersion: string | undefined,
): HostSurface {
  switch (reason) {
    case "host-too-old":
      return {
        tone: "attention",
        icon: "warning",
        line:
          requiredVersion === undefined
            ? `${host.name} needs a newer Volli host · Read-only`
            : `${host.name} needs Volli host ${requiredVersion} · Read-only`,
        action: UPDATE_HOST,
        graced: false,
      };
    case "database-too-new":
      return {
        tone: "error",
        icon: "warning",
        line: `${host.name}’s database is from a newer Volli · Read-only`,
        action: UPDATE_HOST,
        graced: false,
      };
    case "host-too-new":
      return {
        tone: "attention",
        icon: "warning",
        line:
          host.version === null
            ? `${host.name} runs a newer Volli · Read-only`
            : `${host.name} runs Volli ${host.version} · Read-only`,
        action: UPDATE_APP,
        graced: false,
      };
    case "refused":
      return {
        tone: "error",
        icon: "warning",
        line: `${host.name} no longer accepts this Mac · Read-only`,
        action: MANAGE_HOSTS,
        graced: false,
      };
    case "fenced":
      return {
        tone: "error",
        icon: "warning",
        line: `${host.name} no longer serves this project · Read-only`,
        action: MANAGE_HOSTS,
        graced: false,
      };
    case "too-many-projects":
      return {
        tone: "attention",
        icon: "warning",
        line: `Too many projects open on ${host.name} · Read-only`,
        action: MANAGE_HOSTS,
        graced: false,
      };
  }
}

/**
 * The tile's badge. Offline greys, a host that refuses to serve is a failure,
 * and everything a person could act on without losing the board — an update,
 * a version the app or host must catch up to, an expired sign-in — is
 * attention. Reconnecting draws none: the tile pulses instead.
 */
export function hostBadge(host: HostRecord): HostBadge {
  const link = host.link;
  if (link.status === "offline") return "offline";
  if (link.status === "incompatible") {
    return link.reason === "host-too-old" || link.reason === "host-too-new" ? "attention" : "fail";
  }
  if (link.status === "version-skewed" || host.expiredSignIns.length > 0) return "attention";
  return null;
}

/** Whether the chip's tile breathes: a link on its way back, or an update in flight. */
export function hostPulsing(host: HostRecord): boolean {
  return (
    host.link.status === "connecting" ||
    host.link.status === "reconnecting" ||
    host.update?.status === "running"
  );
}

/** "1 Session", "3 Sessions". */
export function countSessions(count: number): string {
  return `${count} ${count === 1 ? "Session" : "Sessions"}`;
}

function countProjects(count: number): string {
  return `${count} ${count === 1 ? "project" : "projects"}`;
}

/** "4:12 PM" today, "Oct 3" before. */
export function formatSince(since: number, now: number, locale?: string): string {
  const then = new Date(since);
  const today = new Date(now);
  const sameDay = then.toDateString() === today.toDateString();
  return sameDay
    ? then.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : then.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** The switcher row's trailing words: what the host is doing, in the fewest. */
export function hostMeta(host: HostRecord, projects: number, now: number, locale?: string): string {
  if (host.update?.status === "running") return "Updating";
  const link = host.link;
  switch (link.status) {
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return `Offline · since ${formatSince(link.since, now, locale)}`;
    case "incompatible":
    case "version-skewed":
      if (host.version !== null) return `Volli host ${host.version}`;
      break;
    case "open":
      break;
  }
  return host.liveSessions !== null && host.liveSessions > 0
    ? `${countSessions(host.liveSessions)} running`
    : countProjects(projects);
}

/**
 * The one thing the current host's row says under its name in the switcher,
 * and the action beside it. The order is what matters most first: an update
 * in flight, a host that cannot serve, an expired sign-in, then an update on
 * offer.
 */
export type HostDetail =
  | { readonly kind: "updating"; readonly progress: number; readonly targetVersion: string }
  | { readonly kind: "offline"; readonly text?: string }
  | { readonly kind: "incompatible"; readonly text: string; readonly action: HostSurfaceAction }
  | { readonly kind: "sign-in"; readonly signIn: HostSignIn }
  | { readonly kind: "update-scheduled" }
  | { readonly kind: "update-available"; readonly version: string };

export function hostDetail(host: HostRecord): HostDetail | null {
  if (host.update?.status === "running") {
    return {
      kind: "updating",
      progress: host.update.progress,
      targetVersion: host.update.targetVersion,
    };
  }
  const link = host.link;
  if (link.status === "offline")
    return {
      kind: "offline",
      ...(link.detail ? { text: `Can’t reach ${host.name} · ${link.detail}` } : {}),
    };
  if (link.status === "incompatible") {
    if (link.refusalCode === "workspace-unknown" && link.workspaceId !== undefined) {
      return {
        kind: "incompatible",
        text: `This project isn’t on ${host.name} any more`,
        action: { kind: "forget-project", label: "Forget", workspaceId: link.workspaceId },
      };
    }
    if (link.reason === "refused" && link.refusalCode) {
      return {
        kind: "incompatible",
        text: `Connection refused (${link.refusalCode})`,
        action: MANAGE_HOSTS,
      };
    }
    return incompatibleDetail(link.reason);
  }
  const signIn = host.expiredSignIns[0];
  if (signIn !== undefined) return { kind: "sign-in", signIn };
  if (link.status === "version-skewed") {
    return host.update?.status === "scheduled"
      ? { kind: "update-scheduled" }
      : { kind: "update-available", version: link.availableVersion };
  }
  return null;
}

function incompatibleDetail(reason: HostIncompatibility): HostDetail {
  switch (reason) {
    case "host-too-old":
      return { kind: "incompatible", text: "Too old for this app", action: UPDATE_HOST };
    case "database-too-new":
      return { kind: "incompatible", text: "Database from a newer Volli", action: UPDATE_HOST };
    case "host-too-new":
      return { kind: "incompatible", text: "Newer than this app", action: UPDATE_APP };
    case "refused":
      return { kind: "incompatible", text: "No longer accepts this Mac", action: MANAGE_HOSTS };
    case "fenced":
      return { kind: "incompatible", text: "No longer serves this project", action: MANAGE_HOSTS };
    case "too-many-projects":
      return { kind: "incompatible", text: "Too many projects open", action: MANAGE_HOSTS };
  }
}

/** A toast a host's recovery earns. */
export interface HostToast {
  readonly title: string;
  readonly description?: string;
}

/**
 * What a change from `before` to `after` (the same host) announces, if
 * anything: coming back after being unreachable, and landing an update.
 */
export function hostTransitionToast(before: HostRecord, after: HostRecord): HostToast | null {
  if (before.local) return null;
  const serving = servingLink(after.link);
  if (before.update?.status === "running" && after.update === null && serving) {
    const version = after.version ?? before.update.targetVersion;
    return {
      title: `${after.name} is on Volli host ${version}`,
    };
  }
  if (before.link.status === "offline" && serving) {
    return after.liveSessions !== null && after.liveSessions > 0
      ? {
          title: `Back on ${after.name}`,
          description: `${countSessions(after.liveSessions)} kept running while you were away`,
        }
      : { title: `Back on ${after.name}` };
  }
  return null;
}

function servingLink(link: HostLinkView): boolean {
  return link.status === "open" || link.status === "version-skewed";
}

/**
 * The "Running on" dot: ready while the host serves, starting on its way back,
 * waiting when it needs the person (an update, an expired sign-in), exited
 * while unreachable and an error when it cannot serve this app.
 */
export function hostDotState(host: HostRecord): StatusDotState {
  if (host.link.status === "offline") return "exited";
  if (isBlocking(host.link)) return "error";
  if (host.link.status === "connecting" || host.link.status === "reconnecting") return "starting";
  if (host.expiredSignIns.length > 0 || host.update !== null) return "waiting";
  return "ready";
}
