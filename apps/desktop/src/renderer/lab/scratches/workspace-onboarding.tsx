/** Production editor at real modal scale; folder and commit remain fixtures here. */
import * as React from "react";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import {
  WorkspaceIdentityEditor,
  type WorkspaceIdentityDraft,
} from "@renderer/components/workspace-identity/editor";
import { IdentityMark } from "@renderer/components/workspace-identity/marks";

export const title = "Workspace onboarding · picked folder";
export const note =
  "Production editor after the native directory picker; fixture folder and commit";

export default function WorkspaceOnboardingScratch() {
  const [open, setOpen] = React.useState(false);
  const [saved, setSaved] = React.useState<WorkspaceIdentityDraft | null>(null);
  const [revision, setRevision] = React.useState(0);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui text-muted-foreground">
        Picked-folder preview · no disk or project writes
      </p>
      <Button
        className="self-start"
        onClick={() => {
          setRevision((value) => value + 1);
          setOpen(true);
        }}
      >
        Preview picked directory
      </Button>
      {saved && (
        <div className="flex items-center gap-4">
          <IdentityMark
            name={saved.name}
            choice={saved.workspaceIdentity.choice}
            surface={saved.workspaceIdentity.surface}
            monogramStyle={saved.workspaceIdentity.monogramStyle}
            canvas={saved.themeCanvas}
            size="rail"
          />
          <span>{saved.name}</span>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="max-h-[calc(100svh-4rem)] w-[calc(100vw-2rem)] overflow-y-auto p-0 sm:max-w-workbench"
        >
          <DialogTitle className="sr-only">New workspace</DialogTitle>
          <WorkspaceIdentityEditor
            key={revision}
            defaultName="Moonshot"
            folderPath="/Users/demo/Code/moonshot"
            seed="onboarding-fixture"
            usedGlyphs={["code", "tree"]}
            busy={false}
            onCancel={() => setOpen(false)}
            onCommit={async (draft) => {
              setSaved(draft);
              setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
