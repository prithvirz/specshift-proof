# SpecShift Proof

SpecShift Proof detects behavioral regressions caused by software requirement changes. It is a hackathon MVP built around one controlled scenario: a booking-cancellation rule.

- **Phase 1:** a deterministic executor runs regression cases against a real legacy function.
- **Phase 2A:** Gemini proposes regression cases from the old and new requirement text. The deterministic executor still decides every pass/fail.
- **Phase 2B:** a Regression Evidence Report records exactly what was tested and what failed, and can be copied as Markdown.
- **Scenario editor:** set a numeric proposed threshold and run deterministic boundary cases generated from it, with no AI involved.

## The scenario

| | Requirement |
|---|---|
| Old | Customers may cancel their booking if at least **24 hours** remain before the booking starts. |
| New | Customers may cancel their booking if at least **2 hours** remain before the booking starts. |

`lib/legacy/cancellation.ts` exports `canCancelBooking(hoursBeforeStart)`, which implements the **old** rule (`>= 24`). It is intentionally not updated. Tests written for the new requirement expose the mismatch.

Seeded demo cases:

| Hours | Expected | Actual | Result |
|---|---|---|---|
| 1 | blocked | blocked | PASS |
| 3 | allowed | blocked | **FAIL** |
| 25 | allowed | allowed | PASS |

The dashboard shows 2 passed and 1 failed. The failure is the intended demo output. The Vitest suite still passes.

## Setup

Requires Node.js and npm.

```bash
npm install
npm run dev      # http://localhost:3000
```

The seeded demo works without any configuration. AI generation needs a Gemini API key:

```bash
cp .env.example .env.local    # Windows PowerShell: Copy-Item .env.example .env.local
# then set GEMINI_API_KEY in .env.local and restart the dev server
```

Other scripts: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm start`.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | Only for AI generation | none | Gemini API key. Read on the server only. |
| `GEMINI_MODEL` | No | `gemini-3.5-flash-lite` | Gemini model used for test generation. |

`.env.local` is ignored by Git. Never commit a real key. Next.js reads `.env.local` at startup, so restart the server after changing it.

## Using the dashboard

1. **Seeded demo:** click **Run Regression Tests** to execute the three seeded cases.
2. **AI generation:** click **Generate Tests with AI**. Gemini reads both requirements and returns a change summary plus 5 to 8 proposed cases, each with a reason. Review them, then click **Run Generated Tests**.
3. **Scenario editor:** enter a proposed threshold *T* (whole hours, 0 to 168, default 2), review the generated boundary cases, then click **Run Scenario Tests**.
4. **Evidence report:** after any run, click **View Evidence Report** below the results.

### Scenario editor

The scenario editor tests a numeric rule, "cancellation allowed if `hoursBeforeStart >= T`", against the legacy function. It never reads the requirement text, and Gemini is not used. If the text says something different, the scenario still uses *T*.

A pure function (`lib/scenario/boundary.ts`) generates the boundary cases in the browser. The inputs are 0, *T* − 1, *T*, *T* + 1, the legacy boundary (23 and 24), and max(*T*, 24) + 24. Negative values are dropped and duplicates merged. Each expected outcome is `hoursBeforeStart >= T`. The cases are sent to the existing `/api/run-tests` endpoint, so actual outcomes still come only from `canCancelBooking`.

| *T* | Failed inputs | Direction |
|---|---|---|
| 2 | 2, 3, 23 | Legacy is stricter: it blocks cancellations the scenario allows |
| 24 | none | "No regression detected" |
| 48 | 24, 47 | Legacy is more permissive: it allows cancellations the scenario blocks |

### Evidence report

Each successful run creates an immutable snapshot containing:

- the old and new requirement text as it was when you clicked run;
- the test source (seeded demo, Gemini-generated, or scenario editor);
- the exact cases sent to the executor and the executor's results;
- total, passed, and failed counts, and the execution timestamp (recorded in the browser when results arrive);
- for Gemini runs, the change summary and per-case reasons, labeled as context, not evidence;
- for scenario runs, the proposed threshold and rule, shown separately from the written requirements.

The report lists every failed case with its input, expected behavior, actual behavior, and a deterministic explanation derived from the executed values and the legacy 24-hour threshold. Passing cases are in a collapsible section. **Copy Report** copies a Markdown version to the clipboard.

Failure explanations cover both directions: the legacy rule blocking a cancellation the test expects to be allowed, and allowing one the test expects to be blocked. When every scenario case passes, the results and report say **No regression detected** for that threshold.

If you edit the requirement text after a run, the results and report are labeled **Previous execution evidence**. The same applies when you regenerate or replace the AI cases after a Gemini run, or change the threshold after a scenario run. They are never relabeled to match the new draft. Run the tests again to produce new evidence. Before creating a snapshot, the app checks that each result matches its submitted case and that the counts add up. For scenario runs, it also checks that the cases are exactly the boundary cases for the recorded threshold.

## API

### `POST /api/run-tests`

```json
{ "cases": [{ "hoursBeforeStart": 3, "expectedAllowed": true }] }
```

1 to 20 cases. `hoursBeforeStart` must be finite and between 0 and 10000, and `expectedAllowed` must be a boolean. Only structured data is accepted, and no user-submitted code runs. Returns a summary plus per-case results. Invalid input returns 400.

### `POST /api/generate-tests`

```json
{ "oldRequirement": "...", "newRequirement": "..." }
```

Both strings must be nonempty, with at most 3000 characters. The response is `{ changeSummary, testCases: [{ hoursBeforeStart, expectedAllowed, reason }] }` with 5 to 8 cases and distinct hours, validated with Zod. Gemini output that fails validation is rejected (502). It is never repaired or replaced.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_json`, `invalid_input` | Bad request body |
| 502 | `invalid_model_output` | Gemini returned invalid output |
| 502 | `provider_error` | Gemini request failed |
| 503 | `missing_api_key` | `GEMINI_API_KEY` is not set |
| 504 | `provider_timeout` | Gemini timed out |

**Retries:** transient Gemini errors (HTTP 429, 500, 502, 503, 504, or an attempt timing out) are retried on the server. There are at most 2 retries, with exponential backoff (500 ms × 2ⁿ plus up to 250 ms of jitter). Each attempt is capped at 15 s, and the whole request has a 30 s deadline. Invalid input, a missing key, malformed output, and other errors are not retried. Raw provider errors and keys are never sent to the browser or written to logs.

## Structure

- `lib/legacy/`: the legacy business rule (unchanged by design)
- `lib/regression/`: executor, Zod schema, types, seed data
- `lib/ai/`: Gemini provider, retry logic, prompt, output schema
- `lib/scenario/`: threshold validation and deterministic boundary-case generation
- `lib/report/`: evidence snapshots, staleness detection, Markdown rendering
- `app/api/`: `run-tests` and `generate-tests` routes
- `components/`: UI components
- `tests/`: Vitest unit tests (Gemini is mocked, so no network calls)

## Current limitations

- Only the booking-cancellation scenario and the single hard-coded `canCancelBooking` function are supported. Arbitrary requirements or repositories cannot be executed.
- Gemini proposes inputs and expected outcomes only. It never generates or runs code and never decides pass/fail. Its expected outcomes can still be wrong, so review the cases before running them.
- Editing the requirement text never changes business logic. It only affects what Gemini is asked to analyze. The scenario editor ignores the text entirely.
- The scenario editor supports one rule shape (`hoursBeforeStart >= T`) with whole-hour thresholds from 0 to 168 and no fractional boundary cases. Its expected outcomes are only as correct as the threshold you choose.
- Evidence reports live in browser memory. Only the latest run is kept, and it disappears on reload. Export is Markdown via the clipboard only.
- The execution timestamp comes from the browser clock.
- No authentication, database, cloud storage, PDF export, or deployment.
