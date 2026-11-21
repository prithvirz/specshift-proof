import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

import { generateTestCases, InvalidModelOutputError } from "@/lib/ai/generate";
import { ProviderFailure, createGeminiProvider, isTransientProviderError } from "@/lib/ai/provider";
import { DeadlineExceededError, withRetry, type RetryOptions } from "@/lib/ai/retry";

class FakeApiError extends Error {
  constructor(
    public status: number,
    message = `{"error":{"code":${status},"status":"RAW_PROVIDER_DETAIL"}}`,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function timeoutError() {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

const SECRET = "secret-key-xyz";
const env = { GEMINI_API_KEY: SECRET } as unknown as NodeJS.ProcessEnv;

const validJson = JSON.stringify({
  changeSummary: "Threshold drops from 24h to 2h.",
  testCases: [1, 2, 3, 24, 25].map((h) => ({ hoursBeforeStart: h, expectedAllowed: h >= 2, reason: `At ${h}h.` })),
});

/** Deterministic clock: sleeping advances time instantly. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function baseOptions(clock: ReturnType<typeof fakeClock>, overrides: Partial<RetryOptions> = {}): RetryOptions {
  return {
    maxRetries: 2,
    baseDelayMs: 500,
    maxJitterMs: 250,
    attemptTimeoutMs: 15_000,
    deadlineMs: 30_000,
    isRetryable: () => true,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
    ...overrides,
  };
}

describe("withRetry", () => {
  it("returns immediately on first success without sleeping", async () => {
    const clock = fakeClock();
    const attempt = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(attempt, baseOptions(clock))).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("uses exponential backoff with jitter between attempts", async () => {
    const clock = fakeClock();
    const attempt = vi.fn().mockRejectedValueOnce(new Error("a")).mockRejectedValueOnce(new Error("b")).mockResolvedValue("ok");
    await expect(withRetry(attempt, baseOptions(clock))).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(3);
    // 500*2^0 + floor(0.5*250) and 500*2^1 + floor(0.5*250)
    expect(clock.sleeps).toEqual([625, 1125]);
  });

  it("allows at most 2 retries, then throws the last error", async () => {
    const clock = fakeClock();
    const attempt = vi.fn().mockRejectedValue(new Error("still down"));
    await expect(withRetry(attempt, baseOptions(clock))).rejects.toThrow("still down");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("does not retry errors rejected by isRetryable", async () => {
    const clock = fakeClock();
    const attempt = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(withRetry(attempt, baseOptions(clock, { isRetryable: () => false }))).rejects.toThrow("fatal");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("caps each attempt timeout at the remaining deadline", async () => {
    const clock = fakeClock();
    const timeouts: number[] = [];
    const attempt = vi.fn(async (timeoutMs: number) => {
      timeouts.push(timeoutMs);
      clock.advance(10_000);
      if (timeouts.length < 3) throw new Error("slow");
      return "ok";
    });
    await withRetry(attempt, baseOptions(clock));
    // 30000 total: 15000 cap, then 30000-10000-625 = 19375 -> 15000, then 30000-20000-625-1125 = 8250
    expect(timeouts).toEqual([15_000, 15_000, 8_250]);
  });

  it("stops with DeadlineExceededError instead of waiting past the deadline", async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async () => {
      clock.advance(29_000);
      throw new Error("slow");
    });
    await expect(withRetry(attempt, baseOptions(clock))).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });
});

describe("isTransientProviderError", () => {
  it.each([429, 500, 502, 503, 504])("treats HTTP %s as transient", (status) => {
    expect(isTransientProviderError(new FakeApiError(status))).toBe(true);
  });
  it.each([400, 401, 403, 404])("treats HTTP %s as non-transient", (status) => {
    expect(isTransientProviderError(new FakeApiError(status))).toBe(false);
  });
  it("treats attempt timeouts as transient and other errors as not", () => {
    expect(isTransientProviderError(timeoutError())).toBe(true);
    expect(isTransientProviderError(new Error("network weirdness"))).toBe(false);
    expect(isTransientProviderError(new ProviderFailure("provider_error", "empty"))).toBe(false);
  });
});

describe("Gemini provider retries (mocked SDK)", () => {
  beforeEach(() => {
    generateContent.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fast = () => {
    const clock = fakeClock();
    return { clock, provider: createGeminiProvider(env, { sleep: clock.sleep, now: clock.now, random: () => 0 }) };
  };

  it("succeeds after a 503 and a 429", async () => {
    generateContent
      .mockRejectedValueOnce(new FakeApiError(503))
      .mockRejectedValueOnce(new FakeApiError(429))
      .mockResolvedValueOnce({ text: validJson });
    const { clock, provider } = fast();
    await expect(provider.generateJson("sys", "prompt")).resolves.toBe(validJson);
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([500, 1000]);
  });

  it("gives up after 2 retries with a sanitized provider_error", async () => {
    generateContent.mockRejectedValue(new FakeApiError(503, `overloaded for key ${SECRET}`));
    const { provider } = fast();
    const error = await provider.generateJson("sys", "prompt").catch((e: unknown) => e);
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(ProviderFailure);
    expect((error as ProviderFailure).kind).toBe("provider_error");
    expect((error as ProviderFailure).message).not.toContain(SECRET);
    expect((error as ProviderFailure).message).not.toContain("overloaded");
  });

  it("reports repeated attempt timeouts as a timeout", async () => {
    generateContent.mockRejectedValue(timeoutError());
    const { provider } = fast();
    const error = await provider.generateJson("sys", "prompt").catch((e: unknown) => e);
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect((error as ProviderFailure).kind).toBe("timeout");
  });

  it.each([400, 401, 403, 404])("does not retry HTTP %s", async (status) => {
    generateContent.mockRejectedValue(new FakeApiError(status));
    const { clock, provider } = fast();
    await expect(provider.generateJson("sys", "prompt")).rejects.toMatchObject({ kind: "provider_error" });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("does not retry an empty model response", async () => {
    generateContent.mockResolvedValue({ text: "" });
    const { provider } = fast();
    await expect(provider.generateJson("sys", "prompt")).rejects.toMatchObject({ kind: "provider_error" });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("does not retry malformed model output", async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ changeSummary: "x", testCases: [] }) });
    const { provider } = fast();
    await expect(
      generateTestCases({ oldRequirement: "old", newRequirement: "new" }, provider),
    ).rejects.toBeInstanceOf(InvalidModelOutputError);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("fails fast on a missing API key without calling Gemini", () => {
    expect(() => createGeminiProvider({} as NodeJS.ProcessEnv)).toThrow(ProviderFailure);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("passes the per-attempt timeout to the SDK", async () => {
    generateContent.mockResolvedValue({ text: validJson });
    const { provider } = fast();
    await provider.generateJson("sys", "prompt");
    const config = generateContent.mock.calls[0][0].config;
    expect(config.httpOptions.timeout).toBe(15_000);
    expect(config.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
