# SpecShift Proof

SpecShift Proof detects behavioral regressions caused by software requirement changes. Phase 1 is a controlled, deterministic demo built around one booking-cancellation rule.

## The demo

| | Requirement |
|---|---|
| Old | Customers may cancel their booking if at least **24 hours** remain before the booking starts. |
| New | Customers may cancel their booking if at least **2 hours** remain before the booking starts. |

`lib/legacy/cancellation.ts` exports `canCancelBooking(hoursBeforeStart)`, which implements the **old** rule (`>= 24`). It is intentionally not updated. Three regression cases written for the new requirement run against it:

| Hours | Expected | Actual | Result |
|---|---|---|---|
| 1 | blocked | blocked | PASS |
| 3 | allowed | blocked | **FAIL** |
| 25 | allowed | allowed | PASS |

The dashboard shows 2 passed and 1 failed. The failure is the demo's intended output, not a bug. The Vitest suite still passes.

## Setup

```bash
npm install
npm run dev      # http://localhost:3000
```

Other scripts: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## API

`POST /api/run-tests` with `{ "cases": [{ "hoursBeforeStart": 3, "expectedAllowed": true }] }`.

Validated with Zod: 1 to 20 cases, `hoursBeforeStart` finite and between 0 and 10000, `expectedAllowed` boolean. Only structured data is accepted. No user-submitted code is executed. Invalid input returns HTTP 400.

## Structure

- `lib/legacy/` legacy business rule
- `lib/regression/` executor, Zod schema, types, seed data (no UI code)
- `app/api/run-tests/` API route
- `components/` UI components
- `tests/` Vitest unit tests

## Current limitations

- The requirement text areas are informational only. Editing them does not regenerate tests or change business logic.
- The test cases are fixed seed data. The UI does not edit them.
- Only the one hard-coded `canCancelBooking` function can be tested. Arbitrary repositories are not supported.
- No requirement interpretation, AI, authentication, or database.
