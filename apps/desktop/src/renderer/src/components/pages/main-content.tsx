import { useSelectedProject } from "@renderer/hooks/use-selected-project";

/** Stub: the board / sessions / files / settings pages land in the next work package. */
export function MainContent() {
  const selected = useSelectedProject();

  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-sm text-muted-foreground">
        {selected ? selected.name : "Select a project"}
      </p>
    </div>
  );
}
