/**
 * New command — one of the things this redesign *adds*, so it owes a real
 * design rather than a button that goes nowhere.
 *
 * A command is a markdown file: frontmatter with a description, then a body
 * that IS the prompt. So the dialog is three fields and it writes the file.
 *
 * The name field enforces the one rule the loader has, and enforces it live:
 * the filename becomes the invocation, so a name the `/` grammar cannot spell
 * whole is a command that can never be typed. The Source select decides which
 * of the two merged directories it lands in — the same fact the table's Source
 * column reports back afterwards.
 */
import * as React from "react";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { errorMessage, isWritablePromptTemplateName } from "@volli/shared";

import { CONTROL_W } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Textarea } from "@renderer/components/ui/textarea";
import { toastError } from "@renderer/lib/toast";

export function NewCommandDialog({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [body, setBody] = React.useState("");
  const [scope, setScope] = React.useState<"project" | "personal">("project");
  const [saving, setSaving] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  // A leading slash is what people type; it is not part of the name.
  const slug = name.trim().replace(/^\//, "");
  const malformed = slug.length > 0 && !isWritablePromptTemplateName(slug);
  const canSave = slug.length > 0 && !malformed && body.trim().length > 0 && !saving;

  function reset(): void {
    setName("");
    setDescription("");
    setBody("");
    setScope("project");
    setRefusal(null);
  }

  async function create(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    setRefusal(null);
    try {
      const result = await window.api.files.createPromptTemplate({
        projectId,
        scope,
        name: slug,
        description: description.trim(),
        body,
      });
      if (!result.ok) {
        // A name collision is a correction to what was just typed, so it
        // belongs in the dialog beside the field — not in a toast behind it,
        // which is where the dialog would have to close to be read.
        setRefusal(result.error);
        return;
      }
      reset();
      setOpen(false);
      onCreated();
    } catch (error) {
      toastError(`Couldn't create the command: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="xs" variant="ghost">
          <PlusIcon />
          New command
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New command</DialogTitle>
          <DialogDescription>
            Commands are markdown files. Typing the name in a composer runs the prompt below.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="cmd-name" className="text-ui">
              Name
            </label>
            <div className="flex items-center gap-2">
              <span aria-hidden className="text-ui text-muted-foreground">
                /
              </span>
              <Input
                id="cmd-name"
                value={name}
                placeholder="ship"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={malformed}
                aria-describedby={malformed ? "cmd-name-error" : undefined}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {malformed ? (
              <p id="cmd-name-error" role="alert" className="text-ui text-destructive">
                Letters, numbers, dashes and underscores only — it becomes the filename.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="cmd-desc" className="text-ui">
              Description
            </label>
            <Input
              id="cmd-desc"
              value={description}
              placeholder="Open a PR with the ticket body as the description"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="cmd-body" className="text-ui">
              Prompt
            </label>
            <Textarea
              id="cmd-body"
              value={body}
              rows={6}
              placeholder="Read the ticket, open a PR against main, and paste the ticket body as the description."
              onChange={(event) => setBody(event.target.value)}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <label htmlFor="cmd-scope" className="text-ui">
              Save to
            </label>
            <Select
              value={scope}
              onValueChange={(next) => setScope(next as "project" | "personal")}
            >
              <SelectTrigger id="cmd-scope" className={CONTROL_W.lg}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">This project — .volli/commands</SelectItem>
                <SelectItem value="personal">Personal — available everywhere</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {refusal ? (
            <p role="alert" className="text-ui text-destructive">
              {refusal}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => void create()}>
            {saving ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
