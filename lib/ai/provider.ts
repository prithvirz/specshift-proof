import { GoogleGenAI } from "@google/genai";
import { DeadlineExceededError, RETRYABLE_STATUSES, withRetry, type RetryOptions } from "./retry";
import { geminiResponseJsonSchema } from "./schema";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
/** Upper bound for one Gemini attempt. */
export const GEMINI_ATTEMPT_TIMEOUT_MS = 15_000;
/** Overall budget for the initial request, retries, and backoff waits. */
export const GEMINI_DEADLINE_MS = 30_000;
export const GEMINI_MAX_RETRIES = 2;
export const GEMINI_BASE_DELAY_MS = 500;
export const GEMINI_MAX_JITTER_MS = 250;

export type ProviderFailureKind = "missing_api_key" | "timeout" | "provider_error";

export class ProviderFailure extends Error {
  constructor(
    public readonly kind: ProviderFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ProviderFailure";
  }
}

/** Minimal seam so tests can substitute the provider. Returns raw model text. */
export interface TestCaseProvider {
  generateJson(systemInstruction: string, userPrompt: string): Promise<string>;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** The SDK's ApiError carries a numeric HTTP `status`. Checked structurally to avoid coupling to the class. */
function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof Error && "status" in error && typeof error.status === "number") return error.status;
  return undefined;
}

/** Transient = rate limited, temporarily unavailable, or a single attempt timing out. */
export function isTransientProviderError(error: unknown): boolean {
  if (error instanceof ProviderFailure) return false;
  if (isTimeoutError(error)) return true;
  const status = httpStatusOf(error);
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

/** Maps any failure to a sanitized ProviderFailure. The original message is never forwarded. */
function toProviderFailure(error: unknown): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  if (error instanceof DeadlineExceededError) {
    return isTimeoutError(error.lastError)
      ? new ProviderFailure("timeout", "The AI provider timed out.")
      : new ProviderFailure("provider_error", "The AI provider request failed.");
  }
  if (isTimeoutError(error)) return new ProviderFailure("timeout", "The AI provider timed out.");
  return new ProviderFailure("provider_error", "The AI provider request failed.");
}

export type RetryOverrides = Partial<Omit<RetryOptions, "isRetryable">>;

export function createGeminiProvider(
  env: NodeJS.ProcessEnv = process.env,
  retryOverrides: RetryOverrides = {},
): TestCaseProvider {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new ProviderFailure("missing_api_key", "GEMINI_API_KEY is not configured on the server.");
  }
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const ai = new GoogleGenAI({ apiKey });

  return {
    async generateJson(systemInstruction, userPrompt) {
      try {
        return await withRetry(
          async (timeoutMs) => {
            const response = await ai.models.generateContent({
              model,
              contents: userPrompt,
              config: {
                systemInstruction,
                responseMimeType: "application/json",
                responseJsonSchema: geminiResponseJsonSchema,
                temperature: 0.2,
                abortSignal: AbortSignal.timeout(timeoutMs),
                httpOptions: { timeout: timeoutMs },
              },
            });
            const text = response.text;
            if (!text) throw new ProviderFailure("provider_error", "Empty response from model.");
            return text;
          },
          {
            maxRetries: GEMINI_MAX_RETRIES,
            baseDelayMs: GEMINI_BASE_DELAY_MS,
            maxJitterMs: GEMINI_MAX_JITTER_MS,
            attemptTimeoutMs: GEMINI_ATTEMPT_TIMEOUT_MS,
            deadlineMs: GEMINI_DEADLINE_MS,
            ...retryOverrides,
            isRetryable: isTransientProviderError,
          },
        );
      } catch (error) {
        throw toProviderFailure(error);
      }
    },
  };
}
