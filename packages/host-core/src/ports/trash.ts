/** Trash is a host filesystem operation, never a client picker or permanent deletion. */
export interface TrashPort {
  trashItem(path: string): Promise<void>;
}

export class TrashUnavailableError extends Error {
  readonly code = "trash-unavailable";

  constructor() {
    super(
      "Moving a file to Trash needs the Volli desktop host. This host cannot trash files; nothing was deleted.",
    );
    this.name = "TrashUnavailableError";
  }
}

const HEADLESS_TRASH: TrashPort = {
  trashItem: () => Promise.reject(new TrashUnavailableError()),
};

/** An omitted adapter refuses. It must never fall back to unlink or rm. */
export function trashCapabilities(port: TrashPort | undefined): TrashPort {
  return port ?? HEADLESS_TRASH;
}
