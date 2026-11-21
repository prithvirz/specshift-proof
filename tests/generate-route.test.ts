import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
const constructed = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
    constructor(options: unknown) {
      constructed(options);
    }
  },
}));

import { POST } from "@/app/api/generate-tests/route";

const SECRET = "test-secret-key-12345";
const body = {
  oldRequirement: "Cancel if at least 24 hours remain.",
  newRequirement: "Cancel if at least 2 hours remain.",
};

const validModelJson = JSON.stringify({
  changeSummary: "Threshold drops from 24h to 2h.",
  testCases: [1, 2, 3, 24, 25].map((h) => ({
    hoursBeforeStart: h,
    expectedAllowed: h >= 2,
    reason: `Case at ${h} hours.`,
  })),
});

function call(payload: unknown, raw = false) {
  return POST(
    new Request("http://localhost/api/generate-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? (payload as string) : JSON.stringify(payload),
    }),
  );
}

beforeEach(() => {
  generateContent.mockReset();
  constructed.mockReset();
  vi.stubEnv("GEMINI_API_KEY", SECRET);
  vi.stubEnv("GEMINI_MODEL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/generate-tests", () => {
  it("returns validated cases from a mocked Gemini response", async () => {
    generateContent.mockResolvedValue({ text: validModelJson });
    const res = await call(body);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.changeSummary).toMatch(/24h/);
    expect(data.testCases).toHaveLength(5);
    expect(JSON.stringify(data)).not.toContain(SECRET);
    expect(constructed).toHaveBeenCalledWith({ apiKey: SECRET });
  });

  it("uses GEMINI_MODEL when set and a default otherwise, with JSON mode and a timeout", async () => {
    generateContent.mockResolvedValue({ text: validModelJson });
    await call(body);
    expect(generateContent.mock.calls[0][0].model).toBe("gemini-3.5-flash-lite");
    expect(generateContent.mock.calls[0][0].config.responseMimeType).toBe("application/json");
    expect(generateContent.mock.calls[0][0].config.httpOptions.timeout).toBeGreaterThan(0);

    vi.stubEnv("GEMINI_MODEL", "custom-model");
    await call(body);
    expect(generateContent.mock.calls[1][0].model).toBe("custom-model");
  });

  it("returns a clear configuration error when the key is missing", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const res = await call(body);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.code).toBe("missing_api_key");
    expect(data.error).toMatch(/GEMINI_API_KEY/);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("rejects invalid user input before calling Gemini", async () => {
    for (const payload of [{}, { ...body, oldRequirement: "" }, { ...body, newRequirement: "a".repeat(3001) }]) {
      const res = await call(payload);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_input");
    }
    const res = await call("{not json", true);
    expect(res.status).toBe(400);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("rejects malformed model output instead of inventing replacements", async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ changeSummary: "x", testCases: [] }) });
    const res = await call(body);
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.code).toBe("invalid_model_output");
    expect(data.testCases).toBeUndefined();
  });

  it("rejects non-JSON and empty model output", async () => {
    generateContent.mockResolvedValueOnce({ text: "sorry, I cannot" });
    expect((await call(body)).status).toBe(502);
    generateContent.mockResolvedValueOnce({ text: undefined });
    expect((await call(body)).status).toBe(502);
  });

  it("hides raw provider errors and secrets on provider failure", async () => {
    generateContent.mockRejectedValue(new Error(`403 PERMISSION_DENIED for key ${SECRET}`));
    const res = await call(body);
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("PERMISSION_DENIED");
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain(SECRET);
  });

  it("maps timeouts to 504 after retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      generateContent.mockRejectedValue(err);
      const pending = call(body);
      await vi.runAllTimersAsync();
      const res = await pending;
      expect(res.status).toBe(504);
      expect((await res.json()).code).toBe("provider_timeout");
      expect(generateContent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers from a transient 503 server-side and returns 200", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const busy = Object.assign(new Error("model is overloaded"), { status: 503 });
      generateContent.mockRejectedValueOnce(busy).mockResolvedValueOnce({ text: validModelJson });
      const pending = call(body);
      await vi.runAllTimersAsync();
      const res = await pending;
      expect(res.status).toBe(200);
      expect((await res.json()).testCases).toHaveLength(5);
      expect(generateContent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-transient provider errors", async () => {
    generateContent.mockRejectedValue(Object.assign(new Error("bad key"), { status: 403 }));
    const res = await call(body);
    expect(res.status).toBe(502);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
