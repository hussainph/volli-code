/**
 * The one rule for a credential's environment variable name: an uppercase
 * name that is data, never a control over executable lookup, shell startup,
 * a loader or Volli's own identity. Local Session secrets (`request_secret`,
 * the host's sealed store) and Volli Cloud's team secrets obey the same rule,
 * so a value set in the cloud can never become `PATH` or `LD_PRELOAD` on a
 * runner.
 *
 * Pure: no Node/DOM imports.
 */

const CONTROL_NAMES = new Set([
  "PATH",
  "HOME",
  "ENV",
  "BASH_ENV",
  "SHELL",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  "SHELLOPTS",
  "BASHOPTS",
  "ZDOTDIR",
  "FPATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "COMSPEC",
  "PATHEXT",
  "PROMPT_COMMAND",
  "PS0",
  "PS1",
  "PS2",
  "PS4",
  "HISTFILE",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_TEMPLATE_DIR",
  "GIT_PAGER",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "PAGER",
  "EDITOR",
  "VISUAL",
  "LESSOPEN",
  "LESSCLOSE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
]);
const CONTROL_PREFIXES = /^(?:LD_|DYLD_|VOLLI_|ELECTRON_|BASH_FUNC_|NPM_CONFIG_|GIT_CONFIG_)/;

/** Credentials are data, never controls over executable lookup or process startup. */
export function isSecretName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(name) &&
    !CONTROL_NAMES.has(name) &&
    !CONTROL_PREFIXES.test(name)
  );
}
