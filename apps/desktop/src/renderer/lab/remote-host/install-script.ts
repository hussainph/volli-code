/**
 * The SSH install, as a script: connect → check → install → start → pair,
 * with every failure the brief names reachable by choosing an outcome.
 *
 * Each step has three faces — a NOUN while it waits ("Install"), a VERB while
 * it runs ("Installing Volli host 0.3.0") and a FACT when it lands ("Volli
 * host 0.3.0"). The fact is the design: a finished install reads as a short
 * description of the box you now own, not a list of chores that happened.
 */
import { APP_VERSION, FACTS, type HostOs, type Outcome } from "./fixtures";
import type { StepStatus } from "./parts";
import type { ScriptIo } from "./script";

export type StepId = "connect" | "check" | "install" | "start" | "pair";

export const STEP_ORDER: readonly StepId[] = ["connect", "check", "install", "start", "pair"];

export const STEP_NOUN: Record<StepId, string> = {
  connect: "Connect",
  check: "Check the system",
  install: "Install",
  start: "Start",
  pair: "Pair",
};

/** How much of the bar each step owns — install is most of the wait. */
const STEP_WEIGHT: Record<StepId, number> = {
  connect: 0.1,
  check: 0.1,
  install: 0.55,
  start: 0.1,
  pair: 0.15,
};

export interface StepState {
  status: StepStatus;
  label: string;
  /** Trailing, quiet: "18 of 48 MB", "0.4s". */
  detail?: string;
  progress?: number;
}

export interface LogLine {
  id: number;
  kind: "cmd" | "out" | "ok" | "err";
  text: string;
}

export interface Target {
  alias: string;
  user: string;
  hostname: string;
  port?: number;
}

export interface InstallState {
  target: Target;
  os: HostOs | null;
  /** Chips learned so far: system, arch, memory. */
  facts: string[];
  steps: Record<StepId, StepState>;
  log: LogLine[];
  phase: "running" | "blocked" | "done" | "back" | "opened";
  /** The version that ended up running. */
  version: string;
}

export type Question =
  | { kind: "unreachable"; step: "connect" }
  | { kind: "password"; step: "connect" }
  | { kind: "passphrase"; step: "connect"; key: string }
  | { kind: "unsupported"; step: "check"; system: string }
  | { kind: "disk"; step: "check"; free: string; need: string }
  | { kind: "older"; step: "check"; version: string; workspaces: number }
  | { kind: "paired"; step: "check" }
  | { kind: "linger"; step: "start"; user: string }
  | { kind: "identity"; step: "pair" };

export type Answer =
  | { action: "retry" }
  | { action: "secret"; value: string; remember: boolean }
  | { action: "update" }
  | { action: "adopt" }
  | { action: "back" }
  | { action: "open" }
  | { action: "repair" };

export function initialInstall(target: Target): InstallState {
  return {
    target,
    os: null,
    facts: [],
    steps: {
      connect: { status: "pending", label: STEP_NOUN.connect },
      check: { status: "pending", label: STEP_NOUN.check },
      install: { status: "pending", label: STEP_NOUN.install },
      start: { status: "pending", label: STEP_NOUN.start },
      pair: { status: "pending", label: STEP_NOUN.pair },
    },
    log: [],
    phase: "running",
    version: APP_VERSION,
  };
}

/** 0→1 across the whole install, for the drawings that show one bar. */
export function overallProgress(state: InstallState): number {
  let total = 0;
  for (const id of STEP_ORDER) {
    const step = state.steps[id];
    if (step.status === "done") total += STEP_WEIGHT[id];
    else if (step.status === "active") total += STEP_WEIGHT[id] * (step.progress ?? 0.35);
  }
  return Math.min(1, total);
}

export function currentStep(state: InstallState): StepId | null {
  return (
    STEP_ORDER.find((id) => {
      const status = state.steps[id].status;
      return status === "active" || status === "failed" || status === "attention";
    }) ?? null
  );
}

let lineId = 0;

export function installScript(outcome: Outcome, target: Target) {
  return async (io: ScriptIo<InstallState, Question, Answer>): Promise<void> => {
    const set = (id: StepId, patch: Partial<StepState>) =>
      io.update((state) => ({
        ...state,
        steps: { ...state.steps, [id]: { ...state.steps[id], ...patch } },
      }));
    const log = (kind: LogLine["kind"], text: string) =>
      io.update((state) => ({ ...state, log: [...state.log, { id: (lineId += 1), kind, text }] }));
    const phase = (value: InstallState["phase"]) =>
      io.update((state) => ({ ...state, phase: value }));
    const ask = async (question: Question): Promise<Answer> => {
      phase("blocked");
      const answer = await io.ask(question);
      phase("running");
      return answer;
    };
    const { alias, user, hostname } = target;
    const os: HostOs = outcome === "success-mac" ? "macos" : "linux";
    const facts = FACTS[os];

    /* ── connect ── */
    set("connect", { status: "active", label: `Connecting to ${alias}` });
    log("cmd", `ssh ${user}@${hostname}${target.port ? ` -p ${target.port}` : ""}`);
    await io.wait(900);

    if (outcome === "unreachable") {
      log("err", `ssh: connect to host ${hostname} port 22: Operation timed out`);
      set("connect", { status: "failed", label: `Couldn’t reach ${alias}` });
      const answer = await ask({ kind: "unreachable", step: "connect" });
      if (answer.action === "back") return phase("back");
      set("connect", { status: "active", label: `Connecting to ${alias}` });
      log("cmd", `ssh ${user}@${hostname}`);
      await io.wait(1100);
    }

    let keyAdded = false;
    if (outcome === "password") {
      log("out", "Permission denied (publickey).");
      log("out", "Server allows: password");
      set("connect", { status: "attention", label: `${alias} asked for a password` });
      const answer = await ask({ kind: "password", step: "connect" });
      if (answer.action === "back") return phase("back");
      set("connect", { status: "active", label: `Connecting to ${alias}` });
      await io.wait(700);
      log("ok", "Authenticated with password");
      if (answer.action === "secret" && answer.remember) {
        log("cmd", "cat >> ~/.ssh/authorized_keys  # this Mac’s ed25519 key");
        await io.wait(400);
        keyAdded = true;
      }
    }

    if (outcome === "passphrase") {
      log("out", "Permission denied (publickey).");
      log("out", "~/.ssh/id_ed25519 is locked and not in ssh-agent");
      set("connect", { status: "attention", label: "Your SSH key is locked" });
      const answer = await ask({ kind: "passphrase", step: "connect", key: "~/.ssh/id_ed25519" });
      if (answer.action === "back") return phase("back");
      set("connect", { status: "active", label: `Connecting to ${alias}` });
      log("cmd", "ssh-add --apple-use-keychain ~/.ssh/id_ed25519");
      await io.wait(800);
    }

    log("ok", "Authenticated (publickey ED25519)");
    set("connect", {
      status: "done",
      label: keyAdded ? `Connected as ${user} · key added` : `Connected as ${user}`,
    });

    /* ── check ── */
    set("check", { status: "active", label: "Checking the system" });
    log("cmd", "uname -sm; cat /etc/os-release; df -h ~; systemctl --user --version");
    await io.wait(700);

    if (outcome === "unsupported") {
      io.update((state) => ({ ...state, os: "linux", facts: ["Raspberry Pi OS", "arm64"] }));
      log("out", "Linux aarch64 · Debian GNU/Linux 12 (bookworm)");
      set("check", { status: "failed", label: "arm64 Linux isn’t supported yet" });
      await ask({ kind: "unsupported", step: "check", system: "arm64" });
      return phase("back");
    }

    io.update((state) => ({ ...state, os, facts: [facts.system] }));
    log("out", os === "linux" ? "Linux x86_64 · Ubuntu 24.04.1 LTS" : "Darwin arm64 · macOS 15.4");
    await io.wait(350);
    io.update((state) => ({ ...state, facts: [facts.system, facts.arch] }));
    await io.wait(300);

    if (outcome === "disk-full") {
      log("out", "/home/deploy  96M available");
      set("check", { status: "failed", label: "96 MB free · needs 420 MB" });
      const answer = await ask({ kind: "disk", step: "check", free: "96 MB", need: "420 MB" });
      if (answer.action === "back") return phase("back");
      set("check", { status: "active", label: "Checking the system" });
      log("cmd", "df -h ~");
      await io.wait(800);
      log("out", "/home/deploy  1.2G available");
    }

    io.update((state) => ({ ...state, facts: [facts.system, facts.arch, facts.memory] }));

    if (outcome === "already-paired") {
      log("out", `volli-hostd ${APP_VERSION} · serving · host 7f3a…c21e`);
      set("check", { status: "done", label: `${facts.system} · ${facts.arch} · ${facts.memory}` });
      set("pair", { status: "done", label: "Already paired with this Mac" });
      const answer = await ask({ kind: "paired", step: "check" });
      return phase(answer.action === "open" ? "opened" : "back");
    }

    let adopt = false;
    if (outcome === "older-hostd") {
      log("out", "volli-hostd 0.2.4 · serving · 2 workspaces");
      set("check", { status: "attention", label: "Volli host 0.2.4 is already running" });
      const answer = await ask({ kind: "older", step: "check", version: "0.2.4", workspaces: 2 });
      if (answer.action === "back") return phase("back");
      adopt = answer.action === "adopt";
    }
    set("check", { status: "done", label: `${facts.system} · ${facts.arch} · ${facts.memory}` });

    /* ── install ── */
    if (adopt) {
      set("install", { status: "done", label: "Volli host 0.2.4" });
      set("start", { status: "done", label: "Already running" });
      io.update((state) => ({ ...state, version: "0.2.4" }));
    } else {
      const updating = outcome === "older-hostd";
      const total = 48;
      set("install", {
        status: "active",
        label: updating
          ? `Updating to Volli host ${APP_VERSION}`
          : `Installing Volli host ${APP_VERSION}`,
        progress: 0,
        detail: `0 of ${total} MB`,
      });
      log(
        "cmd",
        `scp volli-hostd-${APP_VERSION}-${os === "linux" ? "linux-x64" : "darwin-arm64"}.tar.zst ${alias}:~/.volli/`,
      );
      await io.tween(3600, (fraction) => {
        const eased = 1 - (1 - fraction) ** 1.6;
        set("install", { progress: eased, detail: `${Math.round(eased * total)} of ${total} MB` });
      });
      log("out", `${total}.2 MB sent · sha256 verified`);
      log(
        "cmd",
        "tar -xf ~/.volli/volli-hostd.tar.zst -C ~/.volli/hostd && ~/.volli/hostd/bin/volli-hostd --version",
      );
      set("install", { detail: undefined, progress: 1 });
      await io.wait(500);
      log("out", `volli-hostd ${APP_VERSION}`);
      if (updating) log("ok", "Migrated 2 workspaces · backups kept in ~/.volli/backups");
      set("install", { status: "done", label: `Volli host ${APP_VERSION}`, detail: undefined });

      /* ── start ── */
      set("start", { status: "active", label: "Starting" });
      if (os === "linux") {
        log("cmd", "volli-hostd install --user && systemctl --user enable --now volli-hostd");
      } else {
        log("cmd", "launchctl bootstrap gui/501 ~/Library/LaunchAgents/dev.volli.hostd.plist");
      }
      await io.wait(900);
      if (outcome === "no-linger") {
        log("cmd", `loginctl show-user ${user} -p Linger`);
        log("out", "Linger=no");
        set("start", { status: "attention", label: "It would stop when you log out" });
        const answer = await ask({ kind: "linger", step: "start", user });
        if (answer.action === "back") return phase("back");
        set("start", { status: "active", label: "Starting" });
        log("cmd", `sudo loginctl enable-linger ${user}`);
        await io.wait(800);
        log("out", "Linger=yes");
      }
      log("ok", "volli-hostd: serving");
      set("start", {
        status: "done",
        label: os === "linux" ? "Keeps running when you log out" : "Starts with the Mac",
      });
    }

    /* ── pair ── */
    set("pair", { status: "active", label: "Pairing" });
    log("cmd", "volli-hostd pair --over-ssh");
    await io.wait(900);
    if (outcome === "new-identity") {
      log("err", `Host key for ${alias} does not match the one this Mac paired with`);
      set("pair", { status: "failed", label: `${alias} has a new identity` });
      const answer = await ask({ kind: "identity", step: "pair" });
      if (answer.action === "back") return phase("back");
      set("pair", { status: "active", label: "Pairing" });
      log("cmd", "volli-hostd pair --over-ssh --replace-pin");
      await io.wait(900);
    }
    log("ok", "Paired · host key SHA256:q3Zt9fK1x0mV… pinned");
    set("pair", { status: "done", label: "Paired with this Mac" });
    await io.wait(350);
    phase("done");
  };
}
