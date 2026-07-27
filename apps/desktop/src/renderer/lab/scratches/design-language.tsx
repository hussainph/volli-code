/**
 * A living reference for the app's design language: the type scale, the pill
 * button scale, and the chip primitives, all rendered from the real tokens and
 * the real components.
 *
 * Kept as the lab's baseline scratch for two reasons. It answers "is the lab
 * actually token-accurate?" at a glance — if these steps look wrong, the lab
 * is lying and nothing else in it can be trusted. And it is the thing to open
 * before inventing a control: nearly every new surface is assembled from what
 * is on this page, and `docs/DESIGN.md` (decision #31) forbids one-off sizes.
 *
 * Uses no stores and no bridge — pure primitives only.
 */
import type { ReactNode } from "react";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TagChip } from "@renderer/components/board/tag-chip";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Switch } from "@renderer/components/ui/switch";

export const title = "Design language";
export const note = "The type scale, pill buttons and chips, from the real tokens";

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-border py-6 first:pt-0 last:border-b-0">
      <h2 className="font-mono text-label uppercase text-muted-foreground">{heading}</h2>
      {children}
    </section>
  );
}

export default function DesignLanguageScratch() {
  return (
    <div className="flex flex-col">
      <Section heading="Type scale">
        <div className="flex flex-col gap-2">
          <p className="text-title text-foreground">Title — page and dialog headings</p>
          <p className="text-heading text-foreground">Heading — section headings</p>
          <p className="text-sm text-foreground">Body — card titles and prose</p>
          <p className="text-ui text-foreground">UI — controls, rows, menu items</p>
          <p className="font-mono text-label uppercase text-muted-foreground">
            Label — metadata, ticket ids, eyebrow text
          </p>
        </div>
      </Section>

      <Section heading="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg">Large</Button>
          <Button>Default</Button>
          <Button size="sm">Small</Button>
          <Button size="xs">Extra small</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section heading="Chips and indicators">
        <div className="flex flex-wrap items-center gap-2">
          <TagChip tag="editor" />
          <TagChip tag="perf" />
          <TagChip tag="infra" />
          <TagChip tag="bug" />
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-ui text-muted-foreground">
            <PriorityIndicator priority="high" /> High
          </span>
          <span className="flex items-center gap-1.5 text-ui text-muted-foreground">
            <PriorityIndicator priority="medium" /> Medium
          </span>
          <span className="flex items-center gap-1.5 text-ui text-muted-foreground">
            <PriorityIndicator priority="low" /> Low
          </span>
        </div>
      </Section>

      <Section heading="Inputs">
        <div className="flex max-w-sm flex-col gap-3">
          <Input placeholder="Ticket title" />
          <label className="flex items-center gap-2 text-ui text-foreground">
            <Switch defaultChecked /> Run in an isolated worktree
          </label>
        </div>
      </Section>

      <Section heading="Surfaces">
        <div className="flex flex-wrap gap-3">
          <div className="rounded-lg border border-border bg-card px-3 py-2.5 text-ui text-foreground">
            bg-card / border-border
          </div>
          <div className="rounded-lg bg-muted px-3 py-2.5 text-ui text-muted-foreground">
            bg-muted / text-muted-foreground
          </div>
          <div className="rounded-lg bg-primary px-3 py-2.5 text-ui text-primary-foreground">
            bg-primary — ember #E8652A
          </div>
        </div>
      </Section>
    </div>
  );
}
