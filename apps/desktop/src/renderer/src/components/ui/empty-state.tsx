/** Static, surface-specific empty compositions. Read state and commands belong to callers. */
import * as React from "react";
import { Button } from "./button";
import {
  ArchiveIcon,
  AutomationIcon,
  BranchIcon,
  ChatIcon,
  ChevronRightIcon,
  ClockIcon,
  CodeFileIcon,
  ConnectedIcon,
  FolderOpenIcon,
  GuideIcon,
  KeyIcon,
  LockIcon,
  SearchIcon,
  TicketIcon,
  UnlinkIcon,
  type IconComponent,
} from "./icon";
import { cn } from "@renderer/lib/utils";
import "./empty-state.css";

export type EmptyIllustration =
  | "board"
  | "search"
  | "automation"
  | "file"
  | "folder"
  | "archive"
  | "chat"
  | "mcp"
  | "skill"
  | "secret"
  | "failed";
type EmptyAction = {
  label: string;
  onAction(): void;
  icon?: React.ReactNode;
  disabled?: boolean;
  busy?: boolean;
  shortcut?: string;
  keyshortcuts?: string;
  slot?: string;
  readOnly?: boolean;
};
type IllustratedProps = {
  tier: "page" | "panel";
  illustration: EmptyIllustration;
  title: string;
  line?: string;
  action?: EmptyAction;
  status?: "empty" | "filtered" | "unavailable" | "failed";
  headingLevel?: 2 | 3;
  labelledBy?: string;
  className?: string;
};

export function EmptyState(props: { tier: "inline" } | IllustratedProps) {
  const id = React.useId();
  if (props.tier === "inline") return null;
  const Heading = props.headingLevel === 3 ? "h3" : "h2";
  const failed = props.status === "failed" || props.illustration === "failed";
  if (import.meta.env.DEV && (!props.title.trim() || (failed && !props.action)))
    throw new Error(
      "An illustrated state needs a reason title; a failed read also needs recovery.",
    );
  return (
    <section
      className={cn("empty-state", props.className)}
      data-tier={props.tier}
      data-status={failed ? "failed" : (props.status ?? "empty")}
      aria-labelledby={props.labelledBy ? `${props.labelledBy} ${id}` : id}
      role={failed ? "alert" : undefined}
    >
      <EmptyArt illustration={failed ? "failed" : props.illustration} />
      <Heading
        id={id}
        className={props.tier === "page" ? "text-heading font-semibold" : "text-ui font-semibold"}
      >
        {props.title}
      </Heading>
      {props.line ? <p className="empty-line text-ui text-muted-foreground">{props.line}</p> : null}
      {props.action ? (
        <Button
          variant="outline"
          size="default"
          className="empty-action"
          disabled={props.action.disabled || props.action.busy}
          aria-label={props.action.label}
          aria-busy={props.action.busy || undefined}
          aria-keyshortcuts={props.action.keyshortcuts}
          data-slot={props.action.slot}
          data-host-read-only={props.action.readOnly ? "" : undefined}
          onClick={() => props.action?.onAction()}
        >
          {props.action.icon}
          {props.action.label}
          {props.action.shortcut ? (
            <kbd className="text-label font-normal">{props.action.shortcut}</kbd>
          ) : null}
        </Button>
      ) : null}
    </section>
  );
}

const EmptyScope = React.createContext<"panel" | "inline">("panel");
/** Placement is chosen by the owning surface, never by viewport width. */
export function EmptyStateScope({
  tier,
  children,
}: {
  tier: "panel" | "inline";
  children: React.ReactNode;
}) {
  return <EmptyScope.Provider value={tier}>{children}</EmptyScope.Provider>;
}
export function useEmptyStateTier() {
  return React.useContext(EmptyScope);
}
/** Shared navigators remain quiet in a source list, illustrated in an inspector. */
export function PanelEmptyState(props: Omit<IllustratedProps, "tier">) {
  const tier = React.useContext(EmptyScope);
  return tier === "inline" &&
    props.status !== "failed" &&
    props.illustration !== "failed" ? null : (
    <EmptyState {...props} tier="panel" />
  );
}

function Piece({
  name,
  icon: Icon,
  children,
}: {
  name: string;
  icon?: IconComponent;
  children?: React.ReactNode;
}) {
  return (
    <span className={cn("es-piece", name)}>
      {Icon ? <Icon /> : null}
      {children}
    </span>
  );
}
function Wire({ path }: { path: string }) {
  return (
    <svg className="es-wire" viewBox="0 0 240 144">
      <path d={path} />
    </svg>
  );
}
const Files = () => (
  <>
    <Wire path="M77 45H56v60h35M56 75h27" />
    <Piece name="folder-back" icon={FolderOpenIcon} />
    <Piece name="folder-front es-accent" icon={FolderOpenIcon} />
    <Piece name="tree-leaf" icon={CodeFileIcon} />
  </>
);
const Sessions = () => (
  <>
    {["one", "two es-accent"].map((name) => (
      <Piece key={name} name={`session-row ${name}`} icon={ChatIcon}>
        <BranchIcon />
        <span className="row-chevron">
          <ChevronRightIcon />
        </span>
      </Piece>
    ))}
  </>
);
const COMPOSITIONS: Record<EmptyIllustration, () => React.ReactNode> = {
  board: () => (
    <>
      {["one", "two", "three"].map((name, i) => (
        <Piece key={name} name={`mini-column ${name}`}>
          <i className="column-pin" />
          <span className="mini-card">
            <TicketIcon />
          </span>
          {i === 1 ? (
            <span className="mini-card second">
              <TicketIcon />
            </span>
          ) : null}
        </Piece>
      ))}
    </>
  ),
  automation: () => (
    <>
      <Wire path="M101 51C158 18 190 60 153 88" />
      <Piece name="bolt-tile" icon={AutomationIcon} />
      <Piece name="clock-chip es-accent" icon={ClockIcon} />
    </>
  ),
  file: Files,
  folder: Files,
  archive: () => (
    <>
      {["a", "b", "c"].map((name) => (
        <Piece
          key={name}
          name={`filed-card ${name}${name === "b" ? " es-accent" : ""}`}
          icon={TicketIcon}
        />
      ))}
      <Piece name="archive-box" icon={ArchiveIcon} />
    </>
  ),
  mcp: () => (
    <>
      <Wire path="M88 60h20c22 0-2 32 22 32h23" />
      <Piece name="plug-left" icon={ConnectedIcon} />
      <Piece name="plug-right es-accent" icon={ConnectedIcon} />
    </>
  ),
  skill: () => (
    <>
      <Piece name="book-cover" />
      <Piece name="bookmark es-accent" />
      <Piece name="open-book" icon={GuideIcon} />
    </>
  ),
  secret: () => (
    <>
      <Piece name="lock-tile es-accent" icon={LockIcon} />
      <Piece name="key-chip" icon={KeyIcon} />
    </>
  ),
  chat: Sessions,
  search: () => (
    <>
      <Piece name="result-row" icon={TicketIcon}>
        <CodeFileIcon />
        <span className="row-chevron">
          <ChevronRightIcon />
        </span>
      </Piece>
      <Piece name="lens es-accent" icon={SearchIcon} />
    </>
  ),
  failed: () => <Piece name="broken-tile" icon={UnlinkIcon} />,
};
function EmptyArt({ illustration }: { illustration: EmptyIllustration }) {
  const Composition = COMPOSITIONS[illustration];
  return (
    <div className="empty-art" data-composition={illustration} aria-hidden="true">
      <div className="empty-scene">
        <Composition />
      </div>
    </div>
  );
}
