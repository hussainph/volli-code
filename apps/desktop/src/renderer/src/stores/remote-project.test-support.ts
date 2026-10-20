/**
 * Puts one project on a remote host, with the `cloud` flag on, for a store's
 * VC-711 local-only guard cases; answers the undo.
 */
import { useExperimentsStore } from "./experiments";
import { useHostConnectionStore } from "./host-connection";

export const REMOTE_HOST_NAME = "box";

export function remoteProject(projectId: string, options: { cloud?: boolean } = {}): () => void {
  const experiments = useExperimentsStore.getState().snapshot;
  const hosts = useHostConnectionStore.getState();
  useExperimentsStore.setState({
    snapshot: { cloud: { enabled: options.cloud ?? true, source: "storage" } } as never,
  });
  useHostConnectionStore.setState({
    hosts: [
      {
        id: "box-id",
        name: REMOTE_HOST_NAME,
        local: false,
        os: "linux",
        version: null,
        link: { status: "open" },
        liveSessions: null,
        update: null,
        expiredSignIns: [],
      },
    ],
    projects: { [projectId]: { hostId: "box-id", link: { status: "open" } } },
  });
  return () => {
    useExperimentsStore.setState({ snapshot: experiments });
    useHostConnectionStore.setState({ hosts: hosts.hosts, projects: hosts.projects });
  };
}
