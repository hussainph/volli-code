/** Dummy-only failure prose for privacy regressions; never real credentials. */
export const STORED_DIAGNOSTIC_SECRET = "owner-dummy-482";
export const DIAGNOSTIC_SECRET_CASES = [
  ["authorization", "Authorization: Bearer auth-dummy-482", ["auth-dummy-482"]],
  ["bearer", "Bearer bearer-dummy-482", ["bearer-dummy-482"]],
  [
    "cookies",
    "Cookie: session=cookie-dummy-482; csrf=csrf-dummy-482",
    ["cookie-dummy-482", "csrf-dummy-482"],
  ],
  ["sk", "sk-dummy-482", ["sk-dummy-482"]],
  ["github", "ghp_dummy482", ["ghp_dummy482"]],
  ["aws", "AKIA1234567890ABCDEF", ["AKIA1234567890ABCDEF"]],
  [
    "jwt",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkdW1teSJ9.dummySignature482",
    ["eyJhbGciOiJIUzI1NiJ9", "dummySignature482"],
  ],
  [
    "request password",
    'Request body: {"password":"password-dummy-482","messages":["prompt-dummy-482"]}',
    ["password-dummy-482", "prompt-dummy-482"],
  ],
  ["stored value", `Wrong value ${STORED_DIAGNOSTIC_SECRET}`, [STORED_DIAGNOSTIC_SECRET]],
] as const;

export const diagnosticCredentialRedaction = {
  redact: (text: string): string => text.replaceAll(STORED_DIAGNOSTIC_SECRET, "[redacted]"),
};
