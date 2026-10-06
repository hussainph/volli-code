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
 * git's own terminal prompt off, in the record `concurrencyEnvFor` builds. A
 * helper Volli controls (VC-702's push-credential helper) appends after the
 * reset: both writers append, so neither overwrites the other's
 * `GIT_CONFIG_COUNT`.
 *
 * Elsewhere (Linux), nothing changes unless a helper is given.
 */

/**
 * `env` with command-scope git configuration (`GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`, git 2.31+) appended after
 * whatever it already holds, so two writers of the same record compose
 * instead of overwriting each other's count.
 */
export function appendGitConfig(
  env: Readonly<Record<string, string>>,
  entries: readonly (readonly [key: string, value: string])[],
): Record<string, string> {
  const held = Number(env["GIT_CONFIG_COUNT"] ?? "0");
  const start = Number.isSafeInteger(held) && held > 0 ? held : 0;
  const out: Record<string, string> = { ...env, GIT_CONFIG_COUNT: String(start + entries.length) };
  entries.forEach(([key, value], offset) => {
    out[`GIT_CONFIG_KEY_${start + offset}`] = key;
    out[`GIT_CONFIG_VALUE_${start + offset}`] = value;
  });
  return out;
}

/**
 * The record a Session command on this host gets, with git kept off the
 * keychain on a Mac: the helper list reset (`credential.helper` = "") and
 * git's terminal prompt off. A Volli helper (VC-702) appends after it with
 * {@link appendGitConfig}. Elsewhere the record is unchanged.
 */
export function withAgentGit(
  env: Readonly<Record<string, string>>,
  platform: string,
): Record<string, string> {
  if (platform !== "darwin") return { ...env };
  return { ...appendGitConfig(env, [["credential.helper", ""]]), GIT_TERMINAL_PROMPT: "0" };
}
