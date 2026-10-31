/**
 * The update units (n3 §9.3), which the installer (`src/install`) writes
 * beside `volli-runner.service`:
 *
 * - `volli-runner-update.path` watches the daemon's request file;
 * - `volli-runner-update.service`, a oneshot, runs the **installed**
 *   release's `volli-runner update apply`, which stages, activates, checks
 *   health and rolls back (`apply.ts`).
 *
 * In system mode the service runs as root, because the releases are root's;
 * it treats the request as untrusted. In user mode both are user units and the
 * service runs as the person. `apps/runner/packaging/volli-runner-update.*`
 * are the system rendering (a test keeps them equal), shipped in the release
 * tarball's `share/systemd/`.
 */
import type { UpdateLayout } from "./layout";

export const UPDATE_PATH_UNIT = "volli-runner-update.path";
export const UPDATE_SERVICE_UNIT = "volli-runner-update.service";

/** One ExecStart= word: quoted when it holds what systemd would split or expand. */
function word(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/u.test(value)
    ? value
    : `"${value
        .replace(/[\\"]/gu, (char) => `\\${char}`)
        .replace(/%/gu, "%%")
        .replace(/\$/gu, "$$$$")}"`;
}

export interface UpdateUnits {
  readonly path: string;
  readonly service: string;
}

export function updateUnits(layout: UpdateLayout): UpdateUnits {
  const system = layout.mode === "system";
  const execStart = [
    `${layout.currentLink}/bin/volli-runner`,
    "update",
    "apply",
    "--install-root",
    layout.installRoot,
    "--data-dir",
    layout.dataDir,
  ]
    .map(word)
    .join(" ");
  const path = `# Starts ${UPDATE_SERVICE_UNIT} when the runner asks for an update.
# Written by \`volli-runner install\`; see apps/runner/README.md ("Updates").

[Unit]
Description=Volli runner update requests

[Path]
PathChanged=${layout.requestFile.replace(/%/gu, "%%")}
Unit=${UPDATE_SERVICE_UNIT}

[Install]
WantedBy=${system ? "paths.target" : "default.target"}
`;
  const hardening = system
    ? `# Root, because the releases are root's: the runner (as volli, like its
# agents) can ask for an update and never install one. The request is
# untrusted; only a release whose signed provenance verifies is installed.
UMask=0022
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
`
    : `UMask=0077
`;
  const service = `# Applies a Volli runner update: stage, activate, health check, rollback.
# Written by \`volli-runner install\`; see apps/runner/README.md ("Updates").

[Unit]
Description=Apply a Volli runner update
Documentation=https://github.com/hussainph/volli-code/blob/main/apps/runner/README.md
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=${execStart}
# A download, two probes, and two health checks of 2 minutes at most.
TimeoutStartSec=45min
${hardening}`;
  return { path, service };
}
