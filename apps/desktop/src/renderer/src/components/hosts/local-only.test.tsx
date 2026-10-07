// @vitest-environment jsdom
/**
 * Local-only surfaces for a remote project (VC-711): their children never
 * mount for a project a remote host serves, so nothing in them can call
 * `window.api` with its id, and the surface says where it is not available.
 * This Mac's projects, and every project with the flag off, render as before.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hostWorld, type HostWorld } from "./hosts.test-support";
import { LocalOnly, NotAvailableOnHost } from "./local-only";
import { useIsRemoteProject, useRemoteProjectHost } from "./use-hosts";

let world: HostWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
});

/** A child that would reach this Mac's main process the moment it mounts. */
const reached = vi.fn();
function LocalSurface({ projectId }: { projectId: string }) {
  reached(projectId);
  return <p data-testid="local">files of {projectId}</p>;
}

function Probe({ projectId }: { projectId: string | null }) {
  const host = useRemoteProjectHost(projectId);
  const remote = useIsRemoteProject(projectId);
  return <output data-testid="probe">{`${host?.name ?? "this mac"}:${String(remote)}`}</output>;
}

describe("LocalOnly", () => {
  it("never mounts a remote project's local-only surface, and says where it is not available", async () => {
    world = hostWorld();
    reached.mockClear();
    const root = await world.render(
      <>
        <LocalOnly projectId="remote">
          <LocalSurface projectId="remote" />
        </LocalOnly>
        <LocalOnly projectId="remote" fallback={<span data-testid="own">own words</span>}>
          <LocalSurface projectId="remote" />
        </LocalOnly>
        <LocalOnly projectId="remote" fallback={null}>
          <LocalSurface projectId="remote" />
        </LocalOnly>
        <LocalOnly projectId="local">
          <LocalSurface projectId="local" />
        </LocalOnly>
      </>,
    );
    expect(root.querySelector('[data-slot="host-local-only"]')?.textContent).toBe(
      "Not available on hetzner-1 yet",
    );
    expect(root.querySelector('[data-testid="own"]')).not.toBeNull();
    expect(
      [...root.querySelectorAll('[data-testid="local"]')].map((node) => node.textContent),
    ).toEqual(["files of local"]);
    expect(reached.mock.calls).toEqual([["local"]]);
  });

  it("renders every project's surface with the flag off, reading no host store", async () => {
    world = hostWorld({ cloud: false });
    reached.mockClear();
    const root = await world.render(
      <>
        <LocalOnly projectId="remote">
          <LocalSurface projectId="remote" />
        </LocalOnly>
        <Probe projectId="remote" />
      </>,
    );
    expect(reached.mock.calls).toEqual([["remote"]]);
    expect(root.querySelector('[data-slot="host-local-only"]')).toBeNull();
    expect(root.querySelector('[data-testid="probe"]')?.textContent).toBe("this mac:false");
  });

  it("names a remote project's host, and none for This Mac's or no project", async () => {
    world = hostWorld();
    const root = await world.render(
      <>
        <Probe projectId="remote" />
        <Probe projectId="local" />
        <Probe projectId={null} />
        <NotAvailableOnHost hostName="mac-mini" className="extra" />
      </>,
    );
    expect(
      [...root.querySelectorAll('[data-testid="probe"]')].map((node) => node.textContent),
    ).toEqual(["hetzner-1:true", "this mac:false", "this mac:false"]);
    expect(root.querySelector(".extra")?.textContent).toBe("Not available on mac-mini yet");
  });
});
