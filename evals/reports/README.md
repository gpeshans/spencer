# Report eval

How often is a report *right*? This eval asks the report pipeline 26 questions whose answers are known, and grades what comes back by code.

- **The household is made up.** Alice and Ben have 13 months of expenses up to today, and income that changes over time. A second household holds marker values that no report about the first may show. No real data is involved anywhere.
- **It runs the app's own pipeline** (`planRun`, then `executeRun`) with production's settings: Claude Opus 5.5 with the Sonnet fallback, the $0.50 per-run budget, the 270 s deadline, and household values shared with the model. It runs on a throwaway Postgres in Docker with every migration applied.
- **Periods are relative to today**, such as "last month" or "the six full months before this one". So the questions and values move with the calendar while the shape stays the same.
- **The runner stands in for the person.** When a run stops for approval, the runner approves it and records that. When a run asks a question, the runner answers from the case's script; with no script, the question is the outcome.

The cases and every expected value, as of the day they were generated, are in [CASES.md](CASES.md).

## Running it

It needs Docker and `ANTHROPIC_API_KEY` (read from `.env.local`). **Each run spends money.** The first baseline (2026-11-17) measured:
- about $1.03 and 2 minutes for a full pass at concurrency 3;
- an answered question cost $0.03–0.10, and a refused or clarified one about $0.01–0.03;
- the first few questions cost the most, because they write the prompt cache that the rest read.

```sh
npm run reports:eval -- --list                      # the cases and their expected values as of today, in CASES.md (free)
npm run reports:eval -- --fake-llm                  # the harness alone, no API calls: every question is refused, results go to a temp folder (free)
npm run reports:eval -- --cases total-last-month,refuse-delete,food-last-month   # a pilot
npm run reports:eval                                # every case, once, into results/baseline/
npm run reports:eval -- --variant v1 --reps 2       # a changed prompt or model, twice each, into results/v1/
npm run reports:eval:report                         # results/report.html, comparing every variant
```

Flags:

| Flag | Default | Effect |
|---|---|---|
| `--cases a,b` | all | Run only these cases. |
| `--reps N` | 1 | Run each case N times. |
| `--concurrency N` | 3 | Run this many cases at once. |
| `--variant` | `baseline` | `baseline` or `v1`, `v2`, …: the only names the report reads. |
| `--max-usd X` | 12 | No new case starts once X dollars are spent. Cases already running can still finish, each within its own $0.50 budget. |

For a variant, put one line saying what changed in `results/v1/change.md`; the report shows it.

A run resumes. Results are written as each case finishes, and a rerun only does the (case, rep) pairs that have no result yet, so an interrupted run loses nothing. To start a variant again, delete its folder.

## Reading the results

Each variant writes these files under `results/<variant>/`:

| File | What it holds |
|---|---|
| `summary.md` | The headline, the score per kind of question, and every attempt with what it missed. |
| `results.jsonl` | One line per (case, rep). It carries `grade` (`correct`, `outcome`, `isolated`), what was expected, what happened (`actual`, with each expected value checked), cost, tokens, time, LLM calls, SQL repairs, whether the fallback model answered, and whether the run asked for approval or a clarification. |
| `traces/<case>_rep<k>.json` | The full transcript of an attempt. It has each stage's instructions, input and answer, the SQL with its first rows, and the grade. Kept out of git. |
| `errors.jsonl` | Attempts the harness lost: a crash, or no result after 300 s. They aren't scored, and a rerun retries them. |

Three numbers are graded:

| Number | Meaning |
|---|---|
| **correct** (the headline) | The run ended the expected way **and** its results hold every expected value **and** nothing from the other household. |
| **outcome** | It ended the expected way: answered, asked a question, refused, or said there's no data. |
| **isolated** | No marker value from the other household appears anywhere in its results. This should always be 1. A 0 is a security bug, not a quality problem. |

A report's facts can come from any section, because the plan picks the sections. Each kind of fact is checked differently:

| Fact | Check |
|---|---|
| Number | It must be in some cell, to the cent. |
| Breakdown or trend | One section must have every expected row with its value, and no other row for the same key with a different value. Its remaining rows may only hold zeros. |
| Listing | The amounts must be in order (or, for "list all", the same rows in any order). Descriptions and dates must match where the case names them. |

Numbers that come back as text count too.

**The baseline** (`results/baseline/`, 2026-11-17) scored 25 of 26, with an interval of 81–99%. The one miss is `earned-minus-spent`, as expected: the run returned income and spending as two figures but not their difference. So the set is close to its ceiling. It guards against regressions well, but measuring an improvement needs harder cases.

**Noise.** 26 cases at one rep give a 95% interval of about ±20 points, which `summary.md` prints. So compare variants with `--reps 2` or more, and look at which cases flipped, not only at the headline. One case fails until M3 by design: `earned-minus-spent` needs a difference across two views, and derived values come in M3.

## What it doesn't cover

- the narrative and cross-checks (M3, not built yet);
- the formatted document, the charts and the PDF;
- the UI.

The grader reads the raw section results, the numbers a report is built from.

## Adding a case

1. Add it to [cases.ts](cases.ts) with its expected values worked out from the fixture's data. Use the helpers in [fixture.ts](fixture.ts) (`inMonth`, `spend`, `totalsBy`, `incomeIn`, `largest`), never SQL, so the expected values can't share a bug with the pipeline.
2. If the case needs new data, add it to `buildFixture`. `tests/db/eval-fixture.test.ts` checks the fixture against the reporting views.
3. Run `npm test`. The grader's tests run every case's expected values through an oracle, and check that empty or failed runs fail.
4. Run `npm run reports:eval -- --list` to refresh `CASES.md`.

`build-report-lite.mjs` is the Claude API skill's dependency-free report builder, copied unchanged.
