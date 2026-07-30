/**
 * Inline `/` skill picker — the composer pattern, not a corner overflow.
 *
 * Opens at the caret when the user types `/` (or continues a `/token`), filters
 * as they type, and commits with Enter / click. Origin-aware: the menu grows
 * from near the caret rather than the viewport center. First open gets a short
 * ease-out; once a skill was just inserted, the next `/` skips the entrance
 * motion so adjacent picks feel instant (Sonner / tooltip "instant" rule).
 */
import * as React from "react";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";

import { cn } from "@renderer/lib/utils";

import { SKILLS, type Skill } from "./model";

const SKILL_GROUPS: Array<{ source: Skill["source"]; label: string }> = [
  { source: "bundled", label: "Volli" },
  { source: "project", label: "This project" },
  { source: "user", label: "Your machine" },
];

export interface SlashQuery {
  /** Start index of the `/token` in the field. */
  from: number;
  /** End index (caret). */
  to: number;
  /** Text after the leading `/`, used to filter. */
  filter: string;
}

/** Find an active `/token` immediately before `caret`, or null. */
export function slashQueryAt(value: string, caret: number): SlashQuery | null {
  if (caret < 1) return null;
  let from = caret - 1;
  while (from >= 0) {
    const ch = value[from];
    if (ch === "/") break;
    if (/\s/.test(ch)) return null;
    from -= 1;
  }
  if (from < 0 || value[from] !== "/") return null;
  // Mid-word `/` (and/or) is prose, not a command — same rule as tokenization.
  if (from > 0 && !/\s/.test(value[from - 1])) return null;
  return { from, to: caret, filter: value.slice(from + 1, caret) };
}

function filterSkills(filter: string): Skill[] {
  const needle = filter.toLowerCase();
  return SKILLS.filter((skill) => {
    const name = skill.name.slice(1).toLowerCase();
    return needle === "" || name.startsWith(needle) || skill.detail.toLowerCase().includes(needle);
  });
}

export function SlashMenu({
  query,
  anchor,
  instant,
  onSelect,
  onDismiss,
}: {
  query: SlashQuery;
  /** Caret anchor inside the editor, in editor-local coordinates. */
  anchor: { top: number; left: number };
  instant: boolean;
  onSelect: (skill: Skill) => void;
  onDismiss: () => void;
}) {
  const skills = filterSkills(query.filter);
  const [active, setActive] = React.useState(0);
  const listId = React.useId();

  React.useEffect(() => {
    setActive(0);
  }, [query.filter]);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (skills.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => (current + step + skills.length) % skills.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        onSelect(skills[active] ?? skills[0]);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onDismiss, onSelect, skills]);

  if (skills.length === 0) {
    return (
      <div
        role="listbox"
        aria-label="Skills"
        className={cn(
          "absolute z-40 w-72 overflow-hidden rounded-lg border border-border bg-popover py-2 shadow-md",
          !instant &&
            "transition-[opacity,transform,scale] duration-150 ease-out starting:scale-[0.97] starting:opacity-0 motion-reduce:transition-none",
        )}
        style={{ top: anchor.top, left: anchor.left }}
      >
        <p className="px-2.5 py-1 text-label text-muted-foreground">No matching skill</p>
      </div>
    );
  }

  let flatIndex = 0;

  return (
    <div
      id={listId}
      role="listbox"
      aria-label="Skills"
      className={cn(
        "absolute z-40 w-72 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-md",
        !instant &&
          "transition-[opacity,transform,scale] duration-150 ease-out starting:scale-[0.97] starting:opacity-0 motion-reduce:transition-none",
      )}
      style={{ top: anchor.top, left: anchor.left, transformOrigin: "top left" }}
    >
      {SKILL_GROUPS.map((group, groupIndex) => {
        const rows = skills.filter((skill) => skill.source === group.source);
        if (rows.length === 0) return null;
        const block = (
          <div key={group.source} className="flex flex-col py-1">
            {groupIndex > 0 ? <div className="mx-2 mb-1 border-t border-border" /> : null}
            <p className="px-2.5 pb-1 text-label text-muted-foreground">{group.label}</p>
            {rows.map((skill) => {
              const index = flatIndex;
              flatIndex += 1;
              return (
                <button
                  key={skill.name}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  id={`${listId}-${index}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(skill);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left",
                    "transition-colors duration-100 ease-out motion-reduce:transition-none",
                    index === active ? "bg-accent text-foreground" : "text-muted-foreground",
                  )}
                >
                  <SparkleIcon
                    weight="fill"
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0",
                      index === active ? "text-primary" : "text-muted-foreground/70",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-ui">{skill.name}</span>
                  <span className="max-w-[9rem] truncate text-label text-muted-foreground">
                    {skill.detail}
                  </span>
                </button>
              );
            })}
          </div>
        );
        return block;
      })}
    </div>
  );
}
