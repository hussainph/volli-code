import * as React from "react";
import { RunnerCopy, RunnerInstallSheet, type RunnerSheetProps } from "./add-runner-sheet";
import { runnerCloudInit } from "./runner-install-command";

export function AlwaysOnRunnerSheet(props: RunnerSheetProps) {
  const [provider, setProvider] = React.useState("Hetzner");
  return (
    <RunnerInstallSheet
      {...props}
      title="Get an always-on runner"
      description="Use a Linux server in your own provider account. You pay the provider directly."
    >
      {(grant, name) => (
        <>
          <label className="flex items-center justify-between gap-4 text-ui">
            Provider
            <select
              aria-label="Provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              className="rounded-control border border-border bg-background px-2 py-1"
            >
              <option>Hetzner</option>
              <option>DigitalOcean</option>
              <option>Other (cloud-init)</option>
            </select>
          </label>
          <p className="text-ui text-muted-foreground">
            Create an Ubuntu 24.04 server
            {provider === "Other (cloud-init)" ? "" : ` on ${provider}`} and paste this into its
            user-data / cloud-init field. Start it within 1 hour.
          </p>
          <RunnerCopy
            value={runnerCloudInit({
              appVersion: props.appVersion,
              token: grant.installToken,
              name,
              server: props.server,
            })}
            label="Copy cloud-init"
          />
          <p className="text-ui text-muted-foreground">
            User-data contains the one-time token. Delete it from your provider after the runner
            links.
          </p>
        </>
      )}
    </RunnerInstallSheet>
  );
}
