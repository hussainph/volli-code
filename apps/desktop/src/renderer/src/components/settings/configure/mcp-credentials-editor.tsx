/**
 * The credential half of the MCP server editor (VC-470): a remote server's
 * headers and OAuth client, a local server's environment.
 *
 * Every value is one of two kinds, and the control says which. A **secret** is
 * typed here, sent to main once when the server is tested or saved, stored in
 * main's user-only credential file, and never shown again — the field reads
 * "Stored" and accepts a replacement. A **reference** is `${NAME}` text read
 * from Volli's environment when the server connects; only the reference is
 * stored. There is no plain-value kind: configuration never holds a value.
 */
import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  mcpCredentialSlot,
  type McpCredentialEntry,
  type McpCredentialFamily,
  type McpCredentialSource,
  type McpOAuthClientConfig,
  type McpTransportConfig,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import { Input } from "@renderer/components/ui/input";
import { cn } from "@renderer/lib/utils";

/** One credential row as the editor holds it: the reference, or a typed secret. */
export interface EditorCredential {
  /** A stable React key for the row, minted by the editor; never sent anywhere. */
  key: string;
  name: string;
  kind: McpCredentialSource["kind"];
  template: string;
  /** A secret typed in this editor session; empty means "keep what is stored". */
  secret: string;
}

export interface EditorOAuth {
  clientId: string;
  secretKind: McpCredentialSource["kind"] | "none";
  secretTemplate: string;
  secret: string;
  callbackPort: string;
  callbackUrl: string;
  scope: string;
}

export interface EditorCredentials {
  env: readonly EditorCredential[];
  headers: readonly EditorCredential[];
  oauth: EditorOAuth;
}

export const EMPTY_OAUTH: EditorOAuth = {
  clientId: "",
  secretKind: "none",
  secretTemplate: "",
  secret: "",
  callbackPort: "",
  callbackUrl: "",
  scope: "",
};

export const EMPTY_CREDENTIALS: EditorCredentials = { env: [], headers: [], oauth: EMPTY_OAUTH };

let rowKeys = 0;
/** A key for a new editor row. */
function rowKey(): string {
  rowKeys += 1;
  return `credential-${rowKeys}`;
}

function fromEntries(entries: readonly McpCredentialEntry[] | undefined): EditorCredential[] {
  return (entries ?? []).map((entry) => ({
    key: rowKey(),
    name: entry.name,
    kind: entry.source.kind,
    template: entry.source.kind === "reference" ? entry.source.template : "",
    secret: "",
  }));
}

/** The editor's view of a stored transport's credentials. */
export function credentialsFromTransport(transport: McpTransportConfig): EditorCredentials {
  if (transport.type === "stdio") return { ...EMPTY_CREDENTIALS, env: fromEntries(transport.env) };
  const oauth = transport.oauth;
  const secret = oauth?.clientSecret;
  return {
    env: [],
    headers: fromEntries(transport.headers),
    oauth: {
      clientId: oauth?.clientId ?? "",
      secretKind: secret === undefined ? "none" : secret.kind,
      secretTemplate: secret?.kind === "reference" ? secret.template : "",
      secret: "",
      callbackPort: oauth?.callbackPort === undefined ? "" : String(oauth.callbackPort),
      callbackUrl: oauth?.callbackUrl ?? "",
      scope: oauth?.scope ?? "",
    },
  };
}

function sourceOf(kind: McpCredentialSource["kind"], template: string): McpCredentialSource {
  return kind === "secret" ? { kind: "secret" } : { kind: "reference", template };
}

function toEntries(rows: readonly EditorCredential[]): McpCredentialEntry[] {
  return rows
    .filter((row) => row.name.trim().length > 0)
    .map((row) => ({ name: row.name.trim(), source: sourceOf(row.kind, row.template) }));
}

/**
 * A transport with the editor's credentials applied, and the secrets typed in
 * this session by slot. Main validates both; the renderer only assembles them.
 */
export function applyCredentials(
  transport: McpTransportConfig,
  credentials: EditorCredentials,
): { transport: McpTransportConfig; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const collect = (family: McpCredentialFamily, rows: readonly EditorCredential[]): void => {
    for (const row of rows) {
      if (row.kind === "secret" && row.secret.length > 0 && row.name.trim().length > 0) {
        secrets[mcpCredentialSlot(family, row.name.trim())] = row.secret;
      }
    }
  };
  if (transport.type === "stdio") {
    const env = toEntries(credentials.env);
    collect("env", credentials.env);
    return {
      transport: {
        type: "stdio",
        command: transport.command,
        args: transport.args,
        ...(env.length === 0 ? {} : { env }),
      },
      secrets,
    };
  }
  const headers = toEntries(credentials.headers);
  collect("header", credentials.headers);
  const draft = credentials.oauth;
  const oauth: McpOAuthClientConfig = {};
  if (draft.clientId.trim().length > 0) oauth.clientId = draft.clientId.trim();
  if (draft.secretKind !== "none" && oauth.clientId !== undefined) {
    oauth.clientSecret = sourceOf(draft.secretKind, draft.secretTemplate);
    if (draft.secretKind === "secret" && draft.secret.length > 0) {
      secrets[MCP_OAUTH_CLIENT_SECRET_SLOT] = draft.secret;
    }
  }
  const port = Number(draft.callbackPort);
  if (draft.callbackPort.trim().length > 0 && Number.isInteger(port)) oauth.callbackPort = port;
  if (draft.callbackUrl.trim().length > 0) oauth.callbackUrl = draft.callbackUrl.trim();
  if (draft.scope.trim().length > 0) oauth.scope = draft.scope.trim();
  return {
    transport: {
      type: "streamable-http",
      url: transport.url,
      ...(headers.length === 0 ? {} : { headers }),
      ...(Object.keys(oauth).length === 0 ? {} : { oauth }),
    },
    secrets,
  };
}

const KIND_SELECT = "h-7 rounded-control border border-border bg-background px-2 text-ui";

/** The value field for one row: a write-only secret, or a `${NAME}` reference. */
function ValueField({
  id,
  label,
  kind,
  template,
  secret,
  stored,
  onTemplate,
  onSecret,
}: {
  id: string;
  label: string;
  kind: McpCredentialSource["kind"];
  template: string;
  secret: string;
  stored: boolean;
  onTemplate: (value: string) => void;
  onSecret: (value: string) => void;
}) {
  return kind === "secret" ? (
    <Input
      id={id}
      aria-label={`${label} value`}
      type="password"
      autoComplete="off"
      placeholder={stored ? "Stored" : "Value"}
      value={secret}
      onChange={(event) => onSecret(event.target.value)}
    />
  ) : (
    <Input
      id={id}
      aria-label={`${label} reference`}
      spellCheck={false}
      placeholder="${NAME}"
      value={template}
      onChange={(event) => onTemplate(event.target.value)}
    />
  );
}

function KindSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: McpCredentialSource["kind"];
  onChange: (kind: McpCredentialSource["kind"]) => void;
}) {
  return (
    <select
      aria-label={`${label} kind`}
      className={KIND_SELECT}
      value={value}
      onChange={(event) => onChange(event.target.value as McpCredentialSource["kind"])}
    >
      <option value="secret">Secret</option>
      <option value="reference">Reference</option>
    </select>
  );
}

/** A list of headers or environment variables. */
function CredentialRows({
  family,
  rows,
  stored,
  onChange,
}: {
  family: McpCredentialFamily;
  rows: readonly EditorCredential[];
  /** Slots that already hold a stored secret. */
  stored: ReadonlySet<string>;
  onChange: (rows: readonly EditorCredential[]) => void;
}) {
  const noun = family === "header" ? "header" : "variable";
  const update = (index: number, patch: Partial<EditorCredential>): void =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div className="grid gap-2 sm:col-span-2">
      <div className="flex items-center justify-between">
        <span className="text-ui">{family === "header" ? "Headers" : "Environment"}</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            onChange([
              ...rows,
              { key: rowKey(), name: "", kind: "secret", template: "", secret: "" },
            ])
          }
        >
          <PlusIcon />
          {`Add ${noun}`}
        </Button>
      </div>
      {rows.map((row, index) => {
        const label = row.name.trim().length === 0 ? `${noun} ${index + 1}` : row.name.trim();
        return (
          <div key={row.key} className="flex items-center gap-2">
            <Input
              aria-label={`${noun} ${index + 1} name`}
              className="w-40 shrink-0"
              spellCheck={false}
              placeholder={family === "header" ? "Authorization" : "API_KEY"}
              value={row.name}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <KindSelect
              label={label}
              value={row.kind}
              onChange={(kind) => update(index, { kind })}
            />
            <ValueField
              id={`mcp-${family}-${index}`}
              label={label}
              kind={row.kind}
              template={row.template}
              secret={row.secret}
              stored={stored.has(mcpCredentialSlot(family, row.name.trim()))}
              onTemplate={(template) => update(index, { template })}
              onSecret={(secret) => update(index, { secret })}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${label}`}
              onClick={() => onChange(rows.filter((_row, at) => at !== index))}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** A pre-registered OAuth client, for authorization servers without dynamic registration. */
function OAuthClientFields({
  oauth,
  stored,
  onChange,
}: {
  oauth: EditorOAuth;
  stored: boolean;
  onChange: (oauth: EditorOAuth) => void;
}) {
  const [open, setOpen] = React.useState(
    oauth.clientId.length > 0 || oauth.scope.length > 0 || oauth.callbackPort.length > 0,
  );
  const set = (patch: Partial<EditorOAuth>): void => onChange({ ...oauth, ...patch });
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="sm:col-span-2">
      <CollapsibleTrigger asChild>
        <Button size="xs" variant="ghost" aria-label={`${open ? "Hide" : "Show"} OAuth client`}>
          <CaretDownIcon aria-hidden className={cn("transition-transform", open && "rotate-180")} />
          OAuth client
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <label className="text-ui" htmlFor="mcp-oauth-client-id">
              Client ID
            </label>
            <Input
              id="mcp-oauth-client-id"
              spellCheck={false}
              value={oauth.clientId}
              onChange={(event) => set({ clientId: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-ui" htmlFor="mcp-oauth-secret">
              Client secret
            </label>
            <div className="flex gap-2">
              <select
                aria-label="Client secret kind"
                className={KIND_SELECT}
                value={oauth.secretKind}
                disabled={oauth.clientId.trim().length === 0}
                onChange={(event) =>
                  set({ secretKind: event.target.value as EditorOAuth["secretKind"] })
                }
              >
                <option value="none">None</option>
                <option value="secret">Secret</option>
                <option value="reference">Reference</option>
              </select>
              {oauth.secretKind === "none" ? null : (
                <ValueField
                  id="mcp-oauth-secret"
                  label="Client secret"
                  kind={oauth.secretKind}
                  template={oauth.secretTemplate}
                  secret={oauth.secret}
                  stored={stored}
                  onTemplate={(secretTemplate) => set({ secretTemplate })}
                  onSecret={(secret) => set({ secret })}
                />
              )}
            </div>
          </div>
          <div className="grid gap-1">
            <label className="text-ui" htmlFor="mcp-oauth-port">
              Callback port
            </label>
            <Input
              id="mcp-oauth-port"
              inputMode="numeric"
              placeholder="Any"
              value={oauth.callbackPort}
              onChange={(event) => set({ callbackPort: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-ui" htmlFor="mcp-oauth-callback-url">
              Callback URL
            </label>
            <Input
              id="mcp-oauth-callback-url"
              spellCheck={false}
              placeholder="http://127.0.0.1/callback"
              value={oauth.callbackUrl}
              onChange={(event) => set({ callbackUrl: event.target.value })}
            />
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <label className="text-ui" htmlFor="mcp-oauth-scope">
              Scope
            </label>
            <Input
              id="mcp-oauth-scope"
              spellCheck={false}
              placeholder="Advertised by the server"
              value={oauth.scope}
              onChange={(event) => set({ scope: event.target.value })}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The editor's credential controls for the transport being edited. */
export function McpCredentialsEditor({
  transport,
  credentials,
  stored,
  onChange,
}: {
  transport: McpTransportConfig["type"];
  credentials: EditorCredentials;
  /** Slots that already hold a stored secret on the saved server. */
  stored: ReadonlySet<string>;
  onChange: (credentials: EditorCredentials) => void;
}) {
  if (transport === "stdio") {
    return (
      <CredentialRows
        family="env"
        rows={credentials.env}
        stored={stored}
        onChange={(env) => onChange({ ...credentials, env })}
      />
    );
  }
  return (
    <>
      <CredentialRows
        family="header"
        rows={credentials.headers}
        stored={stored}
        onChange={(headers) => onChange({ ...credentials, headers })}
      />
      <OAuthClientFields
        oauth={credentials.oauth}
        stored={stored.has(MCP_OAUTH_CLIENT_SECRET_SLOT)}
        onChange={(oauth) => onChange({ ...credentials, oauth })}
      />
    </>
  );
}
