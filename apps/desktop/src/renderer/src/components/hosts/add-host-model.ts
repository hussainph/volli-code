/**
 * What the Add-a-host Checklist says (VC-700 PR 3; VC-615 flow 1, the
 * lab's `#host-add` "Checklist" direction): pure, so every word and every
 * recovery is tested without a sheet.
 *
 * Each step has a noun while it waits ("Install") and a verb while it runs
 * ("Installing Volli host"). A stopped flow says one line and offers one
 * recovery (plus Back): a question's comes from its kind, a failure's from
 * `@volli/host-install` itself (`AddHostFailure.line` / `.recovery`), so the
 * words for a typed failure live in one place.
 */
import type {
  AddHostQuestion,
  AddHostStepId,
  AddHostStepStatus,
  AddHostView,
  RemoteHost,
} from "@volli/shared";

import type { StepMarkStatus } from "./host-parts";
import type { HostBadge } from "./host-surface-model";

const STEP_WORDS: Readonly<Record<AddHostStepId, { noun: string; verb: string }>> = {
  connect: { noun: "Connect", verb: "Connecting" },
  probe: { noun: "Check the system", verb: "Checking the system" },
  deliver: { noun: "Upload Volli host", verb: "Uploading Volli host" },
  install: { noun: "Install", verb: "Installing Volli host" },
  start: { noun: "Start", verb: "Starting Volli host" },
  enroll: { noun: "Pair this Mac", verb: "Pairing this Mac" },
  link: { noun: "Open the connection", verb: "Opening the connection" },
};

export interface StepRow {
  readonly id: AddHostStepId;
  readonly mark: StepMarkStatus;
  /** The noun, the verb with an ellipsis while it runs. */
  readonly label: string;
  /** Said beside a step that did not need to run. */
  readonly detail: string | null;
}

function markOf(status: AddHostStepStatus, waiting: boolean): StepMarkStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return waiting ? "attention" : "active";
    case "done":
    case "skipped":
      return "done";
    case "failed":
      return "failed";
  }
}

/** The checklist's rows, in the flow's order. */
export function stepRows(view: AddHostView): StepRow[] {
  const waiting = view.status === "question";
  return view.steps.map(({ id, status }) => {
    const mark = markOf(status, waiting);
    const words = STEP_WORDS[id];
    return {
      id,
      mark,
      label: mark === "active" ? `${words.verb}…` : words.noun,
      detail: status === "skipped" ? "Already in place" : null,
    };
  });
}

/** The sheet's host tile badge: the flow's state, at a glance. */
export function flowBadge(view: AddHostView): HostBadge {
  if (view.status === "failed") return "fail";
  if (view.status === "question") return "attention";
  return null;
}

/** What a question asks the person to do. Every one also offers Back. */
export type QuestionPrompt =
  | {
      readonly kind: "host-key";
      readonly line: string;
      readonly fingerprints: readonly { readonly type: string; readonly fingerprint: string }[];
      readonly action: string;
    }
  | {
      readonly kind: "existing-hostd";
      readonly line: string;
      readonly note: string;
      /** "Use 0.2.4": keep the one running, when it can be managed. */
      readonly adopt: string | null;
      readonly action: string;
    }
  | { readonly kind: "already-paired"; readonly line: string; readonly action: string }
  | {
      readonly kind: "sudo-password";
      readonly line: string;
      readonly command: string;
      readonly placeholder: string;
      /** The last password was wrong. */
      readonly retry: boolean;
      /** Installing for every account can instead be for this login only. */
      readonly userInstall: { readonly label: string; readonly note: string } | null;
      readonly action: string;
    }
  | {
      readonly kind: "identity-changed";
      readonly line: string;
      readonly note: string;
      readonly action: string;
    }
  /** A question this build does not know: it can only go back. */
  | { readonly kind: "unknown"; readonly line: string };

const text = (value: unknown, fallback: string): string =>
  typeof value === "string" && value !== "" ? value : fallback;

function fingerprintsOf(offer: unknown): { type: string; fingerprint: string }[] {
  const list = (offer as { fingerprints?: unknown } | null)?.fingerprints;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    const { type, fingerprint } = (entry ?? {}) as { type?: unknown; fingerprint?: unknown };
    return typeof fingerprint === "string"
      ? [{ type: typeof type === "string" ? type : "", fingerprint }]
      : [];
  });
}

const SUDO_LINES: Readonly<Record<string, string>> = {
  install: "Installing for every account needs sudo",
  linger: "Keeping it running after you log out needs sudo",
  enroll: "Pairing with this install needs sudo",
};

/** The line the person reads, and what they can do, for the question a flow stopped on. */
export function questionPrompt(question: AddHostQuestion, host: string): QuestionPrompt {
  switch (question.kind) {
    case "host-key":
      return {
        kind: "host-key",
        line: `This Mac hasn’t seen ${host}’s key before`,
        fingerprints: fingerprintsOf(question["offer"]),
        action: "Trust and continue",
      };
    case "existing-hostd": {
      const version = text(question["version"], "an older version");
      return {
        kind: "existing-hostd",
        line: `Volli host ${version} is already running here`,
        note: "Its workspaces stay either way.",
        adopt: question["adoptable"] === true ? `Use ${version}` : null,
        action: "Update and pair",
      };
    }
    case "already-paired":
      return {
        kind: "already-paired",
        line: `This Mac is already paired with ${host}`,
        action: `Open ${host}`,
      };
    case "sudo-password": {
      const reason = text(question["reason"], "install");
      return {
        kind: "sudo-password",
        line:
          question["retry"] === true
            ? "That password didn’t work"
            : (SUDO_LINES[reason] ?? "This step needs sudo"),
        command: text(question["command"], "sudo"),
        placeholder: "sudo password",
        retry: question["retry"] === true,
        userInstall:
          reason === "install"
            ? {
                label: "Install for my account only",
                note: `Agents on ${host} will share your account.`,
              }
            : null,
        action: "Run it",
      };
    }
    case "identity-changed":
      return {
        kind: "identity-changed",
        line: `${host} has a new identity`,
        note: "It was restored or reinstalled. Devices paired before must pair again.",
        action: "Pair again",
      };
    default:
      return { kind: "unknown", line: `${host} asked something this build can’t answer` };
  }
}

const OS_NAMES = { linux: "Linux", macos: "macOS" } as const;

/** The finished sheet's one-line summary: "Linux · Volli host 1.1.0". */
export function readySummary(host: RemoteHost | undefined): string {
  if (host === undefined) return "Ready";
  const parts: string[] = [];
  if (host.os !== null) parts.push(OS_NAMES[host.os]);
  if (host.version !== null) parts.push(`Volli host ${host.version}`);
  return parts.length === 0 ? "Ready" : parts.join(" · ");
}

/**
 * The facts a finished add states once: when it starts on its own (a Mac's
 * at login, `AddHostView.startup`) and whose account its agents run as.
 */
export function readyFacts(view: AddHostView, host: RemoteHost | undefined): string[] {
  const facts: string[] = [];
  if (view.startup !== null) facts.push(view.startup);
  if (host?.agentsShareAccount === true) facts.push(agentsShareAccountLine(host.name));
  return facts;
}

/** The "agents share your account" state, in one place (VC-700, owner ruling). */
export function agentsShareAccountLine(host: string): string {
  return `Agents on ${host} share your account`;
}

/** What `you@box`-ish text the field accepts: no spaces, something before any `:`. */
export function validTarget(raw: string): boolean {
  const value = raw.trim();
  return value !== "" && !/\s/u.test(value) && !value.startsWith("-") && !value.startsWith(":");
}
