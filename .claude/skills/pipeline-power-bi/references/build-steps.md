# Build steps – pipeline-power-bi, step 8 and new source files

The full text of SKILL.md step 8 (the build) and of new versions of the source files. SKILL.md keeps the
rules that must hold in every run; this file holds the commands, flags and details. Read it before the build
and before a `--resume` that rebuilds or brings new files. Paths are relative to the repository root.

## Step 8 – Build

Power BI Desktop must be closed (`Check-Tools.ps1` again: `desktop.running` true → ask the user to save and
close it).

1. Copy the files to `data/` when `copy_files` is true.
2. **Expected values** – the one part that needs computing: from the source files (a short script over
   `data/`, applying the kept fixes, never from the model), rows per model table after the row-removing
   fixes (F03, F04, F12, F13, F15/F14 *remove*), every headline measure, distinct keys, min/max dates and
   a few splits. Write them to `choices.json` → `checks[]`, one per check: `{ "name": "Total sales",
   "dax": "[Total sales]", "expected": 4054.7, "assumes": "F09, F14 flag, F15 flag" }` (`dax` returns
   one number; a share as `[Paid share] * 100`). A reconciliation with the file's own total row, or other
   prose, goes into `expected_notes` (Markdown). `build-docs.js` (step 3) writes `expected-values.md` and
   `checks.dax` from them – do not write those two files by hand.
3. **The model is generated, not hand-written.** Write the build spec into `choices.json` → `build`
   ([build-spec.md](build-spec.md)): staging per source with its kept steps by fix
   id, the design's tables with their ops and final columns, date, relationships, measures, roles, and
   `"naming": "snake_case"` (always). Then rename it to snake_case and build:
   ```
   node .claude\skills\pipeline-power-bi\scripts\snake-names.js runs\<run-id> --apply
   node .claude\skills\pipeline-power-bi\scripts\build-model.js runs\<run-id>
   ```
   It refuses a spec with errors and writes nothing; fix the spec and run it again. Exit code 3 means the
   model folder is locked: run `connection_operations` → `Disconnect`, close the project in Desktop, run
   commands from the repository root (not from inside `<Name>.SemanticModel`), and run it again – the
   previous model is kept. The report itself
   comes from `powerbi-report-author scaffold <run>\pbip --name <Name> --model-path ../<Name>.SemanticModel`
   (first build only). A later change (`--resume`) changes the spec and runs `rebuild.js` (below). What the
   script builds, in two layers (source-model.md section 2c):
   - **Staging (not loaded):** one `expression` per included source in query group `01_Stage` (CSV:
     section 2; sheet or Excel table: section 2b), with its kept cleaning steps in catalog order (step
     names `#"Fxx …"`).
   - **Model tables (loaded):** the design's dimensions (`02_Dimensions`) and facts (`03_Facts`), built
     from the staging queries with merges, surrogate keys and junk dimensions (`#"M… …"` step names:
     `M10 Merge address into customer`, `M20 Add product key`). With "one table per sheet" in step 4b, each
     staging query is loaded as its own table instead.
   - `expressions.tmdl` (SourceFolder + only the functions used + the staging queries), date table
     (marked, auto date/time off), relationships, `_Measures`, RLS roles (`roles/<name>.tmdl`), model
     culture = report culture, report page.
4. **Hand-over files from the spec** – in the same command as `build-model.js`, once it succeeds:
   ```
   node .claude\skills\pipeline-power-bi\scripts\build-docs.js runs\<run-id>
   ```
   It writes `cleaning-log.md` (per source a row per profile finding – fix, column, rows, kept/not kept,
   variant and the step names the model really has; not kept findings stay in the log, so the user sees
   what was left as it is; then the model tables' own steps), `expected-values.md` and `checks.dax` (the
   `checks[]` from step 2, plus automatic checks with expected 0: fact rows without a dimension row per
   active relationship, and test rows left per kept F27). Read its `warnings` (a check without `dax` or a
   numeric `expected` is skipped) and run it again after every rebuild.
   It also keeps `checks-basis.json`: what each model table and measure looked like when `checks[]` were
   computed. After a `--resume` that changes a table a given check reads (a new row, another filter), the
   check is marked *(stale)* in both files and `stale[]` names it: recompute those expected values from the
   source files (step 2), update `checks[]`, and run `build-docs.js runs\<run-id> --checks-updated`. The
   grounded-answer questions (`questions.json`, step 9) are checked the same way: `staleQuestions[]` names a
   question whose measure or filtered table changed – recompute its `expected` too. Never hand over a run
   with stale checks or questions.

   **`rebuild.js` – the one command after the first scaffold and after every later change:**
   ```
   node .claude\skills\pipeline-power-bi\scripts\rebuild.js runs\<run-id> [--checks-updated] [--validate-report]
   ```
   It runs build-model, build-docs, build-context (step 10), model health (step 11), the grounded answers
   (step 9, once `questions.json` exists), the handover (`build_handover.py`, when governance was chosen) and
   the overview (step 7) in this order and stops at the first that fails (`failedAt`; exit code 3 = locked
   model folder, as above). Read its `warnings`, `stale`, `staleQuestions` and `next` – `next` lists what it
   does not do: the TMDL validation through powerbi-modeling-mcp, and rerunning the catalog and the
   governance wiki through their skills. On the first build, run steps 5–9 below as described; the separate
   commands in them are what `rebuild.js` runs.
5. Validate:
   - TMDL: when `powerbi-modeling-mcp` is available, `connection_operations` → `ConnectFolder` on
     `<Name>.SemanticModel/definition` (parses the model offline), then **`Disconnect`** – an open
     connection locks the folder, and the next `build-model.js` run (e.g. pbip-layout's measures) stops with
     exit code 3. Otherwise check tabs, quotes and unique `lineageTag`s by script.
   - Every column a query returns has a TMDL column with the same `sourceColumn`, and the other way
     round (compare the last step's names with the TMDL by script).
   - Report: `powerbi-report-author validate <Name>.Report` (or section 11 of tmdl-templates.md). It takes
     about 10 seconds, so run it once: when the dashboard is chosen, pbip-layout's step 8 validates the
     whole report after it adds its page – skip it here.
   - Fix and repeat until clean. Do not report a build as done with validation errors.
6. **The other skills – load them, do not imitate them.** Run each chosen one by loading it with the
   Skill tool (`pbip-layout`, `pbip-catalog`, `pbip-governance`) or, when the Skill tool cannot load it,
   by reading its `SKILL.md` by path (`.claude/skills/<name>/SKILL.md`) and following it step by step.
   Never call only their scripts – the skills hold the steps that make the output right. To save time,
   load all chosen skills in one turn (parallel Skill calls), then run the scripts that do not depend on
   each other in one command: the catalog's first run and governance's `parse_pbip.py` + wiki bundle
   (both after pbip-layout, which changes the report they read).
   - **pbip-layout**, *pipeline mode* (its SKILL.md section "Pipeline mode"): the pages the user chose in
     step 6 (`extras.layout_pages` – never chosen by the skill), the colour/title answers as a profile, the
     template fields mapped with its `layout.md`, `docs/layout-config.json`, and **`layout-mapping.md` in the
     run folder** (page → template field → model field → value → fallback → open points). The measures and
     parameters the pages need (its `measures.md`) go into `choices.json → build.measures[]` and
     `build.parameters[]`, then `rebuild.js` – so a later rebuild keeps them. Do this after the model validates.
   - **pbip-catalog**: `build_catalog.py <pbip> --missing-only` (its fast path: only the list of missing
     descriptions, in about a second), then AI descriptions for every missing field (its step 3, with keys
     described from the relationships) and **one** full run with `--ai-descriptions … --html`. Report: counts,
     description status, possible PII, and how much upstream lineage it could trace. With a staging layer
     the trace stops at merges – say how many fields reach the source.
   - **Descriptions in the model (always, right after the catalog's AI step)**: every measure, column and
     table must carry a `///` description, so Power BI shows it in Properties → Description.
     `python .claude\skills\pipeline-power-bi\scripts\descriptions.py runs\<run-id>\pbip --apply` writes the
     AI drafts from `pbip/docs/ai_descriptions.json` into the TMDL (only `///` lines; the user's run settings
     already approve it – no extra question) and writes `pbip/docs/descriptions.xlsx` (Name | Description |
     Type | Table | Hidden | Review). Exit 1 lists `missing` keys: draft each one in English (keys from the
     relationships, the rest from name, type, source and DAX), add them to `ai_descriptions.json` and run
     again until it exits 0. Then do the catalog's full run, so it reads the descriptions from the model.
     `build-model.js` reads the same file, so a rebuild keeps them, and `rebuild.js` rewrites the Excel list.
     - **Flag assumptions.** Describe only what the DAX, M and relationships show. When a description has to
       assume something the code cannot prove (what a status value means, which unit an amount is in, what
       counts as a return), still write it, and add the key to `pbip/docs/description_notes.json` →
       `"review": { "<key>": "<the assumption, in one line>" }`. It lands in the Review column (highlighted).
       Facts read from the code are never flagged. In the hand-over, give the number to review, e.g.
       "4 descriptions rest on an assumption – see the Review column".
     - **Self-check.** The script compares every file with the original minus `///` lines before it writes;
       on any other difference it writes nothing for that file and exits 2. Stop and report it – never work
       around it.
     - **Redo named fields** (when the user asks for better descriptions of specific fields): write the new
       text in `ai_descriptions.json`, then `descriptions.py <pbip> --apply --redo "fact_sales[amount],[total_sales]"`
       (keys as in the AI file; a measure also by its bare name). The keys are saved in
       `description_notes.json → redo`, so `build-model.js` lets the AI text win over the spec on a rebuild.
       Only these fields change; every other existing description is kept.
     Hand-over: link `pbip/docs/descriptions.xlsx` as the downloadable list of descriptions. Without the
     catalog (Python missing) the Excel list is skipped; say so.
   - **pbip-governance**: `parse_pbip.py <pbip> --output runs\<run-id>\governance\model.json` (it writes
     UTF-8 itself – no shell redirect), then `generate_azdo_wiki.py <json> --output governance/<Name>_azdo_wiki.zip`. The handover
     Markdown is **not** written by hand: `python .claude\skills\pipeline-power-bi\scripts\build_handover.py runs\<run-id>`
     writes `governance/handover.md` from the model and `choices.json` (model, source, PII audit, RLS,
     decisions = settled `design.review` points, open points = open ones + `handover_notes[]`, left out,
     documentation). Rerun it after every rebuild. Its PII audit must agree with the
     model: a **visible** column flagged as personal data (a person's name such as an account manager)
     goes back to the user as a question – hide it, keep it visible, or remove it – and on hide/remove the
     TMDL is changed and validated again. A flagged column the user says is not personal data (company
     names) goes into `choices.json` → `pii_not_personal[]` ("Customer[Customer name]"). `build-model.js`
     writes it to the model as `annotation PII = not personal` on that column, so the wiki, the catalog and
     the handover all show it as reviewed and nobody asks again – rebuild before rerunning them.
   - If a skill fails, finish the run without it, say what failed and how to rerun it alone.
7. **Overview page** (always):
   `node .claude\skills\pipeline-power-bi\scripts\build-overview.js runs\<run-id> [--colors <file.json>] [--vault "<vault>" --folder <folder>]`
   – sources → staging → model → report, the star schema, cleaning steps per source, relationships,
   measures, privacy/security and the control numbers in one `overview.html`. Default look is the
   toolkit palette: dark navy page with a faint grid, gold bars on the model tables (full gold border on
   facts), lavender keys and relationship lines, purple accent. To change it: `runs/<run-id>/overview-colors.json`
   or `--colors`, e.g. `{ "accent": "#0f7b6c", "fact": "#d97706", "dark": { "background": "#0b1416" } }`;
   `"theme": "light"` or `"auto"` (follow the system) instead of the default dark (keys: accent, accentText,
   fact, dimension, date, lines, warning, alert, background, card, nav, ink). The
   page's **Colours** button tries colours live and shows that JSON to save. With `--vault` also an
   Obsidian note (`<vault>/<folder>/Power BI/<run-id>.md`, only when the user chose it). When the user
   chose to publish it: load the `artifact-design` skill's rules and publish **`overview.page.html`** (the
   same page without document wrapper tags, written next to it) with the Artifact tool (icon `diagram`);
   republish the same file path on later runs so the link stays. Otherwise give the path of
   `overview.html`, which opens in any browser.
8. **`checks.dax`** (always) is written by `build-docs.js` (step 4): one `EVALUATE` with a row per check
   and a Difference column. Example of the result: [checks.example.dax](checks.example.dax).
9. **Grounded-answer test** (always): `checks.dax` proves the totals; this proves that real questions get
   the right number, under the asker's permissions, traceable to their definition.
   - Ask the user for 3–5 business questions (AskUserQuestion with drafted ones from the measures and
     dimensions, e.g. "Sales in <region> in <latest complete month>", plus "Other" for their own). With an
     RLS role, add one question as a user of that role (a user from the security sheet).
   - Compute each expected number **from the source files** (a short Python/PowerShell script over
     `data/`, applying the kept fixes the question depends on) – never from the model – and write how in
     `expected_how`.
   - Write `questions.json` (format in the script's header) and run
     `python .claude\skills\pipeline-power-bi\scripts\grounded_answers.py runs\<run-id>\pbip runs\<run-id>\questions.json`.
     It writes `grounded-answers.dax` (Value, Expected, Difference per question; role rows simulate the
     role in DAX) and `grounded-answers.md` (definition, measures used, source sheet/column of every
     column, the role rule). A column it cannot trace is a remark in the hand-over. Phrase the questions
     with the glossary terms, so they also test that the definitions hold.
10. **Model context for AI assistants** (always): `node .claude\skills\pipeline-power-bi\scripts\build-context.js runs\<run-id>`
    → `model-context.md`: tables with grain, relationships, measures with term and formula, the glossary,
    access rules and known limits. Give it to Copilot, Claude or an agent that answers questions on the
    report, so it uses the definitions instead of guessing. Its warnings (a term without a measure, a
    measure with an unknown term) go back to step 5.
11. **Model health** (always): `python .claude\skills\pipeline-power-bi\scripts\model_health.py runs\<run-id>\pbip --profile runs\<run-id>\profile.json --choices runs\<run-id>\choices.json`
    → `model-health.md`: unused fact columns, hidden unused columns, near-unique text, dates with times,
    text keys, bidirectional and many-to-many relationships, auto date/time – and four DAX rules for every
    measure: `TODAY()`/`NOW()` (anchor on the latest date in the data instead), `/` without `DIVIDE`, a
    `[Name]` that is neither a measure nor a column, and a number equal to an expected value of a check or
    question (a typed-in result). Offer the warnings as one multiSelect ("Remove the unused fact columns: …");
    a yes changes the build spec and rebuilds. A DAX warning is fixed in the measure's `expr`, never accepted.

## Add or change a measure (`--resume <run-id>` → "Change the model, a measure or extras")

For a measure asked for after the build – a new business question, a period comparison, a correction. The
same steps whatever the dataset:

1. **Pin down the definition with the user** (one AskUserQuestion, recommendation first) only where the
   formula cannot decide it: which date anchors "latest" (the latest date in the data – never `TODAY()`),
   whether a partial last month counts, which filters the number must ignore and which it must follow.
2. **Write it in the spec** (`choices.json → build.measures[]`) with names as the model has them (snake_case
   when `naming` is `snake_case`): `expr` reuses existing measures (`[total_sales]`, not a copy of its formula),
   `DIVIDE` for every ratio, every helper as a `VAR` inside the formula – nothing may depend on a definition
   that only exists in a query. Add `filters` (build-spec.md) – the contract the checks test. Period measures:
   the template in modeling-guide.md §5.
3. **Expected value from the source files** (a short script over `data/` with the kept fixes, as in part 2):
   add `{ "name": "<measure>", "dax": "[<measure>]", "expected": <n>, "assumes": "…" }` to `checks[]`. A
   number the user gives is a cross-check, never the formula's input.
4. **Test before saving:** `node .claude\skills\pipeline-power-bi\scripts\measure-test.js runs\<run-id> "<measure>" [--by "Table[Column]"]`
   → `measure-test.dax`: `DEFINE` with the measure and the spec measures it uses, `EVALUATE` A (its checks
   and filter contract, Difference per row) and B (the measure per member of a dimension). With Desktop open
   on the current model run it with `dax_query_operations`; otherwise give it to the user (DAX query view →
   Run). Every Difference must be 0 and B must look plausible before you go on – fix `expr` and run again.
5. **Save the pipeline way:** close Desktop, `rebuild.js runs\<run-id>` (not "Update model with changes" in
   Desktop – the next rebuild would overwrite it), validate, refresh.
6. **Prove the saved measure:** `checks.dax` now holds the same checks without `DEFINE` – they only pass when
   the saved measure works on its own. Model health must show no DAX warning for it. Then add a description
   (`descriptions.py --redo "<measure>"` when it replaced an existing one) and, if it goes on the report, a
   glossary term.

## New versions of the source files (`--resume <run-id>` → "New files")

Before the user refreshes with new files, check them against what the model was built for:
`node .claude\skills\pipeline-power-bi\scripts\check-drift.js runs\<run-id> [--path <new file or folder>]`
→ `drift.md`. Exit code 1 = the refresh will fail: a file, sheet, Excel table or selected column is gone,
or a CSV's delimiter, header row or encoding changed. For each break propose the change to the build spec
(a renamed column: the guess it prints; a new sheet name: `item`), rebuild, and validate. Warnings (a
column that changed kind, a new problem type) go to step 4 for that table. Then copy the files to `data/`
when `copy_files` is true, and save the new profile as `profile.json`.
