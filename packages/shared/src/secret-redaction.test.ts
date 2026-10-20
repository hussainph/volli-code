import { describe, expect, it } from "vite-plus/test";

import {
  isSensitiveKey,
  payloadSecretSpans,
  pemSecretSpans,
  redactPayloadSecrets,
  type PayloadSecretSpan,
} from "./secret-redaction";

// Every credential in this file is an inert, deliberately fake fixture.
const AWS_KEY = "AKIA0123456789ABCDEF";
const AWS_SESSION_KEY = "ASIA0123456789ABCDEF";
const JWT = "eyJhbGciOiJub25lIn0.eyJmaXh0dXJlIjp0cnVlfQ.ZHVtbXk";

function maskSpans(value: string, spans: PayloadSecretSpan[]): string {
  const characters = value.split("");
  for (const { start, end } of spans) {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThanOrEqual(start);
    expect(end).toBeLessThanOrEqual(value.length);
    characters.fill(" ", start, end);
  }
  return characters.join("");
}

describe("sensitive object keys", () => {
  it.each([
    "token",
    "apiKey",
    "api_key",
    "API-KEY",
    "password",
    "Secret",
    "AUTHORIZATION",
    "credential",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "DATABASE_PASSWORD",
    "VENDOR_KEY",
    "signingKey",
    "pwd",
    "DB_PWD",
    "DB_PASSWD",
    "private-key-id",
  ])("recognizes %s", (key) => expect(isSensitiveKey(key)).toBe(true));

  it.each(["command", "path", "key", "monkey", "keyboard", "keyCount", "title", "userMessages"])(
    "keeps %s",
    (key) => expect(isSensitiveKey(key)).toBe(false),
  );
});

describe("credential text", () => {
  it.each([
    AWS_KEY,
    AWS_SESSION_KEY,
    "ghp_fixture_dummy",
    "gho_fixture_dummy",
    "ghu_fixture_dummy",
    "ghs_fixture_dummy",
    "ghr_fixture_dummy",
    "github_pat_fixture_dummy",
    "sk-fixture_dummy",
    "pk_test_fixture_dummy",
    "xoxb-1234-dummy",
    "xoxp-1234-dummy",
    "xox-1234-dummy",
    JWT,
    "-----BEGIN RSA PRIVATE KEY-----\nZHVtbXk=\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\r\nZHVtbXk=\r\n-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nZHVtbXk=\n-----END PRIVATE KEY-----",
    "-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----",
  ])("scrubs a standalone fixture without its surrounding text: %s", (secret) => {
    expect(redactPayloadSecrets(`before ${secret} after`)).toBe("before [redacted] after");
    const raw = `🔐 before ${secret} after`;
    expect(maskSpans(raw, payloadSecretSpans(raw))).toBe(
      `🔐 before ${" ".repeat(secret.length)} after`,
    );
  });

  it("scrubs multiple, nested, and overlapping PEM blocks without leaking bodies or command tails", () => {
    const a = "-----BEGIN A-----";
    const b = "-----BEGIN B-----";
    const endA = "-----END A-----";
    const endB = "-----END B-----";
    const tail = " && rm -rf /important";
    expect(redactPayloadSecrets(`${a}dummy${endA} then ${b}dummy${endB}${tail}`)).toBe(
      `[redacted] then [redacted]${tail}`,
    );
    expect(redactPayloadSecrets(`${a}${b}dummy${endB}${endA}${tail}`)).toBe(`[redacted]${tail}`);
    expect(redactPayloadSecrets(`${a}${b}dummy${endA}${endB}${tail}`)).toBe(`[redacted]${tail}`);
    expect(redactPayloadSecrets(`${a}${a}dummy${endA}${tail}`)).toBe(`[redacted]${tail}`);
    // An unmatched outer label must not hide a complete inner block.
    expect(redactPayloadSecrets(`${a}${b}dummy${endB}${tail}`)).toBe(`${a}[redacted]${tail}`);
    expect(redactPayloadSecrets(`token budget ${endA}`)).toBe(`token budget ${endA}`);
  });

  it("exposes original complete and unfinished PEM spans for live redaction", () => {
    const a = "-----BEGIN A-----body-----END A-----";
    expect(pemSecretSpans(a)).toEqual([{ start: 0, end: a.length }]);
    expect(pemSecretSpans(`${a}\nready`, true)).toEqual([{ start: 0, end: a.length }]);
    expect(pemSecretSpans("safe\n", true)).toEqual([]);
    const partial = "safe\n-----BEGIN PRIVATE";
    expect(pemSecretSpans(partial, true)).toEqual([{ start: 5, end: partial.length }]);
    const nested = "-----BEGIN A----------BEGIN B-----body-----END B-----";
    expect(pemSecretSpans(nested, true)).toEqual([
      { start: 0, end: nested.length },
      { start: 17, end: nested.length },
    ]);
    const crossing = "-----BEGIN A-----\n-----BEGIN B-----\n-----END A-----\nOPAQUE_BODY\n";
    expect(pemSecretSpans(crossing, true)).toEqual([
      { start: 0, end: crossing.indexOf("\nOPAQUE_BODY") },
      { start: 18, end: crossing.length },
    ]);
    const several = `${a}\n${a}\n-----BEGIN C-----pending`;
    expect(pemSecretSpans(several, true).at(-1)).toEqual({
      start: (a.length + 1) * 2,
      end: several.length,
    });
  });

  it.each([
    ["repeated BEGIN candidates", "-----BEGIN 0".repeat(10_000)],
    ["ambiguous delimiter runs", "-----BEGIN 0-----" + "-----".repeat(20_000)],
  ])("preserves malformed PEM %s without backtracking over bodies", (_name, value) => {
    const command = `${value} && rm -rf /important`;
    expect(redactPayloadSecrets(command)).toBe(command);
  });

  it("scrubs URL userinfo only, retaining hosts, paths, queries and command tails", () => {
    expect(
      redactPayloadSecrets(
        "fetch 'https://dummy-user:dummy-pass@example.com/path?x=1#frag'; ftp://dummy@files.example.net/x && rm -rf /important",
      ),
    ).toBe(
      "fetch 'https://[redacted]@example.com/path?x=1#frag'; ftp://[redacted]@files.example.net/x && rm -rf /important",
    );
  });

  it.each(["'", '"', "?", "#", "\\", "<", ">", "@"])(
    "scrubs userinfo containing %s while preserving quoted prose and source spans",
    (punctuation) => {
      for (const surroundingQuote of ["", "'", '"']) {
        for (const suffix of ["", "?x=1#frag", "#frag"]) {
          const protectedText = `://user:ab${punctuation}cd@`;
          const prefix = `🔐 before ${surroundingQuote}https`;
          const tail = `host/path${suffix}${surroundingQuote} after; echo tail`;
          const raw = `${prefix}${protectedText}${tail}`;
          const safe = `${prefix}://[redacted]@${tail}`;
          expect(redactPayloadSecrets(raw)).toBe(safe);
          expect(redactPayloadSecrets(safe)).toBe(safe);
          const spans = payloadSecretSpans(raw);
          expect(spans).toContainEqual({
            start: prefix.length,
            end: prefix.length + protectedText.length,
          });
          expect(maskSpans(raw, spans)).toBe(`${prefix}${" ".repeat(protectedText.length)}${tail}`);
        }
      }
    },
  );

  it("retains authorization schemes and shell separators", () => {
    expect(
      redactPayloadSecrets(
        "Authorization: Basic ZHVtbXk=; Authorization: Bearer dummy|rm -rf /important",
      ),
    ).toBe("Authorization: Basic [redacted]; Authorization: Bearer [redacted]|rm -rf /important");
    expect(redactPayloadSecrets("Bearer dummy.foo.bar; done")).toBe("Bearer [redacted]; done");
    expect(redactPayloadSecrets("Authorization=dummy; Authorization: dummy; done")).toBe(
      "Authorization= [redacted]; Authorization: [redacted]; done",
    );
  });
});

describe("complete sensitive assignments", () => {
  it.each([
    "VENDOR_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "GITHUB_TOKEN",
    "DB_PASSWORD",
    "CLIENT_SECRET",
    "DB_PASSWD",
    "DB_PWD",
    "api key",
    "api-key",
    "credential",
  ])("scrubs the whole %s value, not just a prefix", (name) => {
    expect(redactPayloadSecrets(`${name}=dummy-value;rm -rf /important`)).toBe(
      `${name}= [redacted];rm -rf /important`,
    );
  });

  it.each([
    ["dummy-value&&rm", "&&rm"],
    ["dummy-value|rm", "|rm"],
    ["dummy-value&rm", "&rm"],
    ["dummy-value>out", ">out"],
    ["dummy-value<in", "<in"],
    ["dummy-value)next", ")next"],
    ["dummy-value(next", "(next"],
    ["dummy-value,next", ",next"],
    ["dummy-value\nrm", "\nrm"],
    ["dummy-value echo", " echo"],
    ['"dummy;value with spaces";rm', ";rm"],
    ["'dummy;value with spaces';rm", ";rm"],
    [String.raw`"dummy\";value";rm`, ";rm"],
    [String.raw`dummy\ with\ spaces\;more;rm`, ";rm"],
    [String.raw`'dummy\value';rm`, ";rm"],
    ["dummy\";quoted\"'with spaces'suffix;rm", ";rm"],
    ["dummy\\", ""],
    ["", ""],
  ])("handles quoted/escaped assignment %s", (assigned, tail) => {
    expect(redactPayloadSecrets(`CLIENT_SECRET=${assigned}`)).toBe(
      `CLIENT_SECRET= [redacted]${tail}`,
    );
  });

  it("retains enclosing shell quotes and the command after a quoted script", () => {
    expect(redactPayloadSecrets("bash -c 'TOKEN=dummy;echo done' && rm -rf /important")).toBe(
      "bash -c 'TOKEN= [redacted];echo done' && rm -rf /important",
    );
    expect(
      redactPayloadSecrets("bash -c \"export TOKEN='dummy;value';echo done\" && rm -rf /important"),
    ).toBe('bash -c "export TOKEN= [redacted];echo done" && rm -rf /important');
    expect(redactPayloadSecrets("printf 'TOKEN=dummy' && printf 'tail'")).toBe(
      "printf 'TOKEN= [redacted]' && printf 'tail'",
    );
    expect(redactPayloadSecrets(String.raw`printf \'start\';TOKEN="dummy" && echo tail`)).toBe(
      String.raw`printf \'start\';TOKEN= [redacted] && echo tail`,
    );
  });

  it("handles repeated assignments, safe intervening names, and separators without spaces", () => {
    expect(
      redactPayloadSecrets(
        "PORT=3000 TOKEN=dummy-a;PATH=bin DB_PASSWORD='dummy b'|rm -rf /important",
      ),
    ).toBe("PORT=3000 TOKEN= [redacted];PATH=bin DB_PASSWORD= [redacted]|rm -rf /important");
    expect(redactPayloadSecrets("password: 'dummy password', safe=hello")).toBe(
      "password: [redacted], safe=hello",
    );
  });
});

describe("curl basic and proxy credentials", () => {
  it.each([
    ["-u alice:dummy-pw", "-u alice:[redacted]"],
    ["-ualice:dummy-pw", "-ualice:[redacted]"],
    ["--user alice:dummy-pw", "--user alice:[redacted]"],
    ["--user=alice:dummy-pw", "--user=alice:[redacted]"],
    ["--proxy-user alice:dummy-pw", "--proxy-user alice:[redacted]"],
    ["--proxy-user=alice:dummy-pw", "--proxy-user=alice:[redacted]"],
    ["-Ualice:dummy-pw", "-Ualice:[redacted]"],
    ["-u 'alice:dummy password'", "-u 'alice:[redacted]'"],
    ['-u "alice:dummy password;more"', '-u "alice:[redacted]"'],
    [String.raw`-u "alice:dummy\"password"`, '-u "alice:[redacted]"'],
    [String.raw`-ualice:dummy\ with\ spaces\;more`, "-ualice:[redacted]"],
    ["-u alice:'dummy password'", "-u alice:[redacted]"],
    ['-u alice:dummy"password"suffix', "-u alice:[redacted]"],
    ["-u alice:dummy,password", "-u alice:[redacted]"],
    ["-u :dummy-pw", "-u :[redacted]"],
    ["-u alice:", "-u alice:[redacted]"],
  ])("scrubs %s", (auth, safeAuth) => {
    expect(redactPayloadSecrets(`curl ${auth};rm -rf /important`)).toBe(
      `curl ${safeAuth};rm -rf /important`,
    );
  });

  it("keeps quoted script wrappers separate from quoted credential values", () => {
    expect(redactPayloadSecrets("bash -c 'curl -u alice:dummy' && rm -rf /important")).toBe(
      "bash -c 'curl -u alice:[redacted]' && rm -rf /important",
    );
    expect(redactPayloadSecrets("bash -c \"curl -u 'alice:dummy;pw'\" && rm -rf /important")).toBe(
      "bash -c \"curl -u 'alice:[redacted]'\" && rm -rf /important",
    );
  });

  it("handles start-of-string and multiple chained credentials", () => {
    expect(redactPayloadSecrets("-u alice:dummy-a|curl --user=bob:dummy-b&echo done")).toBe(
      "-u alice:[redacted]|curl --user=bob:[redacted]&echo done",
    );
  });
});

describe("preservation and repeatability", () => {
  it.each([
    "ordinary output",
    "the token budget is exceeded",
    "password rotation is documented",
    "skip pkg-config; xoxo from the build bot",
    "authorization is per Session",
    "api key management lives in Settings",
    "https://example.com/path/alice@example.com?contact=bob@example.com",
    "curl --username alice --proxy-user alice https://example.com",
    "curl -u alice https://example.com",
    "curl -u 'alice' --user=\"bob\" https://example.com",
    "PORT=3000;echo done",
    "AKIA0123456789ABCDE",
    "eyJnot.a",
    "-----BEGIN PRIVATE KEY----- without an end",
  ])("returns a near miss unchanged: %s", (clean) => {
    expect(redactPayloadSecrets(clean)).toBe(clean);
    expect(payloadSecretSpans(clean)).toEqual([]);
  });

  it("never truncates command tails or changes long credential-free arguments", () => {
    const tail = ` && echo ${"x".repeat(40_000)} && rm -rf /important`;
    expect(redactPayloadSecrets(`TOKEN=dummy${tail}`)).toBe(`TOKEN= [redacted]${tail}`);
    const clean = `https://${"a".repeat(40_000)} /path/private@example.com curl -u ${"b".repeat(40_000)} && echo end`;
    expect(redactPayloadSecrets(clean)).toBe(clean);
    const quotedNearMiss = `https://${"ab'cd\"".repeat(10_000)}/path/person@host`;
    expect(redactPayloadSecrets(quotedNearMiss)).toBe(quotedNearMiss);
    expect(payloadSecretSpans(quotedNearMiss)).toEqual([]);
    const candidates = `${"https://ab'cd\"/".repeat(10_000)} end`;
    expect(redactPayloadSecrets(candidates)).toBe(candidates);
    expect(payloadSecretSpans(candidates)).toEqual([]);
    const hyphenatedNearMiss = `key-${"word-".repeat(10_000)}word`;
    expect(redactPayloadSecrets(hyphenatedNearMiss)).toBe(hyphenatedNearMiss);
  });

  it("is idempotent across repeated callers", () => {
    const raw = `TOKEN=dummy; curl -u 'alice:dummy' https://dummy@example.com ${AWS_KEY} ${JWT}; Authorization: Basic ZHVtbXk=`;
    const safe = redactPayloadSecrets(raw);
    expect(redactPayloadSecrets(safe)).toBe(safe);
    expect(redactPayloadSecrets("unchanged")).toBe("unchanged");
    expect(redactPayloadSecrets(raw)).toBe(safe);
  });
});

it.each([
  ["Authorization Bearer dummy-short-secret", "dummy-short-secret"],
  ["Basic ZHVtbXk6c2VjcmV0", "ZHVtbXk6c2VjcmV0"],
  ["Cookie: session=dummy-cookie; csrf=dummy-csrf", "dummy-csrf"],
  ["Set-Cookie: csrf=dummy-csrf; Secure", "dummy-csrf"],
])("scrubs standalone schemes and complete cookie headers: %s", (raw, secret) => {
  expect(redactPayloadSecrets(raw)).not.toContain(secret);
});

it.each([
  "Cookie: session=dummy; csrf=dummy-two; rm -rf /important",
  "Cookie: session=dummy; csrf = dummy-two; rm -rf /important",
  'curl -H "Cookie: session=dummy; csrf=dummy-two" && rm -rf /important',
  "curl -H 'Cookie: session=dummy; csrf=dummy-two; Secure; HttpOnly; Partitioned' && rm -rf /important",
  'Cookie: "session=dummy; csrf=dummy-two"; rm -rf /important',
  "Set-Cookie: session=dummy; Path=/private; Secure; rm -rf /important",
])("scrubs the full cookie header but preserves a command tail: %s", (raw) => {
  const safe = redactPayloadSecrets(raw);
  expect(safe).not.toContain("dummy");
  expect(safe).not.toContain("/private");
  expect(safe).toContain("rm -rf /important");
});

it("scans long cookie-attribute whitespace and near misses without backtracking", () => {
  const tabs = "\t".repeat(50_000);
  const raw = `Cookie: session=dummy;${tabs}csrf${tabs}= ${tabs}second; HttpOnly; Secure; Partitioned; echo tail`;
  expect(redactPayloadSecrets(raw)).toBe("Cookie: [redacted]; echo tail");
  expect(maskSpans(raw, payloadSecretSpans(raw))).not.toContain("second");
  expect(redactPayloadSecrets(`Cookie: session=dummy;${tabs}near_miss${tabs}; echo tail`)).toBe(
    `Cookie: [redacted];${tabs}near_miss${tabs}; echo tail`,
  );
});

describe("original-source payload spans", () => {
  it.each([
    ["https://alice:dummy@example.com/path", "://alice:dummy@"],
    ["ftp://dummy@example.com/path", "://dummy@"],
    ["curl -u alice:dummy", "alice:dummy"],
    ["curl --proxy-user='alice:dummy password'", "'alice:dummy password'"],
    ["Authorization: Basic ZHVtbXk=", "Authorization: Basic ZHVtbXk="],
    ["Authorization: Bearer dummy-secret", "Authorization: Bearer dummy-secret"],
    ["Bearer dummy.foo.bar", "Bearer dummy.foo.bar"],
    ["Basic ZHVtbXk6c2VjcmV0", "Basic ZHVtbXk6c2VjcmV0"],
    [
      "Cookie: session=dummy; csrf=second; HttpOnly",
      "Cookie: session=dummy; csrf=second; HttpOnly",
    ],
    [
      "Set-Cookie: session=dummy; Path=/private; Secure",
      "Set-Cookie: session=dummy; Path=/private; Secure",
    ],
    ["TOKEN='dummy with spaces'", "TOKEN='dummy with spaces'"],
    ["password: dummy", "password: dummy"],
    ["CLIENT_SECRET=", "CLIENT_SECRET="],
    ["api key = dummy", "api key = dummy"],
  ])("covers %s at unchanged UTF-16 offsets", (form, protectedText) => {
    const raw = `🔐 before ${form}; echo tail`;
    const start = raw.indexOf(protectedText);
    const spans = payloadSecretSpans(raw);
    expect(spans).toContainEqual({ start, end: start + protectedText.length });
    const masked = maskSpans(raw, spans);
    expect(masked.slice(start, start + protectedText.length)).toBe(
      " ".repeat(protectedText.length),
    );
    expect(masked).toContain("🔐 before ");
    expect(masked).toContain("; echo tail");
  });

  it("retains offsets across every pass and repeated calls", () => {
    const pem = "-----BEGIN A-----\nbody\n-----END A-----";
    const forms = [
      pem,
      "https://user:dummy@host/path",
      "'https://user:ab'cd@host/path?x=1#frag'",
      '"https://user:ab"cd@host/path?x=1#frag"',
      "curl -u alice:dummy",
      "Cookie: session=dummy",
      "ghp_dummy",
      AWS_KEY,
      JWT,
      "Authorization: Bearer dummy",
      "Basic ZHVtbXk=",
      "TOKEN='dummy value'",
    ];
    const raw = `🔐 ${forms.join("; ")}; echo tail`;
    const spans = payloadSecretSpans(raw);
    const masked = maskSpans(raw, spans);
    for (const secret of [
      "body",
      "user:dummy",
      "user:ab'cd",
      'user:ab"cd',
      "alice:dummy",
      "session=dummy",
      "ghp_dummy",
      AWS_KEY,
      JWT,
      "Bearer dummy",
      "ZHVtbXk=",
      "dummy value",
    ]) {
      expect(masked).not.toContain(secret);
    }
    expect(masked).toContain("host/path");
    expect(masked).toContain("; echo tail");
    expect(payloadSecretSpans(raw)).toEqual(spans);
    const safe = redactPayloadSecrets(raw);
    expect(redactPayloadSecrets(safe)).toBe(safe);
  });

  it.each([
    'TOKEN=ghp_dummy"remaining secret"; echo tail',
    "TOKEN=sk-dummy'other secret'; echo tail",
    "Bearer ghp_dummy.sensitive-suffix; echo tail",
    'curl -u alice:ghp_dummy"remaining secret"; echo tail',
    'Cookie: session=ghp_dummy"remaining secret"; csrf=second; echo tail',
    "-----BEGIN A-----'-----END A----- TOKEN='remaining secret'; echo tail",
    "-----BEGIN A-----'-----END A----- TOKEN=ghp_dummy'remaining secret'; echo tail",
    "-----BEGIN A----------BEGIN B-----body-----END A-----rest-----END B----- TOKEN=dummy; echo tail",
  ])("covers overlapping shared forms without losing word or quote syntax: %s", (raw) => {
    const masked = maskSpans(raw, payloadSecretSpans(raw));
    expect(masked).not.toMatch(/dummy|secret|sensitive|second|body|rest/);
    expect(masked).toContain("; echo tail");
  });

  it.each([
    ["Bearer dummy-sensitive; echo tail", "Bearer"],
    ["sk-dummy-sensitive; echo tail", "-"],
    ["ghp_dummy_sensitive; echo tail", "ghp_"],
    ["stored-prefix\nBearer dummy-sensitive; echo tail", "stored-prefix\nBearer"],
    ["Bearer dummy-sensitive\nstored-suffix; echo tail", "dummy-sensitive\nstored-suffix"],
  ])("unions original exact spans even when %s overlaps %s", (raw, stored) => {
    const start = raw.indexOf(stored);
    const spans = [...payloadSecretSpans(raw), { start, end: start + stored.length }];
    const safe = redactPayloadSecrets(maskSpans(raw, spans));
    expect(safe).not.toMatch(/dummy|sensitive|stored/);
    expect(safe).toContain("; echo tail");
  });

  it("leaves incomplete PEM collection to the live-preview API", () => {
    const raw = "before -----BEGIN PRIVATE KEY----- pending";
    expect(payloadSecretSpans(raw)).toEqual([]);
    expect(pemSecretSpans(raw, true)).toEqual([{ start: 7, end: raw.length }]);
  });
});
