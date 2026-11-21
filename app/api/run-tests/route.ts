import { NextResponse } from "next/server";
import { runRegressionCases } from "@/lib/regression/executor";
import { runTestsRequestSchema } from "@/lib/regression/schema";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = runTestsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid test cases.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }

  return NextResponse.json(runRegressionCases(parsed.data.cases));
}
