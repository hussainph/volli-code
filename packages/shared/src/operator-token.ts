/**
 * The operator token's names (VC-623): the one credential that lets a person at
 * a headless host's shell write to its board with the `volli` CLI.
 *
 * `volli-hostd operator-token --for <login>`, run as root, issues it: the
 * plaintext goes to that login's own 0600 file and hostd keeps only a verifier.
 * Desktop issues none and verifies none, so on desktop the token means nothing.
 *
 * It is a bootstrap and break-glass credential, not a daily workflow: a person
 * works in the UI, and agents use Session tokens. The rule that keeps it from
 * becoming a way for a Session to act as a person lives on both sides of the
 * socket — the CLI never sends one beside a Session's environment, and the door
 * ignores one that arrives beside a Session token — and, underneath both, in who
 * can read the file: never the service account hostd and its Sessions run as.
 * See `docs/plans/host-identity.md` ("Operator token").
 *
 * Only names live here, because both ends must spell them the same way: the CLI
 * reads them and hostd writes them.
 */

/** The variable an operator may export instead of keeping the file. */
export const VOLLI_OPERATOR_TOKEN_ENV = "VOLLI_OPERATOR_TOKEN";

/**
 * Where the token lives, relative to the operator's home directory:
 * `~/.config/volli/operator-token`. Fixed rather than read from
 * `XDG_CONFIG_HOME`, because the issuer runs as root in root's environment and
 * cannot know what the operator's shell will export.
 */
export const OPERATOR_TOKEN_HOME_PATH = [".config", "volli", "operator-token"] as const;
