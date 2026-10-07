/** One bounded listing read per existing-hostd question, never a polling count. */
import * as React from "react";

import { isLinkReady, relayHostLink } from "@renderer/lib/relay-host-link";
import { remoteSessionClient } from "@renderer/lib/remote-session-wire";
import { useHostConnectionStore, type HostLinkView } from "@renderer/stores/host-connection";
import { useRemoteHostsStore } from "@renderer/stores/remote-hosts";

/** Only currently open projects can give this warning a live count. */
export function useRestartSessionCount(questionId: string | null, target: string): number | null {
  const [answer, setAnswer] = React.useState<{
    questionId: string;
    target: string;
    count: number;
  } | null>(null);
  React.useEffect(() => {
    if (questionId === null) return;
    const host = useRemoteHostsStore.getState().hosts.find((entry) => entry.target === target);
    if (host === undefined) return;
    const connections = useHostConnectionStore.getState();
    if (!connections.hosts.some((entry) => entry.id === host.id)) return;
    const projects = Object.entries(connections.projects).filter(
      ([, project]) =>
        project.hostId === host.id &&
        isLinkReady(project.link) &&
        project.granted?.includes("sessions.listing"),
    );
    if (projects.length === 0) return;
    const controller = new AbortController();
    let current = true;
    const timer = setTimeout(() => controller.abort(), 2_000);
    const gone: HostLinkView = { status: "offline", since: 0, retryAt: null };
    const links = projects.map(([projectId]) => ({
      projectId,
      // The general relay's fallback is This Mac (open). A restart warning
      // must instead lose its number when the remote claim is gone or changed.
      link: relayHostLink(projectId, {
        state: {
          getState() {
            const now = useHostConnectionStore.getState();
            const project = now.projects[projectId];
            const kept = useRemoteHostsStore
              .getState()
              .hosts.some((entry) => entry.id === host.id && entry.target === target);
            return kept &&
              now.hosts.some((entry) => entry.id === host.id) &&
              project?.hostId === host.id &&
              project.granted?.includes("sessions.listing")
              ? project.link
              : gone;
          },
          subscribe(listener) {
            const stopLink = useHostConnectionStore.subscribe(listener);
            const stopRegistry = useRemoteHostsStore.subscribe(listener);
            return () => {
              stopLink();
              stopRegistry();
            };
          },
        },
      }),
    }));
    const stops = links.map(({ link }) =>
      link.subscribeState((state) => {
        if (!isLinkReady(state)) {
          controller.abort();
          if (current) setAnswer(null);
        }
      }),
    );
    void Promise.all(
      links.map(({ projectId, link }) =>
        remoteSessionClient(link, host.name).session.listing.query(
          { projectId },
          { signal: controller.signal },
        ),
      ),
    )
      .then(
        (pages) => {
          if (!current || controller.signal.aborted || pages.some((page) => page.omitted > 0))
            return;
          const live = new Set(
            pages.flatMap((page) =>
              page.sessions.flatMap((row) =>
                row.kind === "chat"
                  ? row.record.live
                    ? [row.record.sessionId]
                    : []
                  : row.record.endedAt === null
                    ? [row.record.id]
                    : [],
              ),
            ),
          );
          setAnswer({ questionId, target, count: live.size });
        },
        () => {
          // Optional warning context: the restart warning remains, without a guessed number.
        },
      )
      .finally(() => clearTimeout(timer));
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
      for (const stop of stops) stop();
    };
  }, [questionId, target]);
  return answer?.questionId === questionId && answer.target === target ? answer.count : null;
}
