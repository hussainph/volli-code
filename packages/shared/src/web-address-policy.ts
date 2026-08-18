/**
 * Whether one resolved IP address is on the public Internet.
 *
 * The load-bearing half of Volli's web boundary, and the reason it is a pure
 * function: `./web-target-policy.ts` can refuse a name that *looks* local, but a
 * hostname its operator controls resolves to whatever they choose. Only an
 * address check sees that, and it must run against the addresses the runtime is
 * about to connect to rather than against the name it started from.
 *
 * Classification follows the IANA special-purpose registries rather than the
 * three RFC 1918 ranges most SSRF bugs check. Carrier-grade NAT, link-local,
 * benchmarking and the `192.0.0.0/24` protocol-assignment slice are all
 * non-public and none of them are RFC 1918.
 */

/**
 * Why an address is not the public Internet.
 *
 * Named per class rather than as one `not-public` flag so a refusal can be
 * counted and read: "link-local" and "carrier-grade NAT" are different
 * operational stories, and the metadata-service case is the one worth being
 * able to find in a ledger.
 */
export type WebAddressClass =
  | "unparsable"
  | "unspecified"
  | "loopback"
  | "private-use"
  | "link-local"
  | "carrier-grade-nat"
  | "protocol-assignment"
  | "documentation"
  | "benchmarking"
  | "multicast"
  | "reserved"
  | "unique-local";

/** One address's verdict: connectable, or refused under a named class. */
export type WebAddressVerdict =
  | { outcome: "public" }
  | { outcome: "refuse"; class: WebAddressClass; reason: string };

function refuse(cls: WebAddressClass, reason: string): WebAddressVerdict {
  return { outcome: "refuse", class: cls, reason };
}

/** Parse dotted-quad IPv4 into its four octets, or nothing if it is not one. */
function ipv4Octets(address: string): readonly number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    // Rejecting anything but plain decimal is deliberate: `0177.0.0.1` and
    // `0x7f.0.0.1` are read as loopback by some resolvers and as nonsense by
    // others, and a policy that guesses which is a policy that can be wrong.
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

/** Classify a dotted-quad IPv4 address against the IANA special-purpose registry. */
function classifyIpv4(octets: readonly number[]): WebAddressVerdict {
  const [a = 0, b = 0] = octets;
  if (a === 0) return refuse("unspecified", "0.0.0.0/8 is not a routable destination.");
  if (a === 127) return refuse("loopback", "127.0.0.0/8 is this machine.");
  if (a === 10) return refuse("private-use", "10.0.0.0/8 is a private network.");
  if (a === 172 && b >= 16 && b <= 31)
    return refuse("private-use", "172.16.0.0/12 is a private network.");
  if (a === 192 && b === 168) return refuse("private-use", "192.168.0.0/16 is a private network.");
  if (a === 169 && b === 254)
    return refuse("link-local", "169.254.0.0/16 is link-local, and hosts cloud metadata.");
  if (a === 100 && b >= 64 && b <= 127)
    return refuse("carrier-grade-nat", "100.64.0.0/10 is carrier-grade NAT space.");
  if (a === 192 && b === 0) return refuse("protocol-assignment", "192.0.0.0/24 is not public.");
  if (a === 198 && (b === 18 || b === 19))
    return refuse("benchmarking", "198.18.0.0/15 is benchmarking space.");
  if (a >= 224) return refuse("multicast", "224.0.0.0/4 and above are not unicast destinations.");
  return { outcome: "public" };
}

/**
 * Expand an IPv6 address into its eight 16-bit groups.
 *
 * Handles the two spellings that matter for policy: `::` zero-compression, and
 * a trailing dotted-quad (`::ffff:127.0.0.1`), which occupies the last two
 * groups. A scope/zone suffix is dropped before parsing rather than refused —
 * `fe80::1%en0` is still link-local, and reading it as unparsable would file a
 * clear link-local refusal under the wrong name.
 */
function ipv6Groups(address: string): readonly number[] | undefined {
  const zoned = address.split("%")[0] ?? "";
  if (!zoned.includes(":")) return undefined;
  const halves = zoned.split("::");
  if (halves.length > 2) return undefined;

  const parseSide = (side: string): number[] | undefined => {
    if (side === "") return [];
    const groups: number[] = [];
    const parts = side.split(":");
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes(".")) {
        const octets = ipv4Octets(part);
        if (octets === undefined) return undefined;
        groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        groups.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = parseSide(halves[0] ?? "");
  const tail = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) return undefined;

  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

/** Classify eight expanded IPv6 groups against the IANA special-purpose registry. */
function classifyIpv6(groups: readonly number[]): WebAddressVerdict {
  const [g0 = 0, g1 = 0] = groups;
  const leadingZero = groups.slice(0, 5).every((group) => group === 0);

  // An IPv4 destination in IPv6 clothing. Both the mapped (`::ffff:a.b.c.d`)
  // and the deprecated compatible (`::a.b.c.d`) forms reach an IPv4 host, so
  // the IPv4 policy has to be the one that answers for them.
  if (leadingZero && (groups[5] === 0xffff || groups[5] === 0)) {
    const embedded = [
      ((groups[6] ?? 0) >> 8) & 0xff,
      (groups[6] ?? 0) & 0xff,
      ((groups[7] ?? 0) >> 8) & 0xff,
      (groups[7] ?? 0) & 0xff,
    ];
    const allZero = groups.every((group) => group === 0);
    if (allZero) return refuse("unspecified", ":: is not a routable destination.");
    if (groups[5] === 0 && groups[6] === 0 && groups[7] === 1)
      return refuse("loopback", "::1 is this machine.");
    if (groups[5] === 0 && groups[6] === 0) return refuse("reserved", "::/96 is not public.");
    return classifyIpv4(embedded);
  }

  if ((g0 & 0xff00) === 0xff00)
    return refuse("multicast", "ff00::/8 is not a unicast destination.");
  if ((g0 & 0xffc0) === 0xfe80) return refuse("link-local", "fe80::/10 is link-local.");
  if ((g0 & 0xfe00) === 0xfc00)
    return refuse("unique-local", "fc00::/7 is a private network, and hosts cloud metadata.");
  if (g0 === 0x2001 && g1 === 0x0db8)
    return refuse("documentation", "2001:db8::/32 is reserved for documentation.");
  if (g0 === 0x0064 && g1 === 0xff9b && (groups[2] ?? 0) === 1)
    return refuse("reserved", "64:ff9b:1::/48 is local-use translation space.");
  return { outcome: "public" };
}

/**
 * Judge one already-resolved IP address.
 *
 * Fails closed: an address this function cannot parse is refused rather than
 * assumed public, because "I could not tell" and "it is fine" must not be the
 * same answer in a security boundary.
 */
export function classifyWebAddress(address: string): WebAddressVerdict {
  const octets = ipv4Octets(address);
  if (octets !== undefined) return classifyIpv4(octets);
  const groups = ipv6Groups(address);
  if (groups !== undefined) return classifyIpv6(groups);
  return refuse("unparsable", `${address} is not an IP address this policy can classify.`);
}
