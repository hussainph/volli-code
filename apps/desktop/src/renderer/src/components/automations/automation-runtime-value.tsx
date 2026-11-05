/** Read-only runtime policy plus the current inherited value; never writes a pin. */
import * as React from "react";
import {
  isAutomationRuntimePin,
  isAutomationRuntimeTier,
  resolveDefaultModel,
  type AutomationRuntime,
  type ModelAccessDefaults,
} from "@volli/shared";
import { effortLabel } from "@volli/session-presentation";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { useProjectsStore } from "@renderer/stores/projects";
import { ResolvedModelName } from "@renderer/components/models/resolved-model-name";
import { runtimeLabel } from "./automations-page-model";
export function AutomationRuntimeValue({
  runtime,
  projectId,
  projectTarget,
}: {
  runtime: AutomationRuntime;
  projectId: string;
  projectTarget: boolean;
}) {
  const access = useModelAccessClient();
  const defaultsRead = access?.defaults;
  const revision = access?.revision;
  const [defaults, setDefaults] = React.useState<ModelAccessDefaults | null>(null);
  const projectModel = useProjectsStore(
    (s) => s.projects.find((p) => p.id === projectId)?.sessionModel ?? null,
  );
  React.useEffect(() => {
    let current = true;
    if (defaultsRead)
      void defaultsRead()
        .then((value) => {
          if (current) setDefaults(value);
        })
        .catch(() => {
          if (current) setDefaults(null);
        });
    return () => {
      current = false;
    };
  }, [defaultsRead, revision]);
  const resolved = isAutomationRuntimePin(runtime)
    ? runtime
    : defaults === null
      ? null
      : isAutomationRuntimeTier(runtime)
        ? resolveDefaultModel(defaults, runtime.tier)
        : runtime === null
          ? (projectModel ?? resolveDefaultModel(defaults, projectTarget ? "global" : "ticket"))
          : null;
  return (
    <div className="min-w-0 max-w-full text-ui">
      <span>{isAutomationRuntimePin(runtime) ? null : runtimeLabel(runtime)}</span>
      {resolved && (
        <div
          className={
            isAutomationRuntimePin(runtime) ? undefined : "mt-1 text-label text-muted-foreground"
          }
        >
          <ResolvedModelName
            selection={resolved}
            trailing={`${effortLabel(resolved.reasoningLevel)} effort`}
            className="max-w-full"
          />
        </div>
      )}
    </div>
  );
}
