/**
 * What only a person's own machine can do for the host (VC-554).
 *
 * Opening a link in their browser, revealing a file in Finder, the clipboard
 * and menus all happen on a client, never on the host. Desktop is a client
 * that happens to share a process with its host, so it passes an Electron
 * adapter (`apps/desktop/src/main/client-capabilities.ts`) and nothing about
 * its behavior changes. A headless host passes nothing.
 *
 * Host code never branches on whether a client is there. It asks through
 * {@link clientCapabilities}, which answers with the client's port or with
 * one that refuses every request with a {@link ClientCapabilityUnavailableError}
 * a person can read. `revealInFolder` is synchronous, as Electron's is, and
 * throws it; every other method rejects with it.
 */

/** The four things a client can do for its host. */
export type ClientCapability = "open-external" | "reveal-in-folder" | "clipboard" | "menu";

/** One entry of a {@link ClientCapabilityPort.showMenu} menu. */
export type ClientMenuItem =
  | {
      readonly kind: "item";
      readonly id: string;
      readonly label: string;
      readonly enabled?: boolean;
    }
  | { readonly kind: "separator" };

export interface ClientCapabilityPort {
  /** Opens a URL in the person's default browser. */
  openExternal(url: string): Promise<void>;
  /** Shows a file or directory, selected, in the OS file manager. */
  revealInFolder(path: string): void;
  /** Replaces the clipboard's text. */
  writeClipboardText(text: string): Promise<void>;
  /** The clipboard's text, or `""`. */
  readClipboardText(): Promise<string>;
  /**
   * Shows a menu where the person is pointing. Resolves with the chosen
   * item's id, or `null` when it was dismissed.
   */
  showMenu(items: readonly ClientMenuItem[]): Promise<string | null>;
}

const NEEDS: Record<ClientCapability, string> = {
  "open-external": "Opening a link",
  "reveal-in-folder": "Revealing a file",
  clipboard: "Using the clipboard",
  menu: "Showing a menu",
};

/** A request for something only a client can do, made on a host that has none. */
export class ClientCapabilityUnavailableError extends Error {
  readonly code = "client-capability-unavailable";
  readonly capability: ClientCapability;

  constructor(capability: ClientCapability) {
    super(
      `${NEEDS[capability]} needs the Volli desktop app, and this host is running without one.`,
    );
    this.name = "ClientCapabilityUnavailableError";
    this.capability = capability;
  }
}

export function isClientCapabilityUnavailable(
  error: unknown,
): error is ClientCapabilityUnavailableError {
  return error instanceof ClientCapabilityUnavailableError;
}

function refuse(capability: ClientCapability): never {
  throw new ClientCapabilityUnavailableError(capability);
}

/** Every request refused, readably. What a headless host's code is handed. */
const HEADLESS_CLIENT: ClientCapabilityPort = {
  openExternal: () => Promise.reject(new ClientCapabilityUnavailableError("open-external")),
  revealInFolder: () => refuse("reveal-in-folder"),
  writeClipboardText: () => Promise.reject(new ClientCapabilityUnavailableError("clipboard")),
  readClipboardText: () => Promise.reject(new ClientCapabilityUnavailableError("clipboard")),
  showMenu: () => Promise.reject(new ClientCapabilityUnavailableError("menu")),
};

/** The client's capabilities, or, with no client, a port that refuses each one. */
export function clientCapabilities(port: ClientCapabilityPort | undefined): ClientCapabilityPort {
  return port ?? HEADLESS_CLIENT;
}
