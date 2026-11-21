/**
 * Server-side retry with exponential backoff, jitter, and an overall deadline.
 * Used only for transient AI-provider failures.
 */

/** HTTP statuses treated as transient: rate limiting and temporary server unavailability. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** Retries after the initial attempt. */
  maxRetries: number;
  /** Backoff before retry n (0-based) is baseDelayMs * 2^n plus jitter. */
  baseDelayMs: number;
  /** Upper bound of the random jitter added to each backoff. */
  maxJitterMs: number;
  /** Upper bound for a single attempt. */
  attemptTimeoutMs: number;
  /** Overall budget for all attempts and waits combined. */
  deadlineMs: number;
  /** Decides whether a failed attempt may be retried. */
  isRetryable: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** Thrown when the overall deadline leaves no time for another attempt. */
export class DeadlineExceededError extends Error {
  constructor(public readonly lastError: unknown) {
    super("Overall request deadline exceeded.");
    this.name = "DeadlineExceededError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Minimum time an attempt needs to be worth starting. */
const MIN_ATTEMPT_MS = 1_000;

/**
 * Runs `attempt` with a per-attempt timeout (passed in as `timeoutMs`) that never exceeds the
 * remaining deadline. Retries only errors accepted by `isRetryable`, and never waits past the deadline.
 */
export async function withRetry<T>(
  attempt: (timeoutMs: number, attemptNumber: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const deadline = now() + options.deadlineMs;

  for (let n = 0; ; n++) {
    const remaining = deadline - now();
    const timeoutMs = Math.min(options.attemptTimeoutMs, remaining);
    try {
      return await attempt(timeoutMs, n + 1);
    } catch (error) {
      if (n >= options.maxRetries || !options.isRetryable(error)) throw error;

      const backoff = options.baseDelayMs * 2 ** n + Math.floor(random() * options.maxJitterMs);
      if (deadline - now() - backoff < MIN_ATTEMPT_MS) throw new DeadlineExceededError(error);
      await sleep(backoff);
    }
  }
}
