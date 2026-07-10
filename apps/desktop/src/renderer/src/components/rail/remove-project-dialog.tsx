import type { Project } from "@volli/shared";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

interface RemoveProjectDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RemoveProjectDialog({ project, open, onOpenChange }: RemoveProjectDialogProps) {
  const removeProject = useProjectsStore((state) => state.removeProject);
  const forgetWorkspace = useWorkspaceStore((state) => state.forget);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {project.name} from Volli?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the project from Volli; the folder on disk is untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              removeProject(project.id);
              forgetWorkspace(project.id);
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
