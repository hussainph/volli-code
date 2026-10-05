/**
 * systemd socket activation (VC-623): the listening socket systemd bound for
 * this process, if it bound one.
 *
 * The packaged unit lets systemd, as root, create `/run/volli-hostd.sock` in
 * `/run`, which only root can write. hostd then cannot rename, unlink or
 * replace that pathname — and so neither can any Session, which runs as the
 * same account. That is what lets an operator send a token to it: nothing the
 * service account runs can have put an impostor at that name first.
 *
 * The protocol (`sd_listen_fds(3)`): `LISTEN_PID` names the process the fds
 * are for, `LISTEN_FDS` how many, starting at fd 3. hostd serves exactly one.
 */
import { HostdBootError } from "./boot-error";

/** The first passed descriptor, `SD_LISTEN_FDS_START`. */
const FIRST_FD = 3;

export function socketActivationFd(
  env: Readonly<Record<string, string | undefined>>,
  pid: number,
): number | undefined {
  const count = env["LISTEN_FDS"];
  // Absent, or meant for another process (a parent that did not unset it).
  if (count === undefined || env["LISTEN_PID"] !== String(pid)) return undefined;
  if (count !== "1") {
    throw new HostdBootError(
      "socket",
      `systemd passed ${count} sockets; hostd serves exactly one (one ListenStream= in the .socket unit).`,
    );
  }
  return FIRST_FD;
}
