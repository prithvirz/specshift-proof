import { NextResponse } from "next/server";
import { InvalidModelOutputError, generateTestCases } from "@/lib/ai/generate";
import { ProviderFailure, createGeminiProvider } from "@/lib/ai/provider";
import { generateTestsRequestSchema } from "@/lib/ai/schema";

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: message, code }, { status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_json", "Request body must be valid JSON.", 400);
  }

  const parsed = generateTestsRequestSchema.safeParse(body);
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
