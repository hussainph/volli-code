/**
 * Who to SSH to (VC-700 flow step 1): what the person typed (`you@box`,
 * `you@box:2222`, `box`) or a `Host` they picked from `~/.ssh/config`.
 *
 * A target is handed to the system `ssh` as written, so the person's own
 * config (HostName, User, Port, ProxyJump, IdentityFile, known_hosts) decides
 * how it is reached. This package adds options to that, never replaces it.
 */

export interface SshTarget {
  /** What `ssh` is given: `user@host`, or a config alias. */
  readonly destination: string;
  /** `-p`, when the person typed one. */
  readonly port: number | null;
  /** The short name the person sees: the alias, or the host part. */
  readonly label: string;
}

/** A hostname, an alias or a user: what ssh itself would accept, no options smuggled in. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;
const HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])$/u;

/** The target, or why it is not one. Never one that starts with `-`, which ssh would take as an option. */
export function parseSshTarget(input: string): SshTarget | string {
  const text = input.trim();
  const match = /^(?:([^@\s]+)@)?([^@\s]+?)(?::(\d{1,5}))?$/u.exec(text);
  if (match === null) return "Enter a host as you@box, or a name from ~/.ssh/config.";
  const [, user, host, port] = match;
  if (user !== undefined && !NAME.test(user)) return `${user} is not a user name.`;
  if (!HOST.test(host!)) return `${host} is not a host name.`;
  const portNumber = port === undefined ? null : Number(port);
  if (portNumber !== null && (portNumber < 1 || portNumber > 65_535)) {
    return `${port} is not a port.`;
  }
  return {
    destination: user === undefined ? host! : `${user}@${host}`,
    port: portNumber,
    label: host!.replace(/^\[|\]$/gu, ""),
  };
}

/** `ssh`'s arguments naming the target: `-p` when given, then `--` and the destination. */
export function targetArgs(target: SshTarget): string[] {
  return [...(target.port === null ? [] : ["-p", String(target.port)]), "--", target.destination];
}

/**
 * The concrete `Host` names in an ssh config's text, in order, each once:
 * what the person can pick. Patterns (`*`, `?`, `!`) are not hosts.
 */
export function sshConfigHosts(config: string): string[] {
  const hosts: string[] = [];
  for (const raw of config.split("\n")) {
    // Trimmed first, then one anchored keyword: no backtracking over a person's file.
    const line = raw.trim();
    if (!/^host\s/iu.test(line)) continue;
    for (const name of line.slice(4).trim().split(/\s+/u)) {
      if (/[*?!]/u.test(name) || !NAME.test(name) || hosts.includes(name)) continue;
      hosts.push(name);
    }
  }
  return hosts;
}
