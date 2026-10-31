import { isAbsolute, join } from "node:path";

import type { CommandContext, CommandInput } from "../commands";

export const UNIT = "volli-runner.service";
export type InstallMode = "user" | "system";
export interface InstallLayout {
  mode: InstallMode;
  root: string;
  dataDir: string;
  configDir: string;
  binDir: string;
  unitDir: string;
}

/** Managed paths are fixed, not caller-provided deletion targets. */
export function installLayout(
  input: CommandInput,
  context: Pick<CommandContext, "uid" | "home" | "env">,
  prefix = "",
): InstallLayout {
  const { values } = input;
  if (values.user && values.system) throw new Error("Choose --user or --system, not both.");
  const mode = values.system || (!values.user && context.uid === 0) ? "system" : "user";
  if (mode === "user" && context.uid === 0) {
    throw new Error("Do not run agents as root: drop sudo for --user, or use --system.");
  }
  if (mode === "system" && context.uid !== 0) throw new Error("Run --system with sudo.");
  const xdg = (name: string, fallback: string): string => {
    const value = context.env[name];
    return value && isAbsolute(value) ? value : join(context.home, fallback);
  };
  if (mode === "system") {
    return {
      mode,
      root: `${prefix}/opt/volli-runner`,
      dataDir: `${prefix}/var/lib/volli-runner`,
      configDir: `${prefix}/etc/volli-runner`,
      binDir: `${prefix}/usr/local/bin`,
      unitDir: `${prefix}/etc/systemd/system`,
    };
  }
  return {
    mode,
    root: join(xdg("XDG_DATA_HOME", ".local/share"), "volli-runner"),
    dataDir: join(xdg("XDG_STATE_HOME", ".local/state"), "volli-runner"),
    configDir: join(xdg("XDG_CONFIG_HOME", ".config"), "volli-runner"),
    binDir: join(context.home, ".local/bin"),
    unitDir: join(xdg("XDG_CONFIG_HOME", ".config"), "systemd/user"),
  };
}

/** systemd interprets specifiers even inside quotes. Never interpolate raw input. */
export function unitQuote(value: string): string {
  return environmentQuote(value).replaceAll("%", "%%");
}

function environmentQuote(value: string): string {
  if ([...value].some((char) => char < " " || char === "\u007f"))
    throw new Error("A unit value contains a control character.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Environment= is public over systemd's API. Proxy passwords belong in a private file. */
export function proxyEnvironment(env: CommandContext["env"]): string {
  return (
    ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]
      .flatMap((key) => (env[key] === undefined ? [] : [`${key}=${environmentQuote(env[key]!)}`]))
      .join("\n") + "\n"
  );
}

export function serviceUnit(layout: InstallLayout, env: CommandContext["env"]): string {
  const system = layout.mode === "system";
  return [
    "[Unit]",
    "Description=Volli runner",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    ...(system
      ? ["User=volli", "Group=volli", "StateDirectory=volli-runner", "StateDirectoryMode=0700"]
      : []),
    "UMask=0077",
    "Environment=VOLLI_RUNNER_SERVICE=1",
    `WorkingDirectory=${unitQuote(layout.dataDir)}`,
    `Environment=${unitQuote(`HOME=${system ? layout.dataDir : (env["HOME"] ?? layout.dataDir)}`)}`,
    `Environment=${unitQuote(`VOLLI_RUNNER_INSTALL_MODE=${layout.mode}`)}`,
    `Environment=${unitQuote(`VOLLI_SECRET_KEY_FILE=${join(layout.configDir, "session-secrets.key")}`)}`,
    "Environment=NODE_USE_ENV_PROXY=1",
    `EnvironmentFile=${unitQuote(`-${join(layout.root, "proxy.env")}`)}`,
    `ExecStart=:${unitQuote(join(layout.root, "current/bin/volli-runner"))} run --data-dir ${unitQuote(layout.dataDir)} --config-dir ${unitQuote(layout.configDir)}`,
    "KillSignal=SIGTERM",
    "TimeoutStopSec=45",
    "Restart=always",
    "RestartSec=5",
    "RestartPreventExitStatus=78",
    "NoNewPrivileges=yes",
    // A user manager cannot apply the system mount/namespace sandbox on every distro.
    ...(system
      ? [
          "PrivateTmp=yes",
          "PrivateDevices=yes",
          "ProtectSystem=full",
          `ReadWritePaths=${unitQuote(layout.configDir)}`,
          "ProtectHome=yes",
          "ProtectKernelTunables=yes",
          "ProtectKernelModules=yes",
          "ProtectKernelLogs=yes",
          "ProtectControlGroups=yes",
          "ProtectClock=yes",
          "ProtectHostname=yes",
          "RestrictSUIDSGID=yes",
          "RestrictRealtime=yes",
          "LockPersonality=yes",
          "CapabilityBoundingSet=",
          "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
          "RestrictNamespaces=user pid net",
          "SystemCallArchitectures=native",
        ]
      : []),
    "",
    "[Install]",
    `WantedBy=${system ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");
}
