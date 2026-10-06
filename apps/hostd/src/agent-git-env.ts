/**
 * Git in a Session's commands on a Mac host (VC-700 PR 1c): never the
 * keychain.
 *
 * Apple's git ships `credential.helper = osxkeychain` in its system
 * configuration, and a person's own often names it too. On a host, a
 * Session's `git push` over HTTPS would then run `git-credential-osxkeychain`
 * against the account's login keychain: a prompt nobody is there to answer,
 * a hang, or worse (the owner's keychain incident; `worktree/net.ts`). So on
 * a Mac every Session command gets command-scope git configuration that
 * empties the helper list (`credential.helper` set to the empty string resets
 * every helper configured before it, system and global alike) and turns
 * git's own terminal prompt off. A helper Volli controls goes after the reset
 * (VC-702's push-credential helper composes here, never beside it, since both
 * own `GIT_CONFIG_COUNT`).
 *
 * Elsewhere (Linux), nothing changes unless a helper is given.
 */

/** Command-scope git configuration (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, git 2.31+). */
function commandScope(entries: readonly (readonly [string, string])[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * The git environment a Session command on this host gets: on `darwin`, the
 * helper list reset and prompts off, then `helpers` (each a
 * `credential.helper` value) in order; elsewhere `helpers` alone, or nothing.
 */
export function agentGitEnvironment(
  platform: string,
  helpers: readonly string[] = [],
): Record<string, string> {
  const added = helpers.map((helper) => ["credential.helper", helper] as const);
  if (platform !== "darwin") return added.length === 0 ? {} : commandScope(added);
  return {
    ...commandScope([["credential.helper", ""], ...added]),
    GIT_TERMINAL_PROMPT: "0",
  };
}
