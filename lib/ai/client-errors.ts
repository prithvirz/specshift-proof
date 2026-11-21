/**
 * Maps failed /api/generate-tests responses to user-facing messages.
 * Some responses (for example a 429 from the hosting firewall) are not JSON, so the
 * status alone must be enough to produce a clear message.
 */

export const NETWORK_ERROR_MESSAGE =
  "Could not reach the server. Check your connection and try again.";

const KNOWN_CODES: Record<string, string> = {
  ai_disabled:
    "AI generation is turned off on this deployment. The seeded demo and the scenario editor still work.",
  ai_misconfigured:
    "AI generation is enabled but not configured correctly on the server. The seeded demo and the scenario editor still work.",
  access_code_required: "Enter the demo access code to use AI generation.",
  access_code_invalid: "That demo access code is not correct. Check it and try again.",
  missing_api_key:
    "AI generation is not configured on the server. The seeded demo and the scenario editor still work.",
  payload_too_large: "The requirement text is too large to send.",
};

const BY_STATUS: Record<number, string> = {
  401: "A valid demo access code is required for AI generation.",
  413: "The requirement text is too large to send.",
  429: "Too many AI generation requests. Wait a few minutes and try again.",
  503: "AI generation is unavailable right now. The seeded demo and the scenario editor still work.",
};

export interface FailedResponseInfo {
  status: number;
  /** The `code` field from a JSON error body, if there was one. */
  code?: string;
  /** The `error` field from a JSON error body, if there was one. */
  message?: string;
}

export function describeGenerationFailure({ status, code, message }: FailedResponseInfo): string {
  if (code && KNOWN_CODES[code]) return KNOWN_CODES[code];
  // 429 always gets the rate-limit message, whatever the body says.
  if (status === 429) return BY_STATUS[429];
  if (message) return message;
  return BY_STATUS[status] ?? `AI generation failed (status ${status}). Try again.`;
}

/** Reads `code` and `error` from a response body without assuming it is JSON. */
export async function readFailedResponse(res: Response): Promise<FailedResponseInfo> {
  const data: unknown = await res.json().catch(() => null);
  const info: FailedResponseInfo = { status: res.status };
  if (data && typeof data === "object") {
    if ("code" in data && typeof data.code === "string") info.code = data.code;
    if ("error" in data && typeof data.error === "string") info.message = data.error;
  }
  return info;
}

/** fetch() rejects with a TypeError when the request never reaches a server. */
export const isNetworkError = (error: unknown) => error instanceof TypeError;
