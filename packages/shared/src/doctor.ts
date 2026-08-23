/**
 * `volli doctor` — what the harness integration is actually doing on this
 * machine, as opposed to what it was configured to do.
 *
 * This exists because of a specific failure. Volli's `bin/` was prepended to
 * every session's `PATH` and every test agreed it was there; nothing asked
 * *where*, and on macOS a login shell had already pushed it to position 20 of
 * 30, so no wrapper ever ran and no event ever fired. Every component was
 * correct and the feature was inert.
 *
 * So the checks here are deliberately about OUTCOMES, not configuration.
 * "The bin dir is on PATH" is the kind of claim that was true throughout the
 * outage; "typing `claude` here runs the wrapper" is not. Where a check can be
 * answered by observation rather than by reading our own settings back, it is —
 * the caller reports what it actually sees from inside the environment under
 * test, and the derivation below has no way to substitute an assumption for it.
 *
 * The tool checks follow the same rule: the question is not "is the tool
 * installed" — it cannot be answered from here — but "can a session run it",
 * which is the outcome every agent's first commands depend on (VC-94). Which
 * tools that outcome MATTERS for is the caller's project's answer, not this
 * module's (VC-157): every measured tool is reported, and only the ones the
 * caller's workspace implies can fail.
 */
import { SESSION_ENV_TOOLS } from "./session-env";
import type { SessionEnvTool } from "./session-env";
import type { WrapperRefusal } from "./harness/wrapper";

/** How much a finding matters. `warn` is a degraded but working install. */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  /** Stable machine name, for `--json` consumers and for talking about a finding. */
  id: string;
  title: string;
  status: DoctorStatus;
  /** What was actually observed — always concrete, never a restatement of the title. */
  detail: string;
  /** What would put it right, when there is a next action a human can take. */
  remedy?: string;
}

/**
 * One reported field. `null` is a MEASUREMENT — the caller looked and found
 * nothing there. `undefined` says no usable measurement arrived at all, which
 * is a different fact and has to read as one.
 *
 * The two collapse into each other very easily, and the collapse is always in
 * the same direction: an absent or malformed field becomes a confident "it is
 * not there". That is the exact failure mode this whole command was written
 * against — a plausible wrong answer, stated in the voice of an observation.
 */
export type Observed<T> = T | null | undefined;

/**
 * What the calling process can see from inside the environment being audited —
 * which is the only place several of these questions have a truthful answer. A
 * `volli doctor` run in a Volli PTY reports that PTY's reality; one run from a
 * plain terminal correctly reports that it is not in a session.
 */
export interface DoctorObservation {
  /** The caller's own `PATH`, split — the real one, not one main reconstructed. */
  pathEntries: readonly string[];
  /** `VOLLI_SESSION`, or null outside a session. */
  sessionId: string | null;
  /** `ZDOTDIR` as the caller sees it. */
  zdotDir: Observed<string>;
  /** Where each harness command resolves for the caller, by command name. */
  resolved: Readonly<Record<string, Observed<string>>>;
  /**
   * The tools the caller's own workspace implies
   * (`requiredSessionEnvTools`) — a repository implies `git`, a JavaScript
   * workspace implies `node` and the manager its lockfile names, and nothing
   * implies `gh`. Only these can be reported as failures; every other
   * measurement is still reported, as a measurement.
   *
   * Empty is a real answer — a folder that is no repository and no package
   * workspace requires nothing — and it is also what a caller that named no
   * requirements gets. Both mean the same thing here: with nothing known to
   * be needed, an absence has no consequence to name, and alarming anyway is
   * the bias VC-157 removed.
   */
  requiredTools: readonly SessionEnvTool[];
  /** Where `volli` itself resolves for the caller. */
  volliPath: Observed<string>;
}

/** What only main can answer: what it wrote, and what it knows. */
export interface DoctorFacts {
  binDir: string;
  /** Wrapper absolute paths that exist on disk right now, by command name. */
  wrappers: Readonly<Record<string, string>>;
  /** Wrappers Volli declined to write, each carrying the rule that declined it. */
  refused: readonly { command: string; resolvedPath: string; reason: WrapperRefusal }[];
  /** The Volli-owned ZDOTDIR, or null when the session's shell has no hook. */
  shellInitDir: string | null;
  /** Whether the generated zsh chain is present on disk. */
  shellInitPresent: boolean;
  /** This app's own `volli` shim. */
  shimPath: string;
  /** Session ids main considers live. */
  liveSessionIds: readonly string[];
  /** Per harness: what it declares it can report, and what has actually arrived. */
  reporting: readonly { harnessId: string; declared: number; verified: number }[];
  /** Managed skill files the installer left alone because the user edited them. */
  skillConflicts: readonly string[];
}

function ok(id: string, title: string, detail: string): DoctorCheck {
  return { id, title, status: "ok", detail };
}

function bad(
  id: string,
  title: string,
  status: Exclude<DoctorStatus, "ok">,
  detail: string,
  remedy?: string,
): DoctorCheck {
  return remedy === undefined
    ? { id, title, status, detail }
    : { id, title, status, detail, remedy };
}

/**
 * The check that would have caught the outage. Membership is not the property —
 * the bin dir was a member throughout — so this reports the POSITION, and
 * anything other than first is a finding.
 */
function pathPositionCheck(observation: DoctorObservation, facts: DoctorFacts): DoctorCheck {
  const index = observation.pathEntries.indexOf(facts.binDir);
  const total = observation.pathEntries.length;
  if (index === 0) {
    return ok("path-position", "Volli's bin is first on PATH", `position 1 of ${total}`);
  }
  if (index === -1) {
    return bad(
      "path-position",
      "Volli's bin is first on PATH",
      "fail",
      `${facts.binDir} is not on PATH at all (${total} entries)`,
      "Open a new Volli terminal; if this persists, the session was not started by Volli.",
    );
  }
  const ahead = observation.pathEntries.slice(0, index);
  return bad(
    "path-position",
    "Volli's bin is first on PATH",
    "fail",
    `position ${index + 1} of ${total} — ${ahead.length} ${
      ahead.length === 1 ? "entry shadows" : "entries shadow"
    } it, starting with ${ahead[0]}`,
    "A shell startup file is prepending after Volli. Run `volli doctor --fix` and open a new terminal.",
  );
}

/**
 * Does typing the harness's own name actually reach the wrapper? This is the
 * outcome the whole design rests on, and the one nothing previously asserted.
 */
function resolutionChecks(observation: DoctorObservation, facts: DoctorFacts): DoctorCheck[] {
  return Object.entries(facts.wrappers).map(([command, wrapperPath]) => {
    const actual = observation.resolved[command];
    const id = `resolves-${command}`;
    const title = `\`${command}\` runs Volli's wrapper`;
    if (actual === wrapperPath) return ok(id, title, wrapperPath);
    if (actual === undefined) {
      // A wrapper the caller never tried to resolve. Silence about it is the
      // only honest report: a harness whose wrapper works would otherwise be
      // told it resolves nowhere, and a resolution check that invents a
      // negative is worth less than no resolution check at all.
      return bad(
        id,
        title,
        "warn",
        `no resolution was reported for \`${command}\``,
        "Run `volli doctor` from a Volli terminal, where the full wrapper set is visible.",
      );
    }
    if (actual === null) {
      return bad(id, title, "warn", `\`${command}\` resolves to nothing on this PATH`);
    }
    return bad(
      id,
      title,
      "fail",
      `resolves to ${actual}, not ${wrapperPath} — this harness reports no events`,
      "Run `volli doctor --fix`, then open a new terminal.",
    );
  });
}

/**
 * The remedy per tool, reached only where a project required that tool, and
 * naming the real cause instead of a generic install hint. The measured
 * failure this command exists to catch is not "the tool is not installed" but
 * "the session PATH is not the login PATH" — so every remedy names both
 * causes and the discriminator that tells them apart: `volli identify`, which
 * prints the adopted PATH and its provenance.
 */
const TOOL_REMEDIES: Record<SessionEnvTool, string> = {
  git: "macOS ships git with the Xcode Command Line Tools — run `xcode-select --install`. If git is installed but missing here, the session PATH is not your login PATH: run `volli doctor --fix` to re-run adoption for new Sessions, then `volli identify` shows what it adopted.",
  gh: "Install the GitHub CLI (`brew install gh`). If gh is installed but missing here, the session PATH is not your login PATH: run `volli doctor --fix` to re-run adoption for new Sessions, then `volli identify` shows what it adopted.",
  node: "Install Node (`brew install node`). If node is installed but missing here, the session PATH is not your login PATH: run `volli doctor --fix` to re-run adoption for new Sessions, then `volli identify` shows what it adopted.",
  npm: "npm ships with Node (`brew install node`). If npm is installed but missing here, the session PATH is not your login PATH: run `volli doctor --fix` to re-run adoption for new Sessions, then `volli identify` shows what it adopted.",
  pnpm: "Enable it with `corepack enable pnpm` (or `brew install pnpm`). If pnpm is installed but missing here, the session PATH is not your login PATH: run `volli doctor --fix` to re-run adoption for new Sessions, then `volli identify` shows what it adopted.",
  yarn: "Enable it with `corepack enable yarn` (or `brew install yarn`). If yarn is installed but missing here, the session PATH is not your login PATH: run `volli doctor --fix` to re-run adoption for new Sessions, then `volli identify` shows what it adopted.",
  bun: "Install Bun (`brew install oven-sh/bun/bun`). If bun is installed but missing here, the session PATH is not your login PATH: run `volli doctor --fix` to re-run adoption for new Sessions, then `volli identify` shows what it adopted.",
};

/**
 * What a tool nothing asked for has to say for itself, beyond "nobody asked".
 * `gh` is the one worth a sentence: its absence used to be a launch-wide
 * fault, and a reader who remembers that deserves to know where the answer
 * moved rather than to conclude the check was simply dropped.
 */
const UNREQUIRED_TOOL_NOTES: Partial<Record<SessionEnvTool, string>> = {
  gh: " Volli reports gh's absence when a PR action actually needs it.",
};

/**
 * Whether a session can run the tools THIS project needs. Missing `git` in a
 * repository is VC-94's failure — a session that looked operational and could
 * not do the one thing it was asked to do — while missing `pnpm` in a yarn
 * workspace is a fact about a tool nobody will type (VC-157). So requirement
 * decides the status and the measurement is reported either way.
 *
 * The same {@link Observed} discipline as every other check applies to the
 * required ones: `null` is a measured absence and a failure, `undefined` is a
 * caller that never looked, and a warn must say which of the two it is. An
 * unrequired tool has no failure to grade, so it reports what was seen and
 * stops there.
 */
function toolChecks(observation: DoctorObservation): DoctorCheck[] {
  return SESSION_ENV_TOOLS.map((tool) => {
    const id = `tool-${tool}`;
    const title = `\`${tool}\` is available to sessions`;
    const actual = observation.resolved[tool];
    if (typeof actual === "string") return ok(id, title, actual);
    if (!observation.requiredTools.includes(tool)) {
      const seen =
        actual === null
          ? `\`${tool}\` resolves to nothing on this PATH`
          : `no resolution was reported for \`${tool}\``;
      return ok(
        id,
        `\`${tool}\` is not required by this project`,
        `${seen}, and nothing here asks for it.${UNREQUIRED_TOOL_NOTES[tool] ?? ""}`,
      );
    }
    if (actual === null) {
      return bad(
        id,
        title,
        "fail",
        `\`${tool}\` resolves to nothing on this PATH`,
        TOOL_REMEDIES[tool],
      );
    }
    return bad(
      id,
      title,
      "warn",
      `no resolution was reported for \`${tool}\``,
      "Run `volli doctor` from a Volli terminal, where the full tool set is visible.",
    );
  });
}

/**
 * What a refusal has to say for itself. Every reason ends in the same outcome —
 * an unwrapped harness — so the outcome is the one thing the message must NOT
 * lead with: three rules reported under one sentence sends a user to rename a
 * command that was never the problem.
 */
function refusalReport(entry: DoctorFacts["refused"][number]): { detail: string; remedy: string } {
  switch (entry.reason) {
    case "shadows-system-command":
      return {
        detail: `a harness claims the name \`${entry.command}\`, which is ${entry.resolvedPath} on this system`,
        remedy:
          "Volli refuses to shadow a system tool. Rename the harness's command in its manifest.",
      };
    case "name-already-owned":
      return {
        detail: `another harness already owns the name \`${entry.command}\`, so ${entry.resolvedPath} was left as it was`,
        remedy:
          "Volli's bin holds one file per name. Rename the harness's command in its manifest.",
      };
    case "argv-not-transportable":
      return {
        detail: `the launch argv for \`${entry.command}\` holds a newline or an empty word, which ${entry.resolvedPath} could not have carried intact`,
        remedy: "Remove the newline or empty argument from the harness's declared flags.",
      };
  }
}

/** A refused wrapper is a correct outcome, but the user should know the harness is unwrapped. */
function refusedChecks(facts: DoctorFacts): DoctorCheck[] {
  return facts.refused.map((entry) => {
    const report = refusalReport(entry);
    return bad(
      `refused-${entry.command}`,
      `\`${entry.command}\` is not wrapped`,
      "warn",
      report.detail,
      report.remedy,
    );
  });
}

function shellInitCheck(observation: DoctorObservation, facts: DoctorFacts): DoctorCheck {
  const id = "shell-init";
  const title = "Shell integration is active";
  if (facts.shellInitDir === null) {
    return bad(
      id,
      title,
      "warn",
      "this shell has no post-startup hook Volli can use, so only Volli-started agents are wrapped",
    );
  }
  if (!facts.shellInitPresent) {
    return bad(id, title, "fail", `${facts.shellInitDir} is missing`, "Run `volli doctor --fix`.");
  }
  // Unmeasured before mismatched, because unmeasured is also unequal — and
  // calling it a mismatch would name a value nobody read.
  if (observation.zdotDir === undefined) {
    return bad(
      id,
      title,
      "warn",
      `ZDOTDIR was not reported, so it cannot be compared to ${facts.shellInitDir}`,
    );
  }
  if (observation.zdotDir !== facts.shellInitDir) {
    return bad(
      id,
      title,
      "fail",
      `ZDOTDIR is ${observation.zdotDir ?? "unset"}, not ${facts.shellInitDir}`,
      "This terminal started before the integration was generated. Open a new one.",
    );
  }
  return ok(id, title, facts.shellInitDir);
}

function volliCheck(observation: DoctorObservation, facts: DoctorFacts): DoctorCheck {
  const id = "volli-cli";
  const title = "`volli` is this app's CLI";
  if (observation.volliPath === undefined) {
    return bad(id, title, "warn", "no `volli` path was reported, so nothing is known about it");
  }
  if (observation.volliPath === null) {
    return bad(
      id,
      title,
      "fail",
      "`volli` resolves to nothing — agents cannot reach the planner",
      "Launch the Volli app (it installs the CLI in the background), then open a new terminal.",
    );
  }
  if (observation.volliPath === facts.shimPath) return ok(id, title, facts.shimPath);
  return bad(
    id,
    title,
    "warn",
    `resolves to ${observation.volliPath}, which is not this app's shim (${facts.shimPath})`,
    "Another Volli install owns the link. Launch the app you want owning it, or remove ~/.local/bin/volli and relaunch this one.",
  );
}

function sessionCheck(observation: DoctorObservation, facts: DoctorFacts): DoctorCheck {
  const id = "session";
  const title = "Session context";
  if (observation.sessionId === null) {
    return ok(
      id,
      title,
      "not in a Volli session — PATH and wrapper checks reflect this shell only",
    );
  }
  if (facts.liveSessionIds.includes(observation.sessionId)) {
    return ok(id, title, observation.sessionId);
  }
  // The tmux/daemon leak: an environment that outlived the session that made it.
  return bad(
    id,
    title,
    "warn",
    `VOLLI_SESSION names ${observation.sessionId}, which has ended`,
    "This environment outlived its session (a tmux server or background process). Events from here are refused.",
  );
}

/** A harness that declares events but has never delivered one is the shape of a silent break. */
function reportingChecks(facts: DoctorFacts): DoctorCheck[] {
  return facts.reporting.map((entry) => {
    const id = `reporting-${entry.harnessId}`;
    const title = `${entry.harnessId} reports events`;
    if (entry.declared === 0) return ok(id, title, "declares no events — nothing to verify");
    if (entry.verified === 0) {
      return bad(
        id,
        title,
        "warn",
        `declares ${entry.declared} events, none seen yet`,
        "Expected before its first run. If it persists after a turn, the hooks are not firing.",
      );
    }
    return ok(id, title, `${entry.verified} of ${entry.declared} verified by real delivery`);
  });
}

function skillCheck(facts: DoctorFacts): DoctorCheck[] {
  if (facts.skillConflicts.length === 0) return [];
  return [
    bad(
      "skills",
      "Managed skill files",
      "warn",
      `${facts.skillConflicts.length} left untouched because you edited them: ${facts.skillConflicts.join(", ")}`,
      "Delete a file to let Volli rewrite it, or keep your version.",
    ),
  ];
}

/**
 * Every check, worst first, so the thing that needs attention is the thing read
 * first. Ordering within a status is stable and follows the order the checks are
 * defined, which runs roughly from "nothing works" to "a detail is off".
 */
export function runDoctorChecks(observation: DoctorObservation, facts: DoctorFacts): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    pathPositionCheck(observation, facts),
    ...toolChecks(observation),
    shellInitCheck(observation, facts),
    volliCheck(observation, facts),
    sessionCheck(observation, facts),
    ...resolutionChecks(observation, facts),
    ...refusedChecks(facts),
    ...reportingChecks(facts),
    ...skillCheck(facts),
  ];
  const rank: Record<DoctorStatus, number> = { fail: 0, warn: 1, ok: 2 };
  return [...checks].toSorted((a, b) => rank[a.status] - rank[b.status]);
}

/** The single line a run ends on. */
export function doctorSummary(checks: readonly DoctorCheck[]): string {
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  if (failed === 0 && warned === 0) return `All ${checks.length} checks passed.`;
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (warned > 0) parts.push(`${warned} warning${warned === 1 ? "" : "s"}`);
  return `${parts.join(", ")} of ${checks.length} checks.`;
}
