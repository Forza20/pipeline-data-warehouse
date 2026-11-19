# Scripts

What each script in `scripts/` does. Read when a step names a script you need the details of, or when
changing a script. Commands and flags per step are in [build-steps.md](build-steps.md).

- `Profile-Sources.ps1` – the read-only profiler for CSV and Excel (Windows PowerShell 5.1; Excel need not
  be installed). Step 2. `-RowsDir` also writes each table's rows to `rows/` (Excel cells with their type);
  `-WarmUp` only compiles and caches the C# parts (step 0, in the background).
- `source-stats.js` – expected values and evidence from the source files: replays the build spec's staging
  steps and model-table ops (or, with `--raw`, the profile tables as read) on the exported rows and answers
  queries (rows, count, distinct, sum, avg, min, max; M `where`, `join`, `by`); `--apply` writes the exact
  results into `checks[]` and `questions.json`. An `M` step or M it cannot evaluate marks the table `approx`.
- `draft-spec.js` – drafts `choices.json` → `build` from the profile: every recommended finding at its
  default variant as a staging step, one loaded table per source, the preferred relationships and a date
  table. Findings it cannot draft (F28 names, F07 spelling, F27 without a key column, F11 to plain numbers)
  are listed in `skipped` with the reason – ask them; model choices (F02, F21, F22, F26, F18, M01) in
  `model`. A starting point for step 8.3: reshape it to the step 4b design. `--write` saves it.
- `build-model.js` + [build-spec.md](build-spec.md) – the model generator and its spec (choices.json →
  `build`). Step 8.
- `pbip_sources.py` – the CSV/Excel files behind the user's own Power BI project (step 1), read-only;
  refuses a `.pbix` with how to save it as `.pbip`.
- `Check-Tools.ps1` – step 0's checks of Node, the report CLI, Desktop and Python in one call (JSON);
  installs nothing. `-DesktopOnly`: only whether Desktop is running (step 8.1).
- `build-docs.js` – `cleaning-log.md`, `expected-values.md` and `checks.dax` from the profile, the choices,
  `checks[]` and the generated model (step 8.4); marks checks made stale by a later design change
  (`checks-basis.json`, `--checks-updated`).
- `build_handover.py` – `governance/handover.md` from the model and the choices (step 8.6), with
  pbip-governance's PII heuristic and role parser.
- `build-overview.js` – the overview page (and optional Obsidian note) from the run folder.
- `build-dax-guide.js` – the run's own HTML guide to `checks.dax` and `grounded-answers.dax` (step 9,
  always handed over): run id, number of checks, key expected numbers and why, every grounded question;
  Danish or English (`--lang`, else `choices.json` → `dax_guide.lang`, else the report language);
  `--downloads [<dir>]` (tests only – the pipeline never passes it) copies the guide, `checks.dax` and
  `grounded-answers.dax` to another folder; by default all three stay in the run folder.
- `record-checks.js` – the result of `checks.dax` / `grounded-answers.dax` (JSON from powerbi-modeling-mcp
  `dax_query_operations`, or the table copied from DAX query view) into `expected-values.md` and
  `grounded-answers.md`: "In Power BI", Difference and one ✅/❌ result line; saves `check-results.json`
  with a model fingerprint and rebuilds the overview. `--apply-only` (rebuild.js) writes the saved result
  back, marked outdated when the model changed. Exit 0 = every Difference 0.
- `rebuild.js` – the run's scripts in order after a change (model → docs → context → health → grounded
  answers → DAX guide → handover → overview), stopping at the first failure; one JSON result. It parses
  the model once (`parse_pbip.py` to a temp file) and passes it as `--parsed` to model health, the
  grounded answers and the handover.
- `snake-names.js` – renames a build spec to snake_case (`dim_`/`fact_` tables, columns, measures) and
  rewrites every reference; `rebuild.js` runs it when `naming` is `snake_case`.
- `descriptions.py` – fills every missing `///` description from the catalog's AI drafts (`--apply`) and
  writes `pbip/docs/descriptions.xlsx` (with a Review column for descriptions that rest on an assumption);
  `--redo` replaces named fields' descriptions; refuses to write a file whose change is more than `///`
  lines (exit 2); exit 1 lists fields still missing. Skips the Excel write when the list is unchanged
  (`docs/.descriptions.xlsx.sha256`).
- `measure-test.js` – a DAX query view test of a new or changed measure before it is saved (`DEFINE` + its
  checks and filter contract + a per-member breakdown); `filter-checks.js` turns a measure's `filters`
  into checks for it and for `checks.dax`.
- `model_health.py` – model size and DAX rules (TODAY/NOW, `/` without DIVIDE, unknown references,
  typed-in results).
- `run-summary.js` – the compact summary of a run's choices for `--resume`, step 1.4 and step 7
  (Markdown, or `--json`).

## Tests

`tests/run-tests.js` checks the profiler, `source-stats.js`, the model generator, the hand-over files (build-docs, stale
checks and questions, build_handover), rebuild.js, run-summary.js, the drift check, model health, model
context, the grounded-answer test, the catalog's fast first run, own-project sources and the overview page
on the fixtures in `tests/fixtures` (`tests/make-fixtures.py` recreates them). `--quick` skips the drift
and Python checks, for use while working; a change is only done when the full run passes.
