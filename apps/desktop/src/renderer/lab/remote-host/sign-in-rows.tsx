/**
 * "Use this Mac's sign-ins on <host>?" — one switch per sign-in, and one line
 * that says what the switch costs. That line is the trust boundary CLAUDE.md
 * allows: it is the only sentence on the surface, and it is true.
 */
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";

import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";

import { MAC_SIGN_INS, type SignIn } from "./fixtures";
import { ProviderMark } from "./parts";

export function signInMeta(signIn: SignIn): string {
  return signIn.account ? `${signIn.kind} · ${signIn.account}` : signIn.kind;
}

export function defaultForwarding(): Record<string, boolean> {
  return Object.fromEntries(MAC_SIGN_INS.map((signIn) => [signIn.id, signIn.defaultOn]));
}

export function ForwardRows({
  host,
  value,
  onChange,
  className,
}: {
  host: string;
  value: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="rounded-row border border-border/70 bg-muted/30 p-1">
        {MAC_SIGN_INS.map((signIn) => {
          const id = `forward-${signIn.id}`;
          return (
            <label
              key={signIn.id}
              htmlFor={id}
              className="flex cursor-default items-center gap-2 rounded-[12px] px-2 py-2 transition-colors select-none hover:bg-accent/60"
            >
              <ProviderMark id={signIn.id} name={signIn.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-foreground">
                  {signIn.name}
                </span>
                <span className="block truncate text-ui text-muted-foreground">
                  {signInMeta(signIn)}
                </span>
              </span>
              <Switch
                id={id}
                checked={value[signIn.id] === true}
                onCheckedChange={(checked) => onChange({ ...value, [signIn.id]: checked })}
              />
            </label>
          );
        })}
      </div>
      <p className="flex items-center gap-1 px-2 text-ui text-muted-foreground">
        <LockSimpleIcon aria-hidden className="size-3.5 shrink-0" />
        {host} keeps a copy of each sign-in you turn on.
      </p>
    </div>
  );
}
