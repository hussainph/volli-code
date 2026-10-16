/** Exactly one requesting WebContents, adapted to a host-owned stream (VC-556). */
import type { WebContents } from "electron";
import type { HostClientEventSink } from "@volli/host-core/ports";
import type { VolliIpcEvent } from "../ipc/contract";

export function clientEventSink(contents: WebContents): HostClientEventSink {
  return {
    id: String(contents.id),
    isClosed: () => contents.isDestroyed(),
    onceClosed: (listener) => {
      contents.once("destroyed", listener);
    },
    removeCloseListener: (listener) => {
      contents.removeListener("destroyed", listener);
    },
    publish(topic, payload) {
      contents.send(`volli:${topic}` satisfies VolliIpcEvent, payload);
    },
  };
}
