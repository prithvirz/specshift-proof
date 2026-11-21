import { createHash, timingSafeEqual } from "node:crypto";

/** Server-side gate for AI generation. Runs before the request body is read or Gemini is called. */

export { ACCESS_CODE_HEADER } from "./access-header";
export const MIN_ACCESS_CODE_LENGTH = 16;

export type AiAccessDenial =
  | { status: 503; code: "ai_disabled" }
  | { status: 503; code: "ai_misconfigured" }
  | { status: 401; code: "access_code_required" }
  | { status: 401; code: "access_code_invalid" };

export type AiAccessResult = { ok: true } | ({ ok: false } & AiAccessDenial);

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison of fixed-length SHA-256 digests, so input length does not matter. */
export function accessCodeMatches(provided: string, configured: string): boolean {
  return timingSafeEqual(digest(provided), digest(configured));
}

/** AI is enabled only when the flag is exactly "true" (surrounding whitespace ignored). */
export function isAiGenerationEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.AI_GENERATION_ENABLED?.trim() === "true";
}

/**
 * Decides whether a request may use AI generation.
 * Disabled by default. When enabled, a configured code of at least 16 characters is required in every
 * environment, and a missing or invalid configuration fails closed.
 */
export function checkAiAccess(providedCode: string | null, env: NodeJS.ProcessEnv): AiAccessResult {
  if (!isAiGenerationEnabled(env)) return { ok: false, status: 503, code: "ai_disabled" };

  const configured = env.DEMO_ACCESS_CODE?.trim() ?? "";
  if (configured.length < MIN_ACCESS_CODE_LENGTH) {
    return { ok: false, status: 503, code: "ai_misconfigured" };
  }

  const provided = providedCode?.trim() ?? "";
  if (provided === "") return { ok: false, status: 401, code: "access_code_required" };
  if (!accessCodeMatches(provided, configured)) return { ok: false, status: 401, code: "access_code_invalid" };
  return { ok: true };
}

/** Fixed user-facing messages. They never include the configured or submitted code. */
export const ACCESS_DENIAL_MESSAGES: Record<AiAccessDenial["code"], string> = {
  ai_disabled: "AI generation is disabled on this deployment.",
  ai_misconfigured: "AI generation is not configured correctly on the server.",
  access_code_required: "A demo access code is required for AI generation.",
  access_code_invalid: "The demo access code is not correct.",
};
