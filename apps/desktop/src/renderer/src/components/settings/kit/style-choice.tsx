import { PrefRow } from "./pref-row";
import { OverrideControl } from "./override";
import { Segmented } from "@renderer/components/ui/segmented";
import { useStyleStore } from "@renderer/stores/style";

/** Typography follows the same inherit/override grammar as canvas and mode. */
export function StyleChoice({ projectId }: { projectId?: string }) {
  const global = useStyleStore((state) => state.global);
  const own = useStyleStore((state) =>
    projectId === undefined ? undefined : state.projects[projectId],
  );
  const setStyle = useStyleStore((state) => state.setStyle);
  const choice = (
    <Segmented
      ariaLabel="Style"
      value={own ?? global}
      options={[
        { key: "macos", label: "macOS" },
        { key: "modern", label: "Modern" },
      ]}
      onChange={(next) => setStyle(next, projectId)}
    />
  );
  return (
    <PrefRow label="Style">
      {projectId === undefined ? (
        choice
      ) : (
        <OverrideControl
          label="Style"
          inheritedValue={global === "macos" ? "macOS" : "Modern"}
          overridden={own !== undefined}
          onRevert={() => setStyle(null, projectId)}
        >
          {choice}
        </OverrideControl>
      )}
    </PrefRow>
  );
}
