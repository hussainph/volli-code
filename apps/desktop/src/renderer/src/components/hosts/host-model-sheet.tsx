import * as React from "react";

import { ModelAccessSettings } from "@renderer/components/pages/model-access-settings";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@renderer/components/ui/dialog";
import { hostModelAccessClient } from "@renderer/lib/host-model-access-client";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { isLinkReady } from "@renderer/lib/relay-host-link";
import { relayHostScope } from "@renderer/lib/relay-host-scope";
import { useHostModelSheet, type HostModelTarget } from "@renderer/stores/host-model-sheet";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { readdHostToUpdate } from "@renderer/stores/remote-hosts";

import { useHostSignInSheet } from "./sign-ins/remote-host-sign-in-source";

export function HostModelSheet({
  makeClient = hostModelAccessClient,
}: {
  makeClient?: typeof hostModelAccessClient;
}) {
  const target = useHostModelSheet((state) => state.target);
  const close = useHostModelSheet((state) => state.close);
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && close()}>
      {target !== null ? (
        <DialogContent
          aria-describedby={undefined}
          className="max-h-[80vh] overflow-y-auto sm:max-w-3xl"
        >
          <DialogHeader>
            <DialogTitle>Models on {target.hostName}</DialogTitle>
          </DialogHeader>
          <HostModelBody key={target.hostId} target={target} makeClient={makeClient} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function HostModelBody({
  target,
  makeClient,
}: {
  target: HostModelTarget;
  makeClient: typeof hostModelAccessClient;
}) {
  const host = useHostConnectionStore((state) =>
    state.hosts.find((item) => item.id === target.hostId),
  );
  const link = React.useMemo(() => relayHostScope(target.hostId), [target.hostId]);
  const subscribe = React.useCallback(
    (listener: () => void) => link.subscribeState(listener),
    [link],
  );
  const linkState = React.useSyncExternalStore(subscribe, link.getState, link.getState);
  const scope = host?.hostScope;
  const older =
    host !== undefined &&
    (scope === undefined ||
      scope.status === "older" ||
      (scope.status === "ready" && !scope.granted.includes("host.model-defaults")));
  if (older)
    return (
      <div role="status" className="flex items-center justify-between gap-4 text-ui">
        <span>Update {target.hostName} to choose its model here</span>
        <Button
          size="sm"
          onClick={() => {
            useHostModelSheet.getState().close();
            readdHostToUpdate(target.hostId);
          }}
        >
          Re-add to update
        </Button>
      </div>
    );
  if (scope?.status !== "ready" || !isLinkReady(linkState))
    return (
      <div role="status" className="flex items-center justify-between gap-4 text-ui">
        <span>Couldn’t reach {target.hostName}</span>
        <Button size="sm" onClick={() => useHostConnectionStore.getState().retry(target.hostId)}>
          Retry now
        </Button>
      </div>
    );
  return <HostModelPreferences target={target} link={link} makeClient={makeClient} />;
}

function HostModelPreferences({
  target,
  link,
  makeClient,
}: {
  target: HostModelTarget;
  link: Parameters<typeof hostModelAccessClient>[1];
  makeClient: typeof hostModelAccessClient;
}) {
  // This child exists only while HOST is ready. Loss disposes the provider and pane;
  // reconnect creates fresh reads instead of reusing an old catalog promise.
  const client = React.useMemo<ModelAccessClient>(
    () => makeClient(target.hostId, link),
    [makeClient, target.hostId, link],
  );
  return (
    <ModelAccessProvider client={client}>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            useHostModelSheet.getState().close();
            useHostSignInSheet.getState().open({ ...target, providerId: null });
          }}
        >
          Sign-ins on {target.hostName}…
        </Button>
      </div>
      <ModelAccessSettings hostName={target.hostName} />
    </ModelAccessProvider>
  );
}
