/**
 * The one place a search endpoint is judged, exercised as the total function it
 * is.
 *
 * The interesting cases are not the public ones — those are `admitWebTarget`'s
 * and are already proven in `@volli/shared`. What these cover is the seam this
 * module exists for: a person's own SearXNG on their own machine is admitted,
 * a person's SearXNG anywhere else is not, and neither answer is reachable from
 * a URL the model or a page supplied.
 */

import { describe, expect, it } from "vite-plus/test";

import { admitSearchEndpoint } from "./search-endpoint";

describe("search endpoint admission", () => {
  it("admits a public https endpoint on the same terms as any other web target", () => {
    const admission = admitSearchEndpoint("https://api.search.brave.com/res/v1/web/search");

    expect(admission).toEqual({
      outcome: "admit",
      endpoint: {
        url: "https://api.search.brave.com/res/v1/web/search",
        scheme: "https",
        hostname: "api.search.brave.com",
        port: 443,
        reach: "public",
      },
    });
  });

  it("passes a public endpoint's refusal through under the rule that refused it", () => {
    // Delegated wholesale rather than restated: a second copy of the port and
    // scheme rules is a second policy to keep in step with the first.
    expect(admitSearchEndpoint("https://search.example.com:8443/search")).toMatchObject({
      outcome: "refuse",
      rule: "target.port",
    });
    expect(admitSearchEndpoint("ftp://search.example.com/search")).toMatchObject({
      outcome: "refuse",
      rule: "endpoint.scheme",
    });
    expect(admitSearchEndpoint("https://169.254.169.254/search")).toMatchObject({
      outcome: "refuse",
      rule: "target.address",
    });
  });

  it("admits a self-hosted instance on this machine, on the port its operator chose", () => {
    // The case the public policy refuses twice over — `localhost` is a blocked
    // name and 8888 is outside the 80/443 allowlist — and the case every
    // SearXNG install actually is.
    expect(admitSearchEndpoint("http://localhost:8888/search")).toEqual({
      outcome: "admit",
      endpoint: {
        url: "http://localhost:8888/search",
        scheme: "http",
        hostname: "localhost",
        port: 8888,
        reach: "this-machine",
      },
    });
  });

  it("admits the loopback literals and the names reserved to them", () => {
    for (const url of [
      "http://127.0.0.1:8888/search",
      "http://127.0.0.53:8080/search",
      "http://[::1]:8888/search",
      "http://searxng.localhost:8888/search",
    ]) {
      expect(admitSearchEndpoint(url)).toMatchObject({
        outcome: "admit",
        endpoint: { reach: "this-machine" },
      });
    }
    // The brackets are URL syntax and not part of the address, so what comes
    // back is what a resolver and a socket are given.
    expect(admitSearchEndpoint("http://[::1]:8888/search")).toMatchObject({
      endpoint: { hostname: "::1" },
    });
  });

  it("reads the fully-qualified spelling of this machine as this machine", () => {
    // `localhost.` is the same name with the root label written out, and a
    // policy that read it as a different one would refuse a legal spelling.
    expect(admitSearchEndpoint("http://localhost.:8888/search")).toMatchObject({
      outcome: "admit",
      endpoint: { reach: "this-machine" },
    });
  });

  it("gives a self-hosted endpoint the port its scheme implies when it names none", () => {
    // An instance behind a reverse proxy on the ordinary port is a spelling
    // with no port in it at all.
    expect(admitSearchEndpoint("http://localhost/search")).toMatchObject({
      outcome: "admit",
      endpoint: { port: 80, reach: "this-machine" },
    });
    expect(admitSearchEndpoint("https://localhost/search")).toMatchObject({
      outcome: "admit",
      endpoint: { port: 443, reach: "this-machine" },
    });
  });

  it("refuses every private host that is not this machine", () => {
    // The narrow decision, stated as a test so widening it is a visible change:
    // "on this machine" is a class of one, and a self-hosted instance on the
    // LAN, on a VPN or behind a name that resolves inward is not admitted here.
    for (const url of [
      "http://192.168.1.5:8888/search",
      "http://10.0.0.4:8888/search",
      "http://searxng.internal:8888/search",
      "http://[fd00::1]:8888/search",
    ]) {
      expect(admitSearchEndpoint(url)).toMatchObject({ outcome: "refuse" });
    }
  });

  it("refuses a metadata service dressed as a self-hosted instance", () => {
    expect(admitSearchEndpoint("http://169.254.169.254:80/search")).toMatchObject({
      outcome: "refuse",
    });
    expect(admitSearchEndpoint("http://metadata.google.internal/search")).toMatchObject({
      outcome: "refuse",
    });
  });

  it("refuses an endpoint that is not a URL at all", () => {
    expect(admitSearchEndpoint("not a url")).toMatchObject({
      outcome: "refuse",
      rule: "endpoint.unparsable",
    });
  });

  it("refuses a scheme that is not an ordinary web request, wherever it points", () => {
    expect(admitSearchEndpoint("file:///etc/passwd")).toMatchObject({
      outcome: "refuse",
      rule: "endpoint.scheme",
    });
    // Including at loopback, where the relaxed reach class would otherwise be
    // the thing deciding.
    expect(admitSearchEndpoint("ws://127.0.0.1:8888/search")).toMatchObject({
      outcome: "refuse",
      rule: "endpoint.scheme",
    });
  });

  it("refuses an endpoint carrying credentials in its authority", () => {
    // A key belongs in a header this module can keep to one origin, not in a
    // URL that disguises its host and lands in every log that ever prints it.
    expect(admitSearchEndpoint("https://user:secret@search.example.com/search")).toMatchObject({
      outcome: "refuse",
      rule: "endpoint.credentials",
    });
    expect(admitSearchEndpoint("http://user:secret@127.0.0.1:8888/search")).toMatchObject({
      outcome: "refuse",
      rule: "endpoint.credentials",
    });
  });

  it("keeps the query a caller put on the endpoint, and drops the fragment", () => {
    const admission = admitSearchEndpoint("http://localhost:8888/search?format=json#top");

    expect(admission).toMatchObject({
      outcome: "admit",
      endpoint: { url: "http://localhost:8888/search?format=json" },
    });
    // Both classes agree on what the endpoint is: a fragment is never sent to a
    // server, so it is not part of the thing that was admitted either.
    expect(admitSearchEndpoint("https://search.example.com/search?x=1#top")).toMatchObject({
      outcome: "admit",
      endpoint: { url: "https://search.example.com/search?x=1" },
    });
  });
});
