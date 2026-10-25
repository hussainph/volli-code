/**
 * The gateway's own error responses. The body fits both SDK families' error
 * envelopes at once (Anthropic reads `error.type` and `error.message`, OpenAI
 * reads `error.message`, `error.code` and `error.type`), so a runner's SDK
 * surfaces the `volli_*` code whichever provider the call was for, before the
 * gateway has even read which one that is. The code is also in a header.
 */
import { GATEWAY_ERROR_HEADER, GATEWAY_ERRORS, type GatewayErrorCode } from "@volli/shared/cloud";

const MESSAGES: Record<GatewayErrorCode, string> = {
  volli_route_not_found: "Not a Volli model gateway route.",
  volli_method_not_allowed: "This method is not relayed.",
  volli_grant_missing: "The request carries no Volli gateway grant.",
  volli_grant_invalid: "The Volli gateway grant is not valid.",
  volli_grant_expired: "The Volli gateway grant has expired.",
  volli_grant_stale: "The Volli gateway grant was sealed under a retired gateway key.",
  volli_grant_revoked: "Access to this connection was revoked.",
  volli_route_not_granted: "The grant does not include this connection.",
  volli_call_id_missing: "The request has no valid x-volli-call-id.",
  volli_body_too_large: "The request body is larger than the gateway relays.",
  volli_upstream_forbidden: "The connection's endpoint is not a public https host.",
  volli_upstream_auth: "The provider rejected this connection's API key.",
  volli_upstream_redirect:
    "The provider answered with a redirect, which the gateway does not follow.",
  volli_upstream_unreachable: "The provider could not be reached.",
  volli_gateway_misconfigured: "The Volli model gateway is misconfigured.",
};

export function gatewayError(code: GatewayErrorCode, callId?: string): Response {
  const headers = new Headers({ "content-type": "application/json", [GATEWAY_ERROR_HEADER]: code });
  if (callId) headers.set("x-volli-call-id", callId);
  const body = { type: "error", error: { type: code, code, message: MESSAGES[code] } };
  return new Response(JSON.stringify(body), { status: GATEWAY_ERRORS[code].status, headers });
}
