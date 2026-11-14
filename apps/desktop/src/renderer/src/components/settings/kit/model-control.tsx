/**
 * Settings' own model select: a right-column popup button on the CONTROL_W
 * ladder, never the chat composer's pill.
 *
 * The composer pill is drawn for a composer: a ghost chip that folds its name
 * away on a container-query ladder. In a settings row that chip sat left in a
 * fixed box and dropped its text (VC-1228). This control names the whole model,
 * searches the same catalog, keeps inheritance as a non-model choice, and
 * gives reasoning its own small select beside it where the model has levels.
 */
import * as React from "react";
import { effortLabel } from "@volli/session-presentation";
import type { ModelAccessModel, ModelAccessProvider, ModelSelection } from "@volli/shared";
import { ModelMark } from "@renderer/components/models/model-identity";
import { Button } from "@renderer/components/ui/button";
import { CheckIcon, UnfoldIcon } from "@renderer/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { SearchableCommand } from "@renderer/components/ui/searchable-command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { defaultFilter } from "cmdk";
import { cn } from "@renderer/lib/utils";
import { CONTROL_W } from "./control-width";

interface Choice {
  key: string;
  model: ModelAccessModel | null;
  label: string;
  providerLabel: string;
}

const INHERIT_KEY = "__inherit__";

export function ModelControl({
  models,
  providers,
  selection,
  inherit,
  disabled,
  onChange,
}: {
  models: readonly ModelAccessModel[];
  providers: readonly ModelAccessProvider[];
  selection: ModelSelection | null;
  /** The inherited value's name; offered as the first, non-model choice. */
  inherit?: string | null;
  disabled: boolean;
  onChange(next: ModelSelection | null): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const providerLabel = React.useCallback(
    (providerId: string) => providers.find((p) => p.id === providerId)?.label ?? providerId,
    [providers],
  );
  const picked =
    selection === null
      ? undefined
      : models.find(
          (m) => m.providerId === selection.providerId && m.modelId === selection.modelId,
        );
  const choices = React.useMemo(() => {
    const all: Choice[] = models.map((model) => ({
      key: `${model.providerId}/${model.modelId}`,
      model,
      label: model.label,
      providerLabel: providerLabel(model.providerId),
    }));
    const needle = query.trim();
    const matched = needle
      ? all.filter(
          (choice) =>
            defaultFilter(
              `${choice.model!.providerId} ${choice.model!.modelId} ${choice.label} ${choice.providerLabel}`,
              needle,
            ) > 0,
        )
      : all;
    return inherit && !needle
      ? [{ key: INHERIT_KEY, model: null, label: inherit, providerLabel: "" }, ...matched]
      : matched;
  }, [models, inherit, providerLabel, query]);

  // A stored selection the catalog no longer offers still names itself.
  const name =
    selection === null ? (inherit ?? "Choose a model") : (picked?.label ?? selection.modelId);
  const provider = selection === null ? null : providerLabel(selection.providerId);
  const identity = provider === null ? name : `${name} · ${provider}`;
  const levels = picked?.reasoningLevels ?? [];

  return (
    <div className="flex max-w-full items-center justify-end gap-2" data-slot="model-control">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={`Model: ${identity}`}
            title={identity}
            className={cn(CONTROL_W.lg, "max-w-full justify-between gap-2 pr-2")}
          >
            <span className="flex min-w-0 items-center gap-2">
              {selection === null ? null : (
                <ModelMark
                  model={
                    picked ?? {
                      providerId: selection.providerId,
                      modelId: selection.modelId,
                      label: selection.modelId,
                    }
                  }
                  providerLabel={provider ?? ""}
                />
              )}
              <span
                className={cn(
                  "min-w-0 truncate",
                  selection === null && inherit === undefined && "text-muted-foreground",
                )}
              >
                {name}
              </span>
            </span>
            <UnfoldIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" showArrow={false} className="w-72 p-0" bodyClassName="p-0">
          <SearchableCommand
            items={choices}
            keyOf={(choice) => choice.key}
            groupOf={(choice) => choice.providerLabel}
            query={query}
            onQueryChange={setQuery}
            placeholder="Model"
            empty="No match"
            onSelect={(choice) => {
              setOpen(false);
              if (choice.model === null) {
                onChange(null);
                return;
              }
              const model = choice.model;
              const reasoningLevel =
                model.reasoningLevels.find((level) => level === selection?.reasoningLevel) ??
                model.reasoningLevels.at(-1) ??
                "off";
              onChange({ providerId: model.providerId, modelId: model.modelId, reasoningLevel });
            }}
            renderItem={(choice) => {
              const chosen =
                choice.model === null
                  ? selection === null
                  : choice.model.providerId === selection?.providerId &&
                    choice.model.modelId === selection.modelId;
              return (
                <>
                  <CheckIcon
                    aria-hidden
                    className={cn("size-3.5 shrink-0", !chosen && "invisible")}
                    strokeWidth={2.25}
                  />
                  {choice.model === null ? null : (
                    <ModelMark model={choice.model} providerLabel={choice.providerLabel} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                </>
              );
            }}
          />
        </PopoverContent>
      </Popover>
      {selection !== null && picked !== undefined && levels.length > 1 ? (
        <Select
          value={selection.reasoningLevel}
          disabled={disabled}
          onValueChange={(next) => {
            const reasoningLevel = levels.find((level) => level === next);
            if (reasoningLevel) onChange({ ...selection, reasoningLevel });
          }}
        >
          <SelectTrigger size="sm" className={CONTROL_W.sm} aria-label={`Effort for ${name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {levels.map((level) => (
              <SelectItem key={level} value={level}>
                {effortLabel(level)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
