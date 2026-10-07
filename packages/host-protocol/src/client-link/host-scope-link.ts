/** A process-owned device connection to a pinned host, independent of Workspaces. */
import { hostError } from "../errors";
import { buildHostHello, type HostScopeHello, type HostScopeWelcome } from "../handshake";
import { isUuidV4 } from "../identity";
import { validateWelcome, type ValidateWelcomeOptions } from "../welcome";
import {
  createClientLink,
  type ClientLink,
  type ClientLinkState,
  type HostLinkOptions,
} from "./link";

export type HostScopeLinkState = ClientLinkState<HostScopeWelcome>;
export interface HostScopeLink extends ClientLink<HostScopeWelcome> {
  readonly hostId: string;
}
export interface HostScopeLinkOptions extends Omit<
  HostLinkOptions,
  "workspaceId" | "lastSeen" | "verifyProof"
> {
  /** Identity pinned at enrollment; no welcome from another host can make this link ready. */
  readonly hostId: string;
  readonly verifyProof?: ValidateWelcomeOptions<HostScopeWelcome, HostScopeHello>["verifyProof"];
}

export function createHostScopeLink(options: HostScopeLinkOptions): HostScopeLink {
  if (!isUuidV4(options.hostId)) throw new Error("A host scope link requires a pinned host UUIDv4");
  const transport = createClientLink<HostScopeHello, HostScopeWelcome>(options, {
    buildHello: (credential) =>
      buildHostHello({
        scope: "host",
        client: options.client,
        credential,
        features: options.features,
      }),
    welcomePath: "protocol.hostWelcome",
    refusalProbePath: "protocol.welcome",
    scope: "host",
    validate: (welcome, hello) =>
      validateWelcome(welcome, hello, {
        verifyProof: (validated, sent) =>
          validated.host.id !== options.hostId
            ? hostError("welcome-invalid", "The host identity changed. Add it again.")
            : (options.verifyProof?.(validated, sent) ?? null),
      }),
  });
  return { ...transport, hostId: options.hostId };
}
