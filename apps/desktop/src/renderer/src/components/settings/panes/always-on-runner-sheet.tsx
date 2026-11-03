import * as React from "react";
import { CONTROL_W } from "@renderer/components/settings/kit";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { RunnerCopy, RunnerInstallSheet, type RunnerSheetProps } from "./add-runner-sheet";
import { runnerCloudInit } from "./runner-install-command";

const PROVIDERS = ["Hetzner", "DigitalOcean", "Other (cloud-init)"] as const;

export function AlwaysOnRunnerSheet(props: RunnerSheetProps) {
  const [provider, setProvider] = React.useState("Hetzner");
  const providerId = React.useId();
  return (
    <RunnerInstallSheet
      {...props}
      title="Get an always-on runner"
      description="Use a Linux server in your own provider account. You pay the provider directly."
    >
      {(grant, name) => (
        <>
          <div className="flex items-center justify-between gap-4">
            <label htmlFor={providerId} className="text-ui">
              Provider
            </label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id={providerId} className={CONTROL_W.lg}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
              site: props.site,
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
