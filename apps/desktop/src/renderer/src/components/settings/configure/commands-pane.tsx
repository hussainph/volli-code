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

import { AsyncSection, Cell, DataTable, DescriptionCell } from "@renderer/components/settings/kit";
import { useAgentIndex } from "@renderer/components/settings/use-agent-index";

import { MarkdownCommandDialog } from "./markdown-command-dialog";
import { NewCommandDialog } from "./new-command-dialog";

export function CommandsPane({ project }: { project: Project }) {
  const { state, reload } = useAgentIndex(project.id);
  const [filter, setFilter] = React.useState("all");

  return (
    <AsyncSection
      title="Commands"
      icon={CommandIcon}
      action={
        <div className="flex flex-wrap gap-2">
          <MarkdownCommandDialog projectId={project.id} onCreated={reload} />
          <NewCommandDialog projectId={project.id} onCreated={reload} />
        </div>
      }
      fill
      state={state}
      isEmpty={(data) => data.templates.length === 0}
      empty="No commands"
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
      rows="fill"
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
      empty="No commands"
      noResults="No commands match"
      columns={[
        {
          key: "name",
          header: "Command",
          width: "10rem",
          cell: (command) => <Cell strong>/{command.name}</Cell>,
        },
        {
          key: "description",
          header: "Description",
          cell: (command) => (
            <DescriptionCell>{command.description || "No description"}</DescriptionCell>
          ),
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
