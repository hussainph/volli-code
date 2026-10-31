import * as React from "react";
import type { RunnerPickerAnswer } from "@volli/shared/cloud";
import { DesktopIcon } from "@phosphor-icons/react/dist/csr/Desktop";
import { CaretUpDownIcon } from "@phosphor-icons/react/dist/csr/CaretUpDown";
import { makeFunctionReference } from "convex/server";

import { cloudAccountScope, launchStore } from "@renderer/stores/launch";
import { followCloudSession } from "@renderer/lib/cloud-client";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { appStateStorage, type SyncStateStorage } from "@renderer/lib/app-state-storage";
import { cloudFailure } from "@renderer/stores/cloud-board/source";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { COMPOSER_CONFIG_CHIP, COMPOSER_CONTROL_SIZE } from "./composer-chrome";
import {
  composerRunnerChoice,
  composerRunnerStatus,
  runnerSelectable,
  type ComposerRunner,
  type ComposerRunners,
} from "./runner-picker-model";

const storage: SyncStateStorage = appStateStorage;
const preferenceKey = "composer-runner-choices";
const listeners = new Set<() => void>();
function preferenceScope(projectId: string): string {
  return JSON.stringify([cloudAccountScope(), projectId]);
}
function preferences(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(storage.getItem(preferenceKey) ?? "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry) => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}
function remember(projectId: string, runnerId: string): void {
  const scope = preferenceScope(projectId);
  const entries = Object.entries(preferences())
    .filter(([key]) => key !== scope)
    .slice(-99);
  storage.setItem(
    preferenceKey,
    JSON.stringify(Object.fromEntries([...entries, [scope, runnerId]])),
  );
  for (const listener of listeners) listener();
}
const subscribePreference = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// The composer reads only the current person's runners, scoped to this project.
const forComposer = makeFunctionReference<"query", { projectId: string }, RunnerPickerAnswer>(
  "runnerPicker:forComposer",
);

export interface RunnerPickerState {
  runners: readonly ComposerRunner[];
  selected: ComposerRunner | null;
  thisMacId: string | null;
  loading: boolean;
  error: string | null;
  choose(id: string): void;
}

/** No cloud subscriptions or preference reads in a local launch. */
export function useRunnerPicker(
  projectId: string | null,
  enabled = true,
  pinnedId?: string,
): RunnerPickerState {
  const cloud = launchStore() === "cloud" && enabled && projectId !== null;
  const [view, setView] = React.useState<{ projectId: string; value: ComposerRunners } | null>(
    null,
  );
  const [thisMacId, setThisMacId] = React.useState<string | null>();
  const [macError, setMacError] = React.useState<string | null>(null);
  const [queryError, setQueryError] = React.useState<string | null>(null);
  const remembered = React.useSyncExternalStore(
    subscribePreference,
    () =>
      cloud && projectId !== null ? (preferences()[preferenceScope(projectId)] ?? null) : null,
    () => null,
  );
  React.useEffect(() => {
    if (!cloud || projectId === null) return;
    setQueryError(null);
    setMacError(null);
    setView(null);
    setThisMacId(undefined);
    const subscription = sessionRpcClient().runners.subscribeThisMac.subscribe(undefined, {
      onData: (snapshot) => {
        setThisMacId(snapshot.runnerId);
        setMacError(null);
      },
      onError: (failure) => setMacError(cloudFailure(failure).message),
    });
    let off: (() => void) | undefined;
    const stop = followCloudSession((session) => {
      off?.();
      off = undefined;
      setView(null);
      if (session === null) return;
      const watch = session.client.watchQuery(forComposer, { projectId });
      const read = () => {
        try {
          const value = watch.localQueryResult();
          setView(value === undefined ? null : { projectId, value });
          setQueryError(null);
        } catch (failure) {
          setQueryError(cloudFailure(failure).message);
        }
      };
      off = watch.onUpdate(read);
      read();
    });
    return () => {
      off?.();
      stop();
      subscription.unsubscribe();
    };
  }, [cloud, projectId]);
  const value = cloud && view?.projectId === projectId ? view.value : null;
  const error = cloud ? (macError ?? queryError) : null;
  return {
    runners: value?.runners ?? [],
    selected:
      value === null || thisMacId === undefined || error !== null
        ? null
        : pinnedId === undefined
          ? composerRunnerChoice(value, thisMacId, remembered)
          : (value.runners.find((runner) => runner.id === pinnedId && runnerSelectable(runner)) ??
            null),
    thisMacId: thisMacId ?? null,
    loading: cloud && (value === null || thisMacId === undefined) && error === null,
    error,
    choose: (id) => {
      if (cloud && projectId !== null) remember(projectId, id);
    },
  };
}

export function RunnerPicker({
  state,
  disabled = false,
}: {
  state: RunnerPickerState;
  disabled?: boolean;
}) {
  const label =
    state.selected === null
      ? state.loading
        ? "Loading runners…"
        : "Choose runner"
      : state.selected.status === "online"
        ? state.selected.name
        : composerRunnerStatus(state.selected);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={COMPOSER_CONTROL_SIZE}
          className={COMPOSER_CONFIG_CHIP}
          disabled={disabled || state.loading}
          aria-label={`Runner: ${label}`}
          title={state.error ?? (state.selected ? composerRunnerStatus(state.selected) : label)}
        >
          <DesktopIcon />
          <span className="max-w-32 truncate">{label}</span>
          <CaretUpDownIcon className="size-3" weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        {state.error ? (
          <p role="alert" className="px-2 py-2 text-ui text-destructive">
            {state.error}
          </p>
        ) : null}
        {state.runners.length === 0 && !state.error ? (
          <p className="px-2 py-2 text-ui text-muted-foreground">No runners available</p>
        ) : null}
        <DropdownMenuRadioGroup value={state.selected?.id ?? ""} onValueChange={state.choose}>
          {state.runners.map((runner) => (
            <DropdownMenuRadioItem
              key={runner.id}
              value={runner.id}
              disabled={!runnerSelectable(runner)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">
                  {runner.name}
                  {runner.id === state.thisMacId ? " · This Mac" : ""}
                </span>
                <span className="text-ui text-muted-foreground">
                  {composerRunnerStatus(runner)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
