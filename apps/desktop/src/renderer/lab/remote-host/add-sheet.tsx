/**
 * The pieces of the Add-a-host sheet that do not change between the three
 * progress directions: the frame, the address field with `~/.ssh/config`
 * under it, the recoveries a stuck step offers, and the "ready" ending with
 * its sign-ins.
 */
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { QrCodeIcon } from "@phosphor-icons/react/dist/csr/QrCode";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { cn } from "@renderer/lib/utils";

import { SSH_CONFIG, TAILNET_NAME, type SshConfigHost } from "./fixtures";
import type { Answer, Question, Target } from "./install-script";
import { CommandLine, EASE_OUT, HostGlyph, Kbd } from "./parts";
import { ForwardRows } from "./sign-in-rows";

/* ── Frame ──────────────────────────────────────────────────────────────── */

export function SheetFrame({
  width,
  onClose,
  children,
  label,
}: {
  width: number;
  onClose: () => void;
  children: React.ReactNode;
  label: string;
}) {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    // Anchored from the top, not centred: the sheet changes height as the
    // flow moves, and a centred sheet would move its title every time.
    <div className="fixed inset-0 z-50 flex items-start justify-center px-6 pt-[14vh]">
      <motion.div
        className="absolute inset-0 bg-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: EASE_OUT }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-full overflow-hidden rounded-container border border-border bg-background shadow-overlay"
        style={{ maxWidth: width }}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 4, transition: { duration: 0.15, ease: EASE_OUT } }}
        transition={{ duration: 0.26, ease: EASE_OUT }}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close"
          className="absolute top-4 right-4 z-10 text-muted-foreground"
          onClick={onClose}
        >
          <XIcon weight="bold" />
        </Button>
        {children}
      </motion.div>
    </div>
  );
}

/**
 * Screen-to-screen inside the sheet: the old one lets go, the new one settles.
 *
 * The ref is load-bearing: `AnimatePresence mode="popLayout"` pops the
 * exiting screen out of flow through it. Without it the old screen keeps its
 * space while it fades, the new one lands below it and then jumps up.
 */
export function Screen({
  children,
  ref,
}: {
  /** Unused by the drawing; the caller keys the element. Kept for call sites. */
  id?: string;
  children: React.ReactNode;
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 6, filter: "blur(2px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      transition={{ duration: 0.24, ease: EASE_OUT, delay: 0.04 }}
    >
      {children}
    </motion.div>
  );
}

/* ── Entry ──────────────────────────────────────────────────────────────── */

export function parseTarget(raw: string): Target | null {
  const text = raw.trim();
  if (!text) return null;
  const known = SSH_CONFIG.find((host) => host.alias === text);
  if (known)
    return { alias: known.alias, user: known.user, hostname: known.hostname, port: known.port };
  const match = /^(?:([^@\s]+)@)?([^\s:@]+)(?::(\d+))?$/.exec(text);
  if (!match) return null;
  const [, user, hostname, port] = match;
  if (!hostname) return null;
  return {
    alias: hostname.split(".")[0] ?? hostname,
    user: user ?? "hussain",
    hostname,
    port: port ? Number(port) : undefined,
  };
}

interface EntryRow {
  key: string;
  config?: SshConfigHost;
  typed?: Target;
}

export function Entry({
  initialQuery,
  onConnect,
  onPairCode,
  detailColumns = false,
}: {
  initialQuery: string;
  onConnect: (target: Target, config: SshConfigHost | null) => void;
  onPairCode: () => void;
  /** The wide sheet has room to show the port. */
  detailColumns?: boolean;
}) {
  const [query, setQuery] = React.useState(initialQuery);
  const [cursor, setCursor] = React.useState(0);
  const needle = query.trim().toLowerCase();

  const rows = React.useMemo<EntryRow[]>(() => {
    const matches = SSH_CONFIG.filter(
      (host) =>
        needle === "" ||
        host.alias.toLowerCase().includes(needle) ||
        `${host.user}@${host.hostname}`.toLowerCase().includes(needle),
    );
    const exact = SSH_CONFIG.some((host) => host.alias.toLowerCase() === needle);
    const typed = !exact && needle !== "" ? parseTarget(query) : null;
    return [
      ...(typed ? [{ key: "typed", typed }] : []),
      ...matches.map((config) => ({ key: config.alias, config })),
    ];
  }, [needle, query]);

  React.useEffect(() => setCursor(0), [needle]);

  const connect = (row: EntryRow | undefined) => {
    if (!row) return;
    if (row.typed) onConnect(row.typed, null);
    else if (row.config) {
      const { alias, user, hostname, port } = row.config;
      onConnect({ alias, user, hostname, port }, row.config);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="px-6 pt-6 pb-4">
        <h2 className="text-heading font-semibold">Add a host</h2>
      </div>
      <div className="px-6">
        <div className="relative">
          <TerminalWindowIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            aria-label="SSH destination"
            value={query}
            placeholder="user@host"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-9 pr-10 pl-9 font-mono text-sm"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((value) => Math.min(rows.length - 1, value + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                connect(rows[cursor]);
              }
            }}
          />
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2">
            <Kbd>⏎</Kbd>
          </span>
        </div>
      </div>

      <div className="px-4 pt-4 pb-2">
        <SectionHeading as="h3" className="px-2 pb-1 normal-case">
          ~/.ssh/config
        </SectionHeading>
        <div role="listbox" aria-label="Hosts" className="flex max-h-72 flex-col overflow-y-auto">
          {rows.length === 0 ? (
            <p className="px-2 py-2 text-ui text-muted-foreground">No match</p>
          ) : null}
          {rows.map((row, index) => {
            const active = index === cursor;
            const name = row.typed ? row.typed.alias : (row.config?.alias ?? "");
            const address = row.typed
              ? `${row.typed.user}@${row.typed.hostname}`
              : `${row.config?.user}@${row.config?.hostname}`;
            return (
              <button
                key={row.key}
                type="button"
                role="option"
                aria-selected={active}
                onMouseMove={() => setCursor(index)}
                onClick={() => connect(row)}
                className={cn(
                  "group flex h-10 w-full shrink-0 cursor-default items-center gap-2 rounded-[12px] px-2 text-left transition-colors duration-100 select-none",
                  active ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <HostGlyph os={row.config?.paired ? "macos" : null} size="sm" />
                <span className="w-28 shrink-0 truncate text-ui font-medium">
                  {row.typed ? "Connect to" : name}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-ui text-muted-foreground">
                  {address}
                  {detailColumns && row.config?.port ? `:${row.config.port}` : ""}
                </span>
                {row.config?.paired ? (
                  <span className="text-ui text-muted-foreground">Paired</span>
                ) : null}
                <span
                  className={cn(
                    "transition-opacity duration-100",
                    active ? "opacity-100" : "opacity-0",
                  )}
                >
                  <Kbd>⏎</Kbd>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border/60 px-4 py-4">
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onPairCode}>
          <QrCodeIcon />
          Pair with a code
        </Button>
        <Button size="sm" disabled={rows.length === 0} onClick={() => connect(rows[cursor])}>
          Connect
        </Button>
      </div>
    </div>
  );
}

/* ── Recoveries ─────────────────────────────────────────────────────────── */

/**
 * What a stuck step offers. A blocked state gets at most one line and one
 * recovery (CLAUDE.md), plus Back. The step row above already says what went
 * wrong, so `body` is only ever the thing you need to act — a field, a
 * command — never an explanation of the failure.
 */
export function useRecovery(
  question: Question | null,
  host: string,
  user: string,
  answer: (value: Answer) => void,
): { body: React.ReactNode; actions: React.ReactNode } | null {
  const [secret, setSecret] = React.useState("");
  const [remember, setRemember] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const kind = question?.kind ?? null;
  React.useEffect(() => {
    setSecret("");
    setRemember(true);
    setBusy(false);
  }, [kind]);

  if (question === null) return null;
  const reply = (value: Answer) => {
    setBusy(true);
    answer(value);
  };
  const back = (
    <Button size="sm" variant="ghost" onClick={() => reply({ action: "back" })}>
      Back
    </Button>
  );
  const submitSecret = () => {
    if (secret.length > 0) reply({ action: "secret", value: secret, remember });
  };

  switch (question.kind) {
    case "unreachable":
      return {
        body: null,
        actions: (
          <>
            {back}
            <Button size="sm" onClick={() => reply({ action: "retry" })}>
              Try again
            </Button>
          </>
        ),
      };
    case "password":
    case "passphrase": {
      const isPassword = question.kind === "password";
      return {
        body: (
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              type="password"
              aria-label={
                isPassword ? `Password for ${user}@${host}` : `Passphrase for ${question.key}`
              }
              placeholder={
                isPassword ? `Password for ${user}@${host}` : `Passphrase for ${question.key}`
              }
              className="h-9 text-sm"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSecret();
              }}
            />
            <label className="flex cursor-default items-center gap-2 px-1 text-ui text-muted-foreground select-none">
              <Checkbox
                checked={remember}
                onCheckedChange={(value) => setRemember(value === true)}
              />
              {isPassword ? "Add this Mac’s key so it won’t ask again" : "Remember in Keychain"}
            </label>
          </div>
        ),
        actions: (
          <>
            {back}
            <Button size="sm" disabled={secret.length === 0 || busy} onClick={submitSecret}>
              {isPassword ? "Connect" : "Unlock"}
            </Button>
          </>
        ),
      };
    }
    case "unsupported":
      return {
        body: (
          <p className="text-ui text-muted-foreground">
            Volli hosts run on x86-64 Linux or an Apple silicon Mac.
          </p>
        ),
        actions: (
          <Button size="sm" onClick={() => reply({ action: "back" })}>
            Choose another host
          </Button>
        ),
      };
    case "disk":
      return {
        body: null,
        actions: (
          <>
            {back}
            <Button size="sm" onClick={() => reply({ action: "retry" })}>
              Check again
            </Button>
          </>
        ),
      };
    case "older":
      return {
        body: (
          <p className="text-ui text-muted-foreground">
            Its {question.workspaces} workspaces stay either way.
          </p>
        ),
        actions: (
          <>
            <Button size="sm" variant="ghost" onClick={() => reply({ action: "adopt" })}>
              Use {question.version}
            </Button>
            <Button size="sm" onClick={() => reply({ action: "update" })}>
              Update and pair
            </Button>
          </>
        ),
      };
    case "paired":
      return {
        body: null,
        actions: (
          <>
            {back}
            <Button size="sm" onClick={() => reply({ action: "open" })}>
              Open {host}
            </Button>
          </>
        ),
      };
    case "linger":
      return {
        body: (
          <div className="flex flex-col gap-2">
            <CommandLine command={`sudo loginctl enable-linger ${question.user}`} />
            <Input
              autoFocus
              type="password"
              aria-label={`sudo password for ${question.user}`}
              placeholder={`sudo password for ${question.user}`}
              className="h-9 text-sm"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSecret();
              }}
            />
          </div>
        ),
        actions: (
          <>
            {back}
            <Button size="sm" disabled={secret.length === 0 || busy} onClick={submitSecret}>
              Run it
            </Button>
          </>
        ),
      };
    case "identity":
      return {
        body: (
          <p className="text-ui text-muted-foreground">
            It was restored or reinstalled. Devices paired before must pair again.
          </p>
        ),
        actions: (
          <>
            {back}
            <Button size="sm" onClick={() => reply({ action: "repair" })}>
              Pair again
            </Button>
          </>
        ),
      };
  }
}

/** The recovery body, revealed under the steps with the sheet's height following. */
export function RecoveryReveal({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <AnimatePresence initial={false}>
      {children ? (
        <motion.div
          key="recovery"
          className={className}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: EASE_OUT, delay: 0.06 }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/* ── Ready ──────────────────────────────────────────────────────────────── */

export type Transport = "ssh" | "tailscale";

/**
 * How the desktop reaches the host after the install. SSH needs nothing new
 * (the install already proved the route); Tailscale is offered when the box
 * is on a tailnet, because phones and browsers can only come that way.
 */
export function TransportMenu({
  host,
  value,
  onChange,
}: {
  host: string;
  value: Transport;
  onChange: (value: Transport) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="text-muted-foreground">
          <ArrowsLeftRightIcon />
          {value === "ssh" ? "Over SSH" : "Over Tailscale"}
          <CaretDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Reach {host}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as Transport)}>
          <DropdownMenuRadioItem value="ssh">
            <TerminalWindowIcon />
            <span className="flex min-w-0 flex-col">
              <span>SSH</span>
              <span className="truncate text-muted-foreground">This Mac only</span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="tailscale">
            <ArrowsLeftRightIcon />
            <span className="flex min-w-0 flex-col">
              <span>Tailscale</span>
              <span className="truncate font-mono text-muted-foreground">{TAILNET_NAME}</span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ReadyBody({
  host,
  forwarding,
  onForwarding,
  onDone,
  transport,
  onTransport,
}: {
  host: string;
  forwarding: Record<string, boolean>;
  onForwarding: (next: Record<string, boolean>) => void;
  onDone: () => void;
  transport: Transport;
  onTransport: (value: Transport) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE_OUT, delay: 0.12 }}
    >
      <div className="px-6 pb-4">
        <SectionHeading as="h3" className="px-2 pb-2">
          Use this Mac’s sign-ins
        </SectionHeading>
        <ForwardRows host={host} value={forwarding} onChange={onForwarding} />
      </div>
      <div className="flex items-center justify-between border-t border-border/60 px-4 py-4">
        <TransportMenu host={host} value={transport} onChange={onTransport} />
        <Button size="sm" autoFocus onClick={onDone}>
          Done
        </Button>
      </div>
    </motion.div>
  );
}
