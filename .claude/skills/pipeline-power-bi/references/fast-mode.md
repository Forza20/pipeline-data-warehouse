# Fast mode (`--fast`)

Read only when the run is in fast mode: `--fast` in the arguments, or the user picked "Accept all
recommended in every step" in step 1 (`"fast": true` in `choices.json`).

The user has made one choice for the whole run: every question takes its recommended option, and nothing
more is asked until the hand-over. Only these are still asked:

- the path of the files when none was given (the report name is not asked: `--name`, else the folder name);
- a run folder that already exists (step 1.4), and Power BI Desktop being open (step 8);
- installing a missing program (step 0) – never install without a yes;
- the analysis (step 2b, always – loaded with the Skill tool): one AskUserQuestion call – purpose, the top
  number, the main split – from the analysis-planning skill; the rest and the dashboard plan are drafted
  (`dashboard_plan.status: "drafted"`), the plan is shown as text, and the drafted points are asked at the
  hand-over;
- which dashboard the report gets – the Generic layout (the AdventureWorks template, key `adventureworks`) or the Business template (Marketing, Sales,
  Finance) – which of its pages (step 6, one AskUserQuestion call; the dashboard is always built);
- **the dashboard colours – always, never a default.** A question of its own in the same call, single-select:
  "Generic colors (Recommended)" (the template's own colours) · "Saved profile" (only when
  `pbip-layout/profiles/default.json` exists – name and colours in the description) · "My hex codes" ·
  "A screenshot of a website or brand". Hex codes: ask for them in a chat message right after and wait;
  map them with pbip-layout's `colors.md` ("From hex codes") and check the contrast. Screenshot: ask for
  the file path in chat and wait, run pbip-layout's `palette.ps1`, show the palette it found. Either way,
  show the mapped colours (key → hex) before the build. Colours change colours only (pbip-layout step 4).

## What each step does instead of asking

| Step | Fast mode |
|---|---|
| 0 | Run `Check-Tools.ps1 -Catalog` (Node, the report CLI, Desktop, and Python + openpyxl for the catalog and governance). Python missing and not installed: skip both and say so in the hand-over. |
| 1 | Copy the files into the run folder. |
| 2 | Include the recommended sheets; append F21 pairs. Show the overview table, no questions. |
| 3 | The first (recommended) language and number format; proposed names; clean snake_case column names. |
| 4 | Every `recommended: true` finding at its default variant. F28 without names keeps the codes. Skip reading fix-catalog.md – the profile's `recommended` and `variant` are enough. Draft the staging with `draft-spec.js runs\<run-id> --write` instead of by hand; its `skipped` list goes into the hand-over questions. |
| 4b | The proposed star schema. Review points are drafted and left **open** (they go into the hand-over). |
| 5 | Relationships with `preferred: true` and ≥ 95 % match, the date table, the default M01 variant, the dashboard plan's KPIs first and then the recommended measures, glossary drafted from the formulas. |
| 6 | Dashboard (pbip-layout), catalog (pbip-catalog) and governance (pbip-governance) always, with AI descriptions written without asking. The template, the pages and the colours are **always asked**, in one AskUserQuestion call (the template question and the page question(s) of pbip-layout step 3 – the dashboard plan's template and pages pre-ticked, checked against the model –, plus the colour question of `/messy-pipeline` section 2b: Standard · saved profile · hex codes · screenshot; `extras.layout: true`, `extras.layout_template`, the chosen keys in `extras.layout_pages`; Business: the contract mapping takes each recommendation, the open ones go into `layout-decisions.json`) – a report with only the empty default page is never handed over. The colours go into a pbip-layout profile (`runs/<run-id>/layout-profile.json`, `extras.layout_profile`); the title is the Standard one. No Desktop check or publishing, unless the user named them in the same message. The overview page and `checks.dax` are always made. |
| 7 | Show the review summary as a record of the choices, then build without asking. |
| 8.6 | Governance's PII audit asks nothing: a visible column flagged as personal data stays as it is and goes into the hand-over as an open point (hide it later with `--resume`). |
| 8.9 | Draft 3 grounded questions from the measures and dimensions yourself. |
| 8.11 | List the model-health warnings in the hand-over; do not rebuild. |
| 9 | Give `checks.dax` and `grounded-answers.dax` to run in Desktop. |

## Few tool calls

Write `choices.json` once after step 5 (not after every table); write the build spec and the check queries
in one turn and run `source-stats.js … --queries <file> --apply` once for every expected value (step 8.2;
the 4b evidence the same way with `--raw`), scaffold the report, then run `rebuild.js` once (it runs build-model, build-docs, build-context,
model health, the grounded answers, the DAX guide, the handover and the overview in order); the DAX guide
is written to the run folder in fast mode too (`build-dax-guide.js runs\<run-id>`, no `--downloads`, step 9 – never skipped); load `pbip-catalog` and
`pbip-governance` in one turn (parallel Skill calls) and run the catalog's `--missing-only` and
governance's `parse_pbip.py` + wiki bundle in one command. The hand-over says the run used fast mode and
how to change a choice: `/pipeline-power-bi --resume <run-id>`.
