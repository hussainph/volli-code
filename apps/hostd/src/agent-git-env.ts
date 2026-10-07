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
import { appendGitConfig, gitCredentialHelperEnv } from "@volli/host-core/session-runtime";

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

/**
 * The git part of every Session command's record, composed once: on a Mac the
 * helper-list reset first ({@link withAgentGit}), then Volli's push-credential
 * helper (VC-702) when there is one, appended after it, never over it.
 */
export function sessionGitEnv(
  env: Readonly<Record<string, string>>,
  platform: string,
  volliHelper: string | null,
): Record<string, string> {
  const reset = withAgentGit(env, platform);
  return volliHelper === null ? reset : gitCredentialHelperEnv(volliHelper, reset);
}
