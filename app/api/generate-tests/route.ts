import { NextResponse } from "next/server";
import { ACCESS_CODE_HEADER, ACCESS_DENIAL_MESSAGES, checkAiAccess } from "@/lib/ai/access";
import { InvalidModelOutputError, generateTestCases } from "@/lib/ai/generate";
import { ProviderFailure, createGeminiProvider } from "@/lib/ai/provider";
import { generateTestsRequestSchema } from "@/lib/ai/schema";
import { readJsonWithLimit } from "@/lib/http/read-json";

/** Two 3000-character requirements fit comfortably, even with worst-case JSON escaping. */
const MAX_BODY_BYTES = 64 * 1024;

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: message, code }, { status });
}

export async function POST(request: Request) {
  // Access is checked first: no body is read and Gemini is not called for denied requests.
  const access = checkAiAccess(request.headers.get(ACCESS_CODE_HEADER), process.env);
  if (!access.ok) {
    // Log the category only. Never the configured or submitted code.
    if (access.code === "ai_misconfigured") console.error("[generate-tests] access denied: ai_misconfigured");
    return errorResponse(access.code, ACCESS_DENIAL_MESSAGES[access.code], access.status);
  }

  const body = await readJsonWithLimit(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? errorResponse("payload_too_large", "Request body is too large.", 413)
      : errorResponse("invalid_json", "Request body must be valid JSON.", 400);
  }

  const parsed = generateTestsRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid requirements.",
        code: "invalid_input",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }

  try {
    const provider = createGeminiProvider();
    const result = await generateTestCases(parsed.data, provider);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ProviderFailure) {
      console.error(`[generate-tests] provider failure: ${error.kind}`);
      switch (error.kind) {
        case "missing_api_key":
          return errorResponse(
            "missing_api_key",
            "AI generation is not configured. Set GEMINI_API_KEY on the server (see .env.example).",
            503,
          );
        case "timeout":
          return errorResponse("provider_timeout", "The AI provider took too long to respond. Try again.", 504);
        default:
          return errorResponse("provider_error", "The AI provider request failed. Try again later.", 502);
      }
    }
    if (error instanceof InvalidModelOutputError) {
      console.error("[generate-tests] invalid model output");
      return errorResponse(
        "invalid_model_output",
        "The AI returned output that failed validation. No tests were generated. Try again.",
        502,
      );
    }
    console.error("[generate-tests] unexpected error");
    return errorResponse("internal_error", "Unexpected server error.", 500);
  }
}
