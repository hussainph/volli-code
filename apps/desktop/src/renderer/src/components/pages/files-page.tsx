import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";

/** Placeholder: file preview lands once the sidebar's file tree drives a selection. */
export function FilesPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <FoldersIcon weight="fill" className="size-8 text-muted-foreground" />
      <h2 className="text-heading font-semibold">Files</h2>
      <p className="text-sm text-muted-foreground">
        Select a file in the sidebar to preview it here.
      </p>
    </div>
  );
}
