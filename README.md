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

The seeded demo and the scenario editor work without any configuration. AI generation is off by default. To turn it on locally:

```bash
cp .env.example .env.local    # Windows PowerShell: Copy-Item .env.example .env.local
# In .env.local set:
#   GEMINI_API_KEY=<your key>
#   AI_GENERATION_ENABLED=true
#   DEMO_ACCESS_CODE=<at least 16 characters>
# then restart the dev server and enter the same code in the dashboard.
```

Other scripts: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm start`.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | Only for AI generation | none | Gemini API key. Read on the server only. |
| `GEMINI_MODEL` | No | `gemini-3.5-flash-lite` | Gemini model used for test generation. |
| `AI_GENERATION_ENABLED` | No | off | AI generation runs only when this is exactly `true`. |
| `DEMO_ACCESS_CODE` | When AI is enabled | none | Shared code required in the `x-demo-access-code` header. At least 16 characters, in every environment. If AI is enabled and this is missing or too short, AI requests fail closed. |

`.env.local` is ignored by Git. Never commit a real key. Next.js reads `.env.local` at startup, so restart the server after changing it.

## Using the dashboard

The top of the page tells the story in three steps: the requirement changed from 24 hours to 2 hours, the legacy code still enforces `hours >= 24`, and SpecShift runs real tests to show the gap. Below that are the primary action, the editable requirement text, and two optional workflows.

1. **Run Demo Tests (primary):** runs the three fixed seeded cases. No API key or access code is needed.
2. **Generate tests with Gemini (optional section):** enter the demo access code, then click **Generate Tests with AI**. The code is kept in page memory only. It is not saved, put in the URL, or included in evidence reports. Gemini reads both requirements and returns a change summary plus 5 to 8 proposed cases, each with a reason. Review them, then click **Run Generated Tests**. The generated cases are bound to the exact requirement text sent to Gemini. If you edit either requirement afterward, **Run Generated Tests** is disabled until you regenerate. If a regeneration fails, the previous cases stay unchanged and the error says so.
3. **Scenario editor (optional section):** enter a proposed threshold *T* (whole hours, 0 to 168, default 2), review the generated boundary cases, then click **Run Scenario Tests**.
4. **Results:** after any run, the page scrolls to the results and moves keyboard focus to the results heading. A verdict banner sits above the counts:
   - **Regression detected** (red), with "N of M test cases failed", for seeded and scenario runs with failures;
   - **Mismatch detected**, for Gemini runs with failures, because Gemini-proposed expectations need review before a failure counts as a regression;
   - **All tests passed** (green), with "0 of M test cases failed". For a passing scenario run, the same banner also says no regression was detected for that threshold.

   The verdict is counted from the executed results, never from Gemini. While a new run is in progress, the previous results stay visible but dimmed. A run error appears next to the button that started the run.
5. **Evidence report:** click **View Evidence Report** below the results.

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

Failure explanations cover both directions: the legacy rule blocking a cancellation the test expects to be allowed, and allowing one the test expects to be blocked. When every scenario case passes, the verdict banner and report say **No regression detected** for that threshold.

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
| 401 | `access_code_required`, `access_code_invalid` | Missing or wrong demo access code |
| 413 | `payload_too_large` | Request body over 64 KB |
| 503 | `ai_disabled` | `AI_GENERATION_ENABLED` is not `true` |
| 503 | `ai_misconfigured` | AI is enabled but `DEMO_ACCESS_CODE` is missing or shorter than 16 characters |
| 503 | `missing_api_key` | `GEMINI_API_KEY` is not set |
| 504 | `provider_timeout` | Gemini timed out |

**Retries:** transient Gemini errors (HTTP 429, 500, 502, 503, 504, or an attempt timing out) are retried on the server. There are at most 2 retries, with exponential backoff (500 ms × 2ⁿ plus up to 250 ms of jitter). Each attempt is capped at 15 s, and the whole request has a 30 s deadline. Invalid input, a missing key, malformed output, and other errors are not retried. Raw provider errors and keys are never sent to the browser or written to logs.

**Access control:** before the body is read or Gemini is called, the route checks that AI is enabled and that the `x-demo-access-code` header matches `DEMO_ACCESS_CODE`. The comparison uses SHA-256 digests and a constant-time check. The configured and submitted codes are never returned or logged. Bodies over 64 KB are rejected while they are read, whether or not `Content-Length` is set. A 429 may come from the hosting firewall without a JSON body. The dashboard shows a clear message for that, and for network failures.

`/api/run-tests` needs no code, so the seeded demo and scenario editor always work.

## Deploying a public demo

The access code limits who can use Gemini. It does not stop distributed abuse by someone who has the code, and the app has no rate limiter of its own. An in-memory limiter would not work on serverless hosts, because each instance keeps separate counters. Use these layers together:

1. **Use a fresh, dedicated Gemini key.** Create it in its own Google project, and never reuse a key that has been shared. Stay on the free tier, or if billing is enabled, set a project spend cap in AI Studio. Caps can lag by about 10 minutes.
2. **Set environment variables on the host, for Production only:** `GEMINI_API_KEY` (marked sensitive), `AI_GENERATION_ENABLED=true` only while AI should be available, and a random `DEMO_ACCESS_CODE` of at least 16 characters. Preview deployments then have AI disabled.
3. **Add a platform rate limit.** For example, on Vercel add a WAF rate-limit rule for `POST /api/generate-tests`, keyed by IP. Do not rely on client-supplied IP headers in app code.
4. **Check the function duration limit.** A generation request can take up to about 30 seconds with retries.
5. **Verify after deploying:** AI returns 401 without the code and works with it, and the seeded demo and scenario editor work in a private window.
6. **Afterwards:** unset `AI_GENERATION_ENABLED` and revoke the key. Rotate the access code if it leaks.

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
- Gemini proposes inputs and expected outcomes only. It never generates or runs code. Actual outcomes always come from the legacy function, and pass/fail is a deterministic comparison with the expected outcome. Gemini's expected outcomes can be wrong, so a failure in a Gemini run may mean the expectation was wrong. Results and reports label each run's expectation source: fixed demo cases, proposed by Gemini, or derived from the scenario threshold.
- The seeded cases are fixed. They do not update when the requirement text is edited, and the dashboard warns when the text differs from the seeded defaults.
- Editing the requirement text never changes business logic. It only affects what Gemini is asked to analyze. The scenario editor ignores the text entirely.
- The scenario editor supports one rule shape (`hoursBeforeStart >= T`) with whole-hour thresholds from 0 to 168 and no fractional boundary cases. Its expected outcomes are only as correct as the threshold you choose.
- Evidence reports live in browser memory. Only the latest run is kept, and it disappears on reload. Export is Markdown via the clipboard only.
- The execution timestamp comes from the browser clock.
- No user accounts, database, cloud storage, or PDF export. AI access uses one shared code, not per-user authentication, and the app has no rate limiter of its own.
