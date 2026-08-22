/**
 * Configure → Commands: the `/name` prompt templates this project can run.
 *
 * A table rather than a stack of rows for `DataTable`'s stated reason — it is
 * a homogeneous collection with a shared attribute (which tier it came from),
 * and that attribute belongs in a column where it aligns, not in a pill
 * repeated down every line.
 *
 * The list is already merged project-over-personal by the reader, so a name
 * appears once. Which tier won it is what Source says.
 */
import * as React from "react";
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import type { Project, PromptTemplate } from "@volli/shared";

import { AsyncSection, Cell, DataTable } from "@renderer/components/settings/kit";
import { useAgentIndex } from "@renderer/components/settings/use-agent-index";

import { NewCommandDialog } from "./new-command-dialog";

export function CommandsPane({ project }: { project: Project }) {
  const { state, reload } = useAgentIndex(project.id);
  const [filter, setFilter] = React.useState("all");

  return (
    <AsyncSection
      title="Commands"
      icon={CommandIcon}
      hint={<>Type the name in any composer. Project overrides personal.</>}
      action={<NewCommandDialog projectId={project.id} onCreated={reload} />}
      state={state}
      isEmpty={(data) => data.templates.length === 0}
      empty="No commands yet."
    >
      {(data) => <CommandsTable templates={data.templates} filter={filter} onFilter={setFilter} />}
    </AsyncSection>
  );
}

function CommandsTable({
  templates,
  filter,
  onFilter,
}: {
  templates: readonly PromptTemplate[];
  filter: string;
  onFilter: (next: string) => void;
}) {
  const shown = React.useMemo(
    () => (filter === "all" ? templates : templates.filter((command) => command.source === filter)),
    [filter, templates],
  );

  return (
    <DataTable
      label="Commands available to this project"
      items={shown}
      keyOf={(command) => command.name}
      rows={8}
      search={(command) => `${command.name} ${command.description}`}
      placeholder="Search commands"
      filter={{
        label: "Filter by source",
        value: filter,
        isFiltering: filter !== "all",
        onChange: onFilter,
        options: [
          { value: "all", label: "All sources" },
          { value: "project", label: "This project" },
          { value: "personal", label: "Personal" },
        ],
      }}
      empty="No commands yet."
      noResults="No commands match."
      columns={[
        {
          key: "name",
          header: "Command",
          width: "10rem",
          cell: (command) => <Cell>/{command.name}</Cell>,
        },
        {
          key: "description",
          header: "Description",
          cell: (command) => <Cell muted>{command.description || "No description"}</Cell>,
        },
        {
          key: "source",
          header: "Source",
          width: "7rem",
          cell: (command) => (
            <Cell muted>{command.source === "project" ? "This project" : "Personal"}</Cell>
          ),
        },
      ]}
    />
  );
}
