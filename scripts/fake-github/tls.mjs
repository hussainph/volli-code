/**
 * A throwaway certificate authority and one server certificate for the fake
 * GitHub's HTTPS side (VC-1043), made with the system `openssl`. The CA is
 * this run's own: the lane installs it only in the disposable box's trust
 * store and hands it to nothing else. Keys never leave `dir`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;

function openssl(args, cwd) {
  execFileSync("openssl", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

/**
 * Write `ca.pem`, `server.key` and `server.pem` (valid for `hostname`, 2 days)
 * into `dir`, and answer them as PEM text.
 */
export function createTestCertificates(dir, hostname) {
  if (!HOSTNAME.test(hostname)) throw new Error(`not a hostname: ${hostname}`);
  openssl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=Volli e2e fake GitHub CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    ],
    dir,
  );
  openssl(
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${hostname}`,
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
    ],
    dir,
  );
  writeFileSync(
    join(dir, "server.ext"),
    `subjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`,
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      "server.ext",
      "-out",
      "server.pem",
    ],
    dir,
  );
  return {
    caPath: join(dir, "ca.pem"),
    ca: readFileSync(join(dir, "ca.pem"), "utf8"),
    key: readFileSync(join(dir, "server.key"), "utf8"),
    cert: readFileSync(join(dir, "server.pem"), "utf8"),
  };
}
