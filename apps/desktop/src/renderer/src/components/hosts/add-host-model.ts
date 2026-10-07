/**
 * What the Add-a-host Checklist says (VC-700 PR 3; VC-615 flow 1, the
 * lab's `#host-add` "Checklist" direction): pure, so every word and every
 * recovery is tested without a sheet.
 *
 * Five rows, the lab's: Connect, Check the system, Install (uploading
 * included), Start and Pair (opening the connection included). Each has a
 * noun while it waits ("Install"), a verb while it runs ("Installing Volli
 * host…") and, once done, what it found ("Volli host 1.1.0"), read from the
 * flow's facts (`hostAdd.facts`), never made up: where nothing was found,
 * the noun. A stopped flow says one line and offers one recovery (plus Back): a question's comes from its kind, a failure's from
 * `@volli/host-install` itself (`AddHostFailure.line` / `.recovery`), so the
 * words for a typed failure live in one place.
 */
import type {
  AddHostFacts,
  AddHostQuestion,
  AddHostStepId,
  AddHostStepStatus,
  AddHostView,
  RemoteHost,
} from "@volli/shared";

import type { StepMarkStatus } from "./host-parts";
import type { HostBadge } from "./host-surface-model";

/**
 * A flow's view with what it has found so far: main streams the view and
 * answers its facts beside it (`hostAdd.facts`, read on each view).
 */
export type AddHostFlowView = AddHostView & { readonly facts: AddHostFacts };

/** An add that has found nothing yet (or whose facts have not arrived). */
export const NO_FACTS: AddHostFacts = Object.freeze({
  user: null,
  os: null,
  system: null,
  arch: null,
  memoryBytes: null,
  version: null,
  keepsRunning: null,
  alreadyPaired: false,
});

/** The checklist's five rows, the lab's (`#host-add`): seven steps underneath. */
export type ChecklistRowId = "connect" | "check" | "install" | "start" | "pair";

const ROW_STEPS: Readonly<Record<ChecklistRowId, readonly AddHostStepId[]>> = {
  connect: ["connect"],
  check: ["probe"],
  // Uploading is part of installing; opening the connection, of pairing.
  install: ["deliver", "install"],
  start: ["start"],
  pair: ["enroll", "link"],
};

const ROW_ORDER: readonly ChecklistRowId[] = ["connect", "check", "install", "start", "pair"];

const NOUNS: Readonly<Record<ChecklistRowId, string>> = {
  connect: "Connect",
  check: "Check the system",
  install: "Install",
  start: "Start",
  pair: "Pair",
};

export interface StepRow {
  readonly id: ChecklistRowId;
  readonly mark: StepMarkStatus;
  /** The noun while it waits, the verb while it runs, and what it found once done. */
  readonly label: string;
  /** Said beside a row that did not need to run. */
  readonly detail: string | null;
}

/** "8 GB", "512 MB": memory as people read it. */
export function memoryText(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${Math.round(gb)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function verbOf(id: ChecklistRowId, name: string): string {
  switch (id) {
    case "connect":
      return `Connecting to ${name}`;
    case "check":
      return "Checking the system";
    case "install":
      return "Installing Volli host";
    case "start":
      return "Starting";
    case "pair":
      return "Pairing";
  }
}

/** What a done row found, from the flow's facts; the noun where it found nothing to say. */
function foundOf(id: ChecklistRowId, view: AddHostFlowView): string {
  const { facts } = view;
  switch (id) {
    case "connect":
      return facts.user === null ? NOUNS.connect : `Connected as ${facts.user}`;
    case "check": {
      const parts = [
        facts.system,
        facts.arch,
        facts.memoryBytes === null ? null : memoryText(facts.memoryBytes),
      ].filter((part): part is string => part !== null);
      return parts.length === 0 ? NOUNS.check : parts.join(" · ");
    }
    case "install":
      return facts.version === null ? NOUNS.install : `Volli host ${facts.version}`;
    case "start":
      if (facts.keepsRunning === true) return "Keeps running when you log out";
      if (facts.keepsRunning === false) return "Stops when you log out";
      return view.startup ?? NOUNS.start;
    case "pair":
      return facts.alreadyPaired ? "Already paired with this Mac" : "Paired with this Mac";
  }
}

/** One row's mark, from the steps under it. */
function rowMark(statuses: readonly AddHostStepStatus[], view: AddHostFlowView): StepMarkStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("running")) return view.status === "question" ? "attention" : "active";
  const finished = statuses.filter((status) => status === "done" || status === "skipped");
  if (finished.length === statuses.length) return "done";
  // Halfway through its steps (uploaded, not yet installing): still under way.
  return finished.length > 0 && view.status === "running" ? "active" : "pending";
}

/** The checklist's rows: five, each saying what it found once done. */
export function stepRows(view: AddHostFlowView): StepRow[] {
  const status = new Map(view.steps.map((step) => [step.id, step.status]));
  // Already paired: the check found it, and pairing is in place; nothing else need run.
  const paired = view.question?.kind === "already-paired";
  return ROW_ORDER.map((id) => {
    const statuses = ROW_STEPS[id].map((step) => status.get(step) ?? "pending");
    let mark = rowMark(statuses, view);
    if (paired && (id === "check" || id === "pair")) mark = "done";
    const label =
      paired && id === "pair"
        ? "Already paired with this Mac"
        : mark === "done"
          ? foundOf(id, view)
          : mark === "active"
            ? `${verbOf(id, view.name)}…`
            : NOUNS[id];
    return {
      id,
      mark,
      label,
      detail: statuses.every((step) => step === "skipped") ? "Already in place" : null,
    };
  });
}

/** The sheet's host tile badge: the flow's state, at a glance; a check once it is ready. */
export function flowBadge(view: AddHostFlowView): HostBadge | "ready" {
  if (view.status === "done") return "ready";
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

/**
 * The finished sheet's one-line summary, from what the add found:
 * "Ubuntu 24.04.1 LTS · x86-64 · Volli host 1.1.0"; the registry's OS where
 * the add did not say.
 */
export function readySummary(view: AddHostFlowView, host: RemoteHost | undefined): string {
  const { facts } = view;
  const os = facts.os ?? host?.os ?? null;
  const version = facts.version ?? host?.version ?? null;
  const parts = [
    facts.system ?? (os === null ? null : OS_NAMES[os]),
    facts.arch,
    version === null ? null : `Volli host ${version}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Ready" : parts.join(" · ");
}

/**
 * The facts a finished add states once: when it starts on its own (a Mac's
 * at login, `AddHostView.startup`) and whose account its agents run as.
 */
export function readyFacts(view: AddHostFlowView, host: RemoteHost | undefined): string[] {
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

/** Once upload/install may have changed the box, leaving is an explicit confirmation. */
export function cancelNeedsConfirmation(view: AddHostView | null): boolean {
  if (view === null || view.status === "done" || view.status === "cancelled") return false;
  return view.steps.some(
    ({ id, status }) =>
      ["deliver", "install", "start", "enroll", "link"].includes(id) &&
      (status === "running" || status === "done" || status === "failed"),
  );
}

/** known_hosts indexes the SSH host, not its login user; nonstandard ports use brackets. */
export function changedHostKeyCommand(target: string, detail: string | null = null): string | null {
  // OpenSSH names its actual known_hosts lookup key in this diagnostic,
  // including HostName/HostKeyAlias and a nonstandard configured port.
  const reported = /Host key for (\S+) has changed/u.exec(detail ?? "")?.[1];
  if (reported !== undefined) {
    const command = commandForKnownHost(reported);
    if (command !== null) return command;
  }
  const match =
    /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?([A-Za-z0-9_][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/u.exec(
      target.trim(),
    );
  if (match === null) return null;
  const host = match[1]!.replace(/^\[|\]$/gu, "");
  const port = match[2] === undefined ? 22 : Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  const key = port === 22 ? host : `[${host}]:${port}`;
  return commandForKnownHost(key);
}

function commandForKnownHost(key: string): string | null {
  if (/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(key)) return `ssh-keygen -R ${key}`;
  if (/^[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*$/u.test(key)) return `ssh-keygen -R '${key}'`;
  const match =
    /^\[(?:[A-Za-z0-9_][A-Za-z0-9._-]*|[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*)\]:(\d{1,5})$/u.exec(key);
  if (match === null || Number(match[1]) < 1 || Number(match[1]) > 65_535) return null;
  return `ssh-keygen -R '${key}'`;
}
