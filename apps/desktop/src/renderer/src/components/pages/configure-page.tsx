/**
 * Per-project configuration — the "Configure" nav tab.
 *
 * This project, always. App-wide preferences live in the Settings overlay, and
 * neither surface carries a scope switch: the surface IS the scope (VC-111).
 *
 * The rail identifies the project it is configuring, above the search field.
 * That header is not decoration — Configure is reached from a nav tab that
 * looks the same in every project, and the previous surface put the project
 * name inside one section title, where it read as that section's subject rather
 * than the page's.
 *
 * The rail, the categories and their search keywords live in
 * `settings/configure-groups.tsx`.
 */
import * as React from "react";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";

import { configureGroups } from "@renderer/components/settings/configure-groups";
import { PrefShell } from "@renderer/components/settings/kit";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { cn } from "@renderer/lib/utils";

export function ConfigurePage() {
  const project = useSelectedProject();
  const [activeKey, setActiveKey] = React.useState("skills");

  const groups = React.useMemo(() => (project === null ? [] : configureGroups(project)), [project]);

  if (project === null) {
    return (
      <div className={cn("flex-1", EMPTY_PAGE)}>
        <div className="flex max-w-sm flex-col items-center">
          <div className="mb-4 flex items-center justify-center rounded-xl border border-border bg-card/70 p-2">
            <SlidersHorizontalIcon className="size-5 text-muted-foreground" />
          </div>
          <h1 className="text-heading font-semibold">Nothing to configure</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Select a project first.</p>
        </div>
      </div>
    );
  }

  return (
    <PrefShell
      surfaceLabel="Configure"
      groups={groups}
      header={
        <div className="px-2">
          <p className="truncate text-sm font-semibold" title={project.name}>
            {project.name}
          </p>
          <p className="truncate text-ui text-muted-foreground" title={project.path}>
            {project.path}
          </p>
        </div>
      }
      activeKey={activeKey}
      onSelect={setActiveKey}
    />
  );
}
