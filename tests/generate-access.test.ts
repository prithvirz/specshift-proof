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

import { POST as generatePOST } from "@/app/api/generate-tests/route";
import { POST as runPOST } from "@/app/api/run-tests/route";
import {
  ACCESS_CODE_HEADER,
  MIN_ACCESS_CODE_LENGTH,
  accessCodeMatches,
  checkAiAccess,
  isAiGenerationEnabled,
} from "@/lib/ai/access";
import { ACCESS_CODE_HEADER as SHARED_HEADER } from "@/lib/ai/access-header";
import {
  NETWORK_ERROR_MESSAGE,
  describeGenerationFailure,
  isNetworkError,
  readFailedResponse,
} from "@/lib/ai/client-errors";
import { readJsonWithLimit } from "@/lib/http/read-json";
import { SEED_CASES } from "@/lib/regression/seed";

const API_KEY = "gemini-key-for-tests-xyz";
const CODE = "correct-horse-battery-staple-42";
const body = {
  oldRequirement: "Cancel if at least 24 hours remain.",
  newRequirement: "Cancel if at least 2 hours remain.",
};
const validModelJson = JSON.stringify({
  changeSummary: "Threshold drops from 24h to 2h.",
  testCases: [1, 2, 3, 24, 25].map((h) => ({ hoursBeforeStart: h, expectedAllowed: h >= 2, reason: `At ${h}h.` })),
});

type Init = { code?: string | null; rawBody?: string | ReadableStream<Uint8Array>; headers?: Record<string, string> };

function generate({ code = CODE, rawBody, headers = {} }: Init = {}) {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (code !== null) h[ACCESS_CODE_HEADER] = code;
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: h,
    body: rawBody ?? JSON.stringify(body),
  };
  if (rawBody instanceof ReadableStream) init.duplex = "half";
  return generatePOST(new Request("http://localhost/api/generate-tests", init));
}

function streamOf(bytes: number, chunk = 8192): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const n = Math.min(chunk, bytes - sent);
      controller.enqueue(new Uint8Array(n).fill(0x20));
      sent += n;
    },
  });
}

/** Collects everything observable: response bodies, headers and console output. */
async function observable(res: Response) {
  const text = await res.clone().text();
  return `${text}\n${JSON.stringify([...res.headers])}`;
}

let logs: string[] = [];

/** Builds a partial env for pure-function tests. */
const envOf = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  generateContent.mockReset();
  constructed.mockReset();
  generateContent.mockResolvedValue({ text: validModelJson });
  vi.stubEnv("GEMINI_API_KEY", API_KEY);
  vi.stubEnv("GEMINI_MODEL", "");
  vi.stubEnv("AI_GENERATION_ENABLED", "true");
  vi.stubEnv("DEMO_ACCESS_CODE", CODE);
  logs = [];
  for (const level of ["error", "warn", "log", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("disabled mode", () => {
  it.each([undefined, "", "false", "TRUE", "1", "yes", "enabled"])(
    "AI_GENERATION_ENABLED=%s returns 503 ai_disabled without calling Gemini",
    async (value) => {
      if (value === undefined) vi.stubEnv("AI_GENERATION_ENABLED", undefined as unknown as string);
      else vi.stubEnv("AI_GENERATION_ENABLED", value);
      const res = await generate();
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("ai_disabled");
      expect(generateContent).not.toHaveBeenCalled();
      expect(constructed).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly 'true', ignoring surrounding whitespace", () => {
    expect(isAiGenerationEnabled(envOf({ AI_GENERATION_ENABLED: "true" }))).toBe(true);
    expect(isAiGenerationEnabled(envOf({ AI_GENERATION_ENABLED: " true " }))).toBe(true);
    expect(isAiGenerationEnabled(envOf({}))).toBe(false);
  });

  it("is checked before the body is parsed", async () => {
    vi.stubEnv("AI_GENERATION_ENABLED", "false");
    const res = await generate({ rawBody: "{not json" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("ai_disabled");
  });
});

describe("missing or invalid configuration fails closed", () => {
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "                    "],
    ["15 characters", "a".repeat(MIN_ACCESS_CODE_LENGTH - 1)],
  ])("DEMO_ACCESS_CODE %s returns 503 ai_misconfigured", async (_label, value) => {
    vi.stubEnv("DEMO_ACCESS_CODE", value as unknown as string);
    const res = await generate({ code: "anything-at-all-here" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("ai_misconfigured");
    expect(generateContent).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("ai_misconfigured");
  });

  it("accepts a code of exactly 16 characters", async () => {
    const sixteen = "b".repeat(MIN_ACCESS_CODE_LENGTH);
    vi.stubEnv("DEMO_ACCESS_CODE", sixteen);
    expect((await generate({ code: sixteen })).status).toBe(200);
  });

  it("does not depend on NODE_ENV", async () => {
    for (const nodeEnv of ["development", "test", "production"]) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("DEMO_ACCESS_CODE", "");
      expect((await generate()).status).toBe(503);
    }
  });
});

describe("access code", () => {
  it("missing header returns 401 access_code_required", async () => {
    const res = await generate({ code: null });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("access_code_required");
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("empty or whitespace header returns 401 access_code_required", async () => {
    for (const code of ["", "   "]) {
      const res = await generate({ code });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("access_code_required");
    }
  });

  it.each([
    ["different", "totally-different-code-1234"],
    ["same length", CODE.replace(/.$/, "x")],
    ["prefix", CODE.slice(0, -1)],
    ["with suffix", `${CODE}x`],
    ["different case", CODE.toUpperCase()],
  ])("wrong code (%s) returns 401 access_code_invalid", async (_label, code) => {
    const res = await generate({ code });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("access_code_invalid");
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("correct code reaches Gemini and returns 200", async () => {
    const res = await generate();
    expect(res.status).toBe(200);
    expect((await res.json()).testCases).toHaveLength(5);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("is checked before the body is parsed", async () => {
    expect((await generate({ code: null, rawBody: "{not json" })).status).toBe(401);
    expect((await generate({ code: "wrong-wrong-wrong-wrong", rawBody: "{not json" })).status).toBe(401);
  });

  it("after access is granted, a missing Gemini key still returns 503 missing_api_key", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const res = await generate();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("missing_api_key");
  });
});

describe("constant-time digest comparison", () => {
  it("compares inputs of any length without throwing", () => {
    expect(accessCodeMatches(CODE, CODE)).toBe(true);
    expect(accessCodeMatches("", CODE)).toBe(false);
    expect(accessCodeMatches("x".repeat(10_000), CODE)).toBe(false);
    expect(accessCodeMatches("é".repeat(20), "é".repeat(20))).toBe(true);
  });

  it("checkAiAccess returns typed results", () => {
    const env = envOf({ AI_GENERATION_ENABLED: "true", DEMO_ACCESS_CODE: CODE });
    expect(checkAiAccess(CODE, env)).toEqual({ ok: true });
    expect(checkAiAccess(` ${CODE} `, env)).toEqual({ ok: true });
    expect(checkAiAccess(null, env)).toEqual({ ok: false, status: 401, code: "access_code_required" });
  });
});

describe("secret handling", () => {
  it("never returns or logs the configured code, the submitted code, or the API key", async () => {
    const submittedWrong = "submitted-but-wrong-code-777";
    const responses = [
      await generate({ code: null }),
      await generate({ code: submittedWrong }),
      await generate(),
    ];
    vi.stubEnv("AI_GENERATION_ENABLED", "false");
    responses.push(await generate());
    vi.stubEnv("AI_GENERATION_ENABLED", "true");
    vi.stubEnv("DEMO_ACCESS_CODE", "short");
    responses.push(await generate({ code: "short" }));
    vi.stubEnv("DEMO_ACCESS_CODE", CODE);
    generateContent.mockRejectedValueOnce(Object.assign(new Error(`bad ${API_KEY} ${CODE}`), { status: 403 }));
    responses.push(await generate());

    const seen = (await Promise.all(responses.map(observable))).join("\n") + logs.join("\n");
    expect(seen).not.toContain(CODE);
    expect(seen).not.toContain(submittedWrong);
    expect(seen).not.toContain(API_KEY);
  });

  it("the shared header constant is the one the server reads", () => {
    expect(SHARED_HEADER).toBe(ACCESS_CODE_HEADER);
    expect(ACCESS_CODE_HEADER).toBe("x-demo-access-code");
  });
});

describe("request body size limit", () => {
  it("rejects a declared Content-Length over 64 KB with 413", async () => {
    const res = await generate({ headers: { "Content-Length": String(64 * 1024 + 1) } });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("payload_too_large");
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed body without Content-Length", async () => {
    const res = await generate({ rawBody: streamOf(200 * 1024) });
    expect(res.status).toBe(413);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("accepts the largest valid requirements", async () => {
    const big = { oldRequirement: "o".repeat(3000), newRequirement: "n".repeat(3000) };
    const res = await generate({ rawBody: JSON.stringify(big) });
    expect(res.status).toBe(200);
  });

  it("access is checked before the size limit", async () => {
    expect((await generate({ code: null, rawBody: streamOf(200 * 1024) })).status).toBe(401);
  });

  it("readJsonWithLimit handles limits, empty bodies and invalid UTF-8", async () => {
    const req = (b: BodyInit) => new Request("http://localhost/x", { method: "POST", body: b });
    expect(await readJsonWithLimit(req('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
    expect(await readJsonWithLimit(req("x".repeat(101)), 100)).toEqual({ ok: false, reason: "too_large" });
    expect(await readJsonWithLimit(req(""), 100)).toEqual({ ok: false, reason: "invalid_json" });
    expect(await readJsonWithLimit(req(new Uint8Array([0x22, 0xff, 0x22])), 100)).toEqual({
      ok: false,
      reason: "invalid_json",
    });
    expect(
      await readJsonWithLimit(new Request("http://localhost/x", { method: "POST" }), 100),
    ).toEqual({ ok: false, reason: "invalid_json" });
  });
});

describe("client-facing error messages", () => {
  it("maps known codes", () => {
    expect(describeGenerationFailure({ status: 503, code: "ai_disabled" })).toMatch(/turned off/);
    expect(describeGenerationFailure({ status: 503, code: "ai_misconfigured" })).toMatch(/not configured correctly/);
    expect(describeGenerationFailure({ status: 401, code: "access_code_required" })).toMatch(/Enter the demo access code/);
    expect(describeGenerationFailure({ status: 401, code: "access_code_invalid" })).toMatch(/not correct/);
    expect(describeGenerationFailure({ status: 413, code: "payload_too_large" })).toMatch(/too large/);
  });

  it("handles a non-JSON 429 from the firewall", async () => {
    const info = await readFailedResponse(new Response("Too Many Requests", { status: 429 }));
    expect(info).toEqual({ status: 429 });
    expect(describeGenerationFailure(info)).toBe(
      "Too many AI generation requests. Wait a few minutes and try again.",
    );
  });

  it("uses the rate-limit message for 429 even with a JSON body", () => {
    expect(describeGenerationFailure({ status: 429, message: "something else" })).toMatch(/Too many/);
  });

  it("falls back to the server message, then to a status message", async () => {
    const info = await readFailedResponse(
      Response.json({ error: "The AI provider request failed. Try again later.", code: "provider_error" }, { status: 502 }),
    );
    expect(describeGenerationFailure(info)).toBe("The AI provider request failed. Try again later.");
    expect(describeGenerationFailure({ status: 503 })).toMatch(/unavailable/);
    expect(describeGenerationFailure({ status: 401 })).toMatch(/access code/);
    expect(describeGenerationFailure({ status: 418 })).toBe("AI generation failed (status 418). Try again.");
  });

  it("recognizes network failures", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new Error("other"))).toBe(false);
    expect(NETWORK_ERROR_MESSAGE).toMatch(/Could not reach the server/);
  });
});

describe("deterministic workflows are unaffected", () => {
  const run = (payload: unknown) =>
    runPOST(
      new Request("http://localhost/api/run-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );

  it("/api/run-tests needs no access code, even with AI disabled", async () => {
    vi.stubEnv("AI_GENERATION_ENABLED", "false");
    vi.stubEnv("DEMO_ACCESS_CODE", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    const res = await run({ cases: SEED_CASES });
    expect(res.status).toBe(200);
    expect((await res.json()).summary).toEqual({ total: 3, passed: 2, failed: 1 });
  });

  it("/api/run-tests ignores the access-code header", async () => {
    const res = await runPOST(
      new Request("http://localhost/api/run-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json", [ACCESS_CODE_HEADER]: "wrong" },
        body: JSON.stringify({ cases: SEED_CASES }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
