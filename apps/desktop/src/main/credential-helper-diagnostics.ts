/**
 * The read-only credential-helper diagnosis, and the sentence it is worth
 * saying out loud.
 *
 * `osxkeychain` is the STOCK macOS Git setup — Apple's own `/usr/bin/git`
 * ships a gitconfig that enables it — so this is not a hazard report and must
 * never be shown as one. Warning somebody about their default configuration on
 * a screen they did not ask for trains them to ignore warnings (VC-159/R8).
 * The detector is unchanged; its VENUE is the failure it predicts. Ask it when
 * a Git network verb has already failed in a way a GUI prompt would explain
 * (`worktree/net.ts`), never on a settings pane that renders whether or not
 * anything is wrong.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A GUI-capable credential helper Git itself reported for a project. Main-local
 * (it crosses no IPC boundary): what reaches the renderer is the explanation
 * attached to a failed push or fetch, not the diagnosis.
 */
export interface CredentialHelperIssue {
  kind: "osxkeychain-may-prompt-gui";
  helper: "osxkeychain";
  /**
   * Git's `local` and `worktree` scopes both mean this project's
   * configuration. `unknown` is Git's own word for a source it does not
   * classify — Apple's `/usr/bin/git` reports its Xcode-bundled gitconfig,
   * the file that enables `osxkeychain` on a stock Mac, exactly this way.
   */
  scope: "system" | "global" | "repo-local" | "command" | "unknown";
  /** The config file or command source Git itself reported for the helper. */
  location: string;
}

export interface CredentialHelperDiagnosticsDeps {
  /** Git's all-scope, origin-annotated credential-helper query. */
  readCredentialHelperConfig(cwd: string): Promise<string>;
}

interface CredentialHelperConfigEntry {
  scope: string;
  origin: string;
  helper: string;
}

function processDeps(): CredentialHelperDiagnosticsDeps {
  return {
    async readCredentialHelperConfig(cwd) {
      const { stdout } = await execFileAsync(
        "git",
        [
          "config",
          "--includes",
          "--null",
          "--show-scope",
          "--show-origin",
          "--get-all",
          "credential.helper",
        ],
        { cwd, encoding: "utf8" },
      );
      return stdout;
    },
  };
}

function parseCredentialHelperConfig(output: string): CredentialHelperConfigEntry[] {
  const fields = output.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  if (fields.length % 3 !== 0) return [];

  const entries: CredentialHelperConfigEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index];
    const origin = fields[index + 1];
    const helper = fields[index + 2];
    if (
      scope === undefined ||
      scope === "" ||
      origin === undefined ||
      origin === "" ||
      helper === undefined
    ) {
      return [];
    }
    entries.push({ scope, origin, helper });
  }
  return entries;
}

function effectiveCredentialHelpers(
  entries: readonly CredentialHelperConfigEntry[],
): CredentialHelperConfigEntry[] {
  const helpers: CredentialHelperConfigEntry[] = [];
  for (const entry of entries) {
    // Git keeps earlier values in `config --get-all`; an exactly empty helper
    // clears that accumulated chain before later helpers are appended.
    if (entry.helper === "") {
      helpers.length = 0;
    } else {
      helpers.push(entry);
    }
  }
  return helpers;
}

/**
 * Git's scope word, folded to the vocabulary the notice speaks. Never `null`:
 * Apple's `/usr/bin/git` reports its Xcode-bundled gitconfig — the file that
 * enables `osxkeychain` on a stock Mac — with scope `unknown` (measured,
 * Apple Git-155), and a hazard detector that dropped unclassified scopes
 * would call exactly that stock setup safe. An unrecognized scope is
 * reported as `unknown`, with Git's own origin naming the file.
 */
function issueScope(scope: string): CredentialHelperIssue["scope"] {
  if (scope === "system" || scope === "global" || scope === "command") return scope;
  if (scope === "local" || scope === "worktree") return "repo-local";
  return "unknown";
}

function location(origin: string): string {
  return origin.startsWith("file:") ? origin.slice("file:".length) : origin;
}

/**
 * Finds known GUI-capable helpers in the chain Git itself assembled for a project.
 *
 * The query is read-only. It asks Git for every included config scope in its own
 * precedence order, then applies Git's empty-value reset before considering a
 * helper hazardous. A failed query establishes neither safety nor a diagnosis.
 */
export async function credentialHelperIssues(
  cwd: string | null,
  deps: CredentialHelperDiagnosticsDeps = processDeps(),
): Promise<CredentialHelperIssue[]> {
  if (cwd === null) return [];

  let output: string;
  try {
    output = await deps.readCredentialHelperConfig(cwd);
  } catch {
    return [];
  }

  return effectiveCredentialHelpers(parseCredentialHelperConfig(output)).flatMap((entry) => {
    if (!/^osxkeychain(?:\s|$)/.test(entry.helper)) return [];
    // A helper value can carry arbitrary command arguments; the UI only needs
    // the known helper name, never the raw configuration value.
    return [
      {
        kind: "osxkeychain-may-prompt-gui" as const,
        helper: "osxkeychain" as const,
        scope: issueScope(entry.scope),
        location: location(entry.origin),
      },
    ];
  });
}

/** Which configuration turned the helper on, in the words a reader can act on. */
function scopeSentence(scope: CredentialHelperIssue["scope"]): string {
  switch (scope) {
    case "system":
      return "Your system Git configuration";
    case "global":
      return "Your global Git configuration";
    case "repo-local":
      return "This project's Git configuration";
    case "command":
      return "A Git command setting";
    // Git's own word for a source it does not classify — Apple Git reports its
    // Xcode-bundled gitconfig this way. The location names the file.
    case "unknown":
      return "Your Git configuration";
  }
}

/**
 * The explanation a failed Git network verb carries when this configuration is
 * the likeliest reason it failed. One paragraph: what happened, why a Session
 * could not answer it, and the one thing that fixes it for good. Volli never
 * rewrites the user's Git configuration, and this sentence never asks them to.
 */
export function credentialHelperExplanation(issue: CredentialHelperIssue): string {
  return (
    `Git asked for credentials it could not get. ${scopeSentence(issue.scope)} ` +
    `(${issue.location}) uses the ${issue.helper} helper, which asks in a macOS ` +
    `window a Session cannot answer. Sign in once from your own terminal — for ` +
    `GitHub, run gh auth login — then try again.`
  );
}
