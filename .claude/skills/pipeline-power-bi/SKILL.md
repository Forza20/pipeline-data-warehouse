---
name: pipeline-power-bi
description: Turn CSV files and Excel workbooks (.xlsx/.xlsm) the user attaches into a cleaned Power BI project (PBIP with TMDL). Also takes the user's own Power BI project (.pbip, or a .pbix saved as .pbip) and cleans the CSV/Excel files it reads, or adds dashboard, catalog and governance to it; without own data it offers the demo files or a new messy dataset. Profiles every file and sheet, proposes the cleaning steps per table (title lines, total rows, spaces, "N/A" text, case variants, mixed date/number/boolean/id formats, duplicates, anomalies, wide month columns, orphan keys, data types, clean snake_case names) and lets the user switch each one on or off before it writes the Power Query steps, relationships, date table and measures. Optional dashboard layout and data catalog. No database, no Supabase, no GitHub. Use it when the user wants a Power BI report from CSV or Excel files, asks to clean CSV or Excel data for Power BI, wants Power Query steps written for them, or types /pipeline-power-bi.
disable-model-invocation: true
---

# pipeline-power-bi – from CSV and Excel files to a cleaned Power BI project

The user attaches CSV files and/or Excel workbooks. A CSV file is one table; in a workbook every sheet
(tab) is one table – or, when a sheet holds a formatted Excel table, that Excel table is. This skill
measures what is wrong in each of them, **proposes** a fix for every
problem, and writes only the fixes the user keeps as named Power Query steps in a PBIP project. The
user never edits Power Query by hand, and every proposal is a choice they can switch on or off – now,
at the review before the build, and on any later run.

**Always English** – every question, option, description, preview, status line and file, even when the
user writes in Danish (principle 7). Plain words: say "table" and "cleaning step", not "partition" or
"M expression".

Arguments: file paths or a folder – CSV, Excel, a `.pbip` project or a `.pbix` (optional – otherwise ask),
`demo` for the demo files, `--name <report name>`, `--resume <run-id>`, `--fast` (see Fast mode).

## Principles

1. **The user decides, every time.** Nothing is cleaned, renamed, removed or modelled without the user's
   choice. Every question has the recommended option first, marked "(Recommended)", with what it does,
   how many rows it touches and whether it changes the numbers. "Accept all recommended" is one click
   for those who want speed; "choose one by one" and "skip" are always offered next to it. In fast mode
   the user decides once, for the whole run. **No open point without a recommendation:** whatever comes up
   later (a review point left open, a row left out, a PII flag, a pbip-layout decision in
   `layout-decisions.json`) is a question with your recommendation and its alternatives – asked when it
   comes up, or, when the run must go on (fast mode, a subagent), applied as recommended and asked at the
   hand-over (step 10), where the user keeps it or picks another option.
2. **Choices are kept** in `runs/<run-id>/choices.json`. Before the build the user sees all of them and
   can change any; `--resume <run-id>` reopens them later. Never ask again what is already answered,
   unless the user asks to change it.
3. **Nothing leaves the machine.** No upload, no database, no GitHub. Do not print whole files or long
   value lists in chat – counts and at most 3 examples.
4. **The source files are never changed.** All cleaning happens in Power Query, so a refresh with a new
   export of the same files repeats every step.
5. Only facts from the profile. A problem the profile did not measure is not proposed.
6. **Model like a data modeller, not a copier.** One sheet is not one table. The goal is a star schema:
   one fact per business process at its lowest grain, flat dimensions, no test rows, no lookup chains,
   one marked date table. [references/modeling-guide.md](references/modeling-guide.md) holds the rules;
   step 4b turns them into proposals the user accepts or declines.
7. **English only, and never "AdventureWorks".** All text the user sees (AskUserQuestion questions,
   labels, descriptions, previews, chat text, the analysis summary, the dashboard plan) and every file is
   in English, whatever language the user writes in. The AdventureWorks template is always "Generic
   layout" (its colours "Generic colors") in that text – the word "AdventureWorks" appears only in keys
   and file names (`adventureworks`), never in what the user reads.

## Fast mode (`--fast`)

With `--fast` in the arguments, or when the user picks "Accept all recommended in every step" in step 1:
read [references/fast-mode.md](references/fast-mode.md) – what is still asked, and what each step does
instead of asking. Fast mode never decides the dashboard colours: template colours, hex codes or a
screenshot are always the user's choice.

## Asking

Ask with AskUserQuestion: at most 4 questions per call, 2–4 options per question (the tool adds "Other"),
each question understandable on its own (name the table and column in it). Use `multiSelect` where
several options can be kept; single-select for variants that exclude each other. **Anything the user has to
type (code names, a threshold, a person's name) is asked as a plain chat message, never as an option** – an
option such as "I'll type them" comes back with no text, because typing is only possible under "Other".

## Files

Every run lives in `runs/<yyyy-MM-dd>_pbi_<name>/` (git-ignored); every answer goes into its
`choices.json`, the single source for the build. The folder layout and the `choices.json` shape are in
[references/run-files.md](references/run-files.md) – read it before step 1 writes the first file.

## Step 0 – Check the tools (show a short status line after the check)

Windows 10/11 with Windows PowerShell 5.1 (Power BI Desktop needs Windows). Check without installing, in
one call (about 3–5 seconds; add `-Catalog` when the catalog may be chosen – it also checks Python + openpyxl):
```
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\pipeline-power-bi\scripts\Check-Tools.ps1 [-Catalog]
```
In the same turn, start the profiler's warm-up **in the background** (`run_in_background`) – it compiles and
caches the profiler's C# parts once (about 5 seconds on a new PC), so step 2 does not wait for it:
```
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\pipeline-power-bi\scripts\Profile-Sources.ps1 -WarmUp
```
It prints JSON: `node`, `reportCli`, `desktop` (installed, running, `unsavedTitle`), `python`,
`freeMemoryGB`, and `missing[]` with the install command of each missing program:

| Program | Needed for |
|---|---|
| Node.js 18+ | report validation |
| Power BI report CLI | validating the report |
| Power BI Desktop | loading the data, the first refresh, screenshots |
| Python 3.12 + openpyxl | only for the data catalog (extra) |

Use the commands the project allows without a prompt (`.claude/settings.json`): run Python scripts as
`python -X utf8 .claude\skills\…` or `python .claude\skills\…`, create folders and copy files with
`New-Item -ItemType Directory -Force runs\…` / `Copy-Item <file> runs\…`, and write files only inside
`runs/`. Also check the skills `powerbi-authoring:powerbi-report-cli` and `powerbi-authoring:semantic-model-authoring`
are listed (else: `/plugin marketplace add microsoft/skills-for-fabric`, `/plugin install powerbi-authoring@fabric-collection`, restart).
Missing programs: one AskUserQuestion (multiSelect) "Which of these should I install now?", install only
the chosen ones, one command per call, then check the version. Without Node or the CLI the build still
works, but validation falls back to the JSON check in tmdl-templates.md section 11 – say so. Without
Power BI Desktop the project is written but not loaded; the user opens it on another PC.

## Step 1 – The files

1. **Which data.** With paths (or `demo`) in the arguments, use them. Otherwise ask (AskUserQuestion,
   single-select): "My own files – CSV, Excel or a Power BI project (Recommended)" · "The demo files (two
   small CSV files, about 5 minutes with `--fast`)" · "A new messy dataset (retail, hotel or SaaS with a
   known answer key)". In fast mode ask this too when no path was given – it is the one thing only the user
   knows.
   - **Own files:** ask in chat for the **path** of the file(s) or the folder – not an upload: the chat
     accepts only images and text as attachments and rejects `.xlsx`, `.pbix` (and often `.csv`). Tell the
     user how: "In File Explorer, hold Shift, right-click the file and choose *Copy as path*, then paste it
     here (a folder works too)." Strip surrounding quotes from pasted paths. Accept `.csv`, `.txt` (with
     delimiters), `.xlsx` and `.xlsm` – CSV and Excel can be mixed – and a Power BI project (below).
     `.xls` (Excel 97–2003): ask the user to save it as `.xlsx` in Excel (File → Save As) – the profiler
     cannot read it. A file open in Excel can still be read; Excel's lock files (`~$…`) are skipped.
   - **A path inside `runs/<run-id>/`** (its `data/` or `source/` folder, a file in it, or its `pbip/`)
     belongs to an earlier run. Do not start a new one silently: show `node .claude\skills\pipeline-power-bi\scripts\run-summary.js runs\<run-id>`
     and ask "Continue that run (Recommended)" – the same as `--resume <run-id>` · "Start a new run from
     these files" · "Stop".
   - **Demo:** the `demo/` folder of this repository (two CSV files; `demo/README.md` has the expected totals).
   - **Messy dataset:** load the `messy-dataset` skill and generate with `-Rows 2000` (about 10 seconds)
     into `runs/<run-id>/source/`, with `-AnswersDir runs/<run-id>_answers/` – outside the run folder. Do
     **not** read the answer folder or the skill's error catalog until the user asks to score the run after
     step 9; then compare `expected_findings.json` with the cleaning log and `expected_values.json` with
     `expected-values.md`.
   - **A Power BI project** (`.pbip`, its folder, or a `.pbix`): run
     `python .claude\skills\pipeline-power-bi\scripts\pbip_sources.py "<path>"`. It is read-only and lists
     the CSV/Excel files the model reads (`files[]` with `exists` and the model tables built from each) and
     other sources (`other[]`: SQL Server, SharePoint …). Exit code 2 = nothing to profile: say its
     `message` – a `.pbix` must first be saved as a project in Power BI Desktop (File → Save as → *.pbip),
     a database model needs CSV/Excel exports, and moved files need their new folder. With files found,
     ask (single-select; in fast mode take the first):
     "Clean its source files and build a new, cleaned project (Recommended)" – the files go into step 1.2
     and the run continues as usual; the user's own project is never changed · "Keep my model, only add
     dashboard, catalog, governance and model health" – copy the project folder into `runs/<run-id>/pbip/`
     (the original stays untouched), skip steps 2–5 (but **not** 2b – the analysis planning runs on the
     copied model), 7 and 8.1–8.4, and run step 6, step 8.5 (validate), 8.6 and 8.11 on the copy; there is no build spec, so no overview page, `checks.dax` or model context.
     A model with both files and database sources: profile the files and name the other tables in the
     hand-over as not cleaned.
2. Show per file: name, size, and ask the report name if `--name` is missing (proposal: the folder or
   main file name, readable). Excel's sheets are listed after the profile (step 2).
3. Ask: "Copy the files into the run folder (Recommended)" – the project keeps working if the originals
   move · "Read them where they are" – a refresh picks up new exports in that folder. Save as
   `copy_files`; the folder becomes the `SourceFolder` parameter. In the same AskUserQuestion call (without
   `--fast`), ask the pace: "Go through each step (Recommended)" · "Accept all recommended in every step
   (fastest – see Fast mode)". Save it as `"fast": true|false` in `choices.json`; a `--resume` keeps it.
4. Run-id `<yyyy-MM-dd>_pbi_<name-in-lowercase-with-dashes>`. Exists already: show its `run-summary.js`
   output and ask "Continue that run" · "Start again (the old folder is kept as …_old)" · "Stop".
   **`--resume <run-id>`** (or "Continue") always starts with `run-summary.js` – settings, design, cleaning per
   source, model, extras, open and settled review points, status – shown as it prints, then step 7's question.
   A run without `analysis.dashboard_plan` (made before 2b had it) runs step 2b first.

## Step 2 – Profile

```
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\pipeline-power-bi\scripts\Profile-Sources.ps1 -Path "<folder or file1,file2>" -OutFile runs\<run-id>\profile.json -RowsDir runs\<run-id>\rows
```
Read-only for the source files; prints one line per table. `-RowsDir` keeps each table's rows as the profile
read them (`rows/`), so `source-stats.js` computes evidence and expected values later without parsing the
files again. Then read `profile.json` (per table: `kind` = `csv` / `sheet` /
`excel table`, `file`, `sheet`, `excelTable`, `range`, `hidden`, `isEmpty`, `encoding`, `delimiter`,
`headerRow`, `headerCells`, `dataRows`, `columns[]` with `kind`/`readable`/`min`/`max`/`sum`,
`findings[]` with `fix`, `column`, `rows`, `detail`, `recommended`, `variant`; plus `relations[]`, where
`matchedBy` = `name` or `values`). Read it with `Get-Content -Raw -Encoding UTF8 | ConvertFrom-Json`,
one table at a time – never paste it whole.

Show the user one overview table: file (and sheet / Excel table) → rows · columns · problems found (not
counting F17 – F17 is a fix ID: each F-code (F01–F29) is one kind of data problem with its own cleaning
step, and the Power Query step carries the same name; the full list is in references/fix-catalog.md. Say
this to the user the first time you show an F-code) · proposed role (fact = the table other tables do not point at, with dates and amounts;
dimension = a table others point at; other).

**Step 2b – Plan the analysis (always, on every path).** Right after the overview, load the
**analysis-planning** skill (Skill call – never imitate it) and follow it: 5–7 questions, one at a time,
about purpose, audience, business questions, KPIs, split and time, each with 3 options from the profile plus
free text (fast mode: one call), then the **dashboard plan** the user approves – template pages, which KPI
in which template visual, and each KPI's definition and DAX draft. It writes `choices.json` → `analysis`
(with `dashboard_plan`). It runs in fast mode (short version), on the "Keep my model" path (from the
model's tables) and on a `--resume` whose `choices.json` has no `analysis.dashboard_plan`; no step after
2b starts before it is written. Name it to the user when it starts ("Analysis planning – the
analysis-planning skill"). From here on, `analysis` decides which options are recommended – its table in
analysis-planning's SKILL.md says how per step.

**Workbooks – which sheets?** When a workbook has more than one sheet or Excel table, ask first (one
AskUserQuestion, multiSelect, max 4 options per question – more questions if needed): "Which sheets in
<file> should become tables in the report?" One option per sheet/Excel table, label = its name, description
= rows · columns · "Excel table on sheet X" · "hidden sheet" · "empty". Sheets with data are pre-recommended
("(Recommended)" in the label); hidden, empty and one-column note sheets are not, and neither is a sheet
with an **F22** finding (an exact copy – name the original in its description). A sheet whose data is
also inside an Excel table on the same sheet appears only once (the Excel table). Write `include` per
table in `choices.json`; unticked tables are skipped in every later step.

**Tables that belong together (F21)** – right after, one single-select per pair: "<A> and <B> have the
same columns (<only-in lists>). Append them into one table?" · "Append into one table '<proposal>'
(Recommended)" · "Keep them as two tables". With append, step 4 cleans the combined table once.

**A first design sketch before the cleaning.** Mark in the overview which sources the star schema will
most likely leave out (copies, a list of ids that another table already holds, a currency table when all
amounts are in one currency) or use only to look up a few columns (address, city, region, subcategory,
detail tables). Step 4 then asks about fewer tables: a left-out source is not cleaned, and a lookup-only
source is asked only about the steps that touch the columns the design takes from it (keys, names, test
rows). Step 4b confirms or changes the sketch.

One line after it: "Next I go through the tables (sheets) one by one; you decide every step."

## Step 3 – Report settings (one AskUserQuestion call)

1. *Report language and number format:* "English, en-US, USD (Recommended)" · "Danish, da-DK, DKK" ·
   "English, en-GB, GBP" · Other. The **source** format of each file is measured by the profile; this is
   only how the report shows numbers and dates.
2. *Table names and roles* (multiSelect is wrong here – single-select): "Use the proposed names (Recommended)"
   with the list in the description – the model names are snake_case with `dim_`/`fact_` (`orders.csv` →
   `fact_sales` (fact), `CUST_MASTER` → `dim_customer` …) · "Keep the file names (as snake_case)" ·
   "I'll type the names" (then ask in chat; they are converted to snake_case).
3. *Column names (F02) for all tables:* "Clean snake_case names – `OrderDate` becomes `order_date`, `Cust ID`
   becomes `customer_id` (Recommended)" · "Keep the names from the files (only converted to snake_case)".
   This sets F02 for every table; it can still be changed per table. Every name in the model ends up in
   snake_case either way (`snake-names.js`).

## Step 4 – Cleaning, table by table ("faneblad for faneblad")

Every included table: each CSV file and each chosen sheet or Excel table. Name the sheet in the
question ("Sheet Salg in salg.xlsx"). Facts first, then dimensions, then the rest. For each table,
**one** AskUserQuestion call:

- Question 1 (single-select): "<table> (<file>, <rows> rows) has <n> proposed cleaning steps. How do you
  want to go through them?" · "Accept the <k> recommended steps (Recommended)" with the step list in the
  description and in `preview` · "Choose step by step" · "No cleaning for this table (only data types)" ·
  "Accept the recommended steps for this and all remaining tables (<n> tables)" – only when more than one
  table is left.
- With "accept": keep every finding with `recommended: true` at its default variant, drop the others,
  and write them to `choices.json`. Show one line: "<table>: <k> steps kept, <m> not kept (<names>)."
- With "all remaining tables": the same for every table not yet asked, without more questions in step 4 –
  one line per table as above. Only F28 code names are still asked (in chat), since only the user knows them.
- **Read [references/fix-catalog.md](references/fix-catalog.md) only now**, when the user first picks "step
  by step" (once per run) – "accept", "all remaining" and "no cleaning" need only the profile's
  `recommended` and `variant`.
- With "step by step": the next calls group the findings into questions of at most 4 options, in the
  catalog's order:
  - *Structure* (F01, F20, F03, F04, F19, F25), *Text* (F05, F06, F07, F23), *Formats* (F11, F08,
    F09, F10), *Rows* (F27, F12, F13, F15, F14, F24), *Shape and keys* (F16, F18), *Codes* (F28),
    *Privacy* (F26), *Types and names* (F17, F02). F29 and M02 are not asked here – they are model
    choices (step 4b).
  - **F27 (test rows) and F13 (repeated entities): show the rows themselves** (the profile's examples –
    the first fields of each row), so the user sees *which* rows go. A copy from a migration often has an
    odd `source_id` or a code outside the normal range; say so when the examples show it, and offer to
    remove exactly those rows instead of "keep first".
  - **F28 (codes):** ask for the names in a chat message after the AskUserQuestion call, not as an option
    in it ("Write the names as 10 = Web, 20 = Store …, or 'keep' to keep the codes"), and wait for the
    reply; with no names keep the codes and record the point as open in `design.review`.
  - multiSelect, one option per finding: label = fix in plain words + column ("Parse 4 date formats in
    order_date"); description = the profile's `detail`, rows affected, "changes the totals" when the
    catalog says so, and "(Recommended)" when recommended. Tell the user once: "Tick the steps you
    want; unticked steps are not applied."
  - A kept finding with variants (F08, F13, F14, F15, F18, F20, M01, F07) gets one follow-up
    single-select with the variants from the catalog, default first. Ask only when the default is not
    obviously right (F08 without day/month evidence, F14 spike limit, F18) – otherwise use the default
    and name it in the confirmation line.
  - F17 (data types) is always listed and recommended; if the user drops it, say that sums and date
    filters will not work on text columns.
- With "no cleaning": keep only F17 and – if chosen in step 3 – F02.
- F11 and F18 concern two tables: when the user keeps F11 on one table, propose the same target format
  for the key in the other tables in their turn (pre-recommended). F18 is asked on the fact table but
  built in the dimension.
- After each table, write `choices.json`. If the user changes their mind about an earlier table, update
  it there – do not start over.

## Step 4b – Design the model (star schema)

Read [references/modeling-guide.md](references/modeling-guide.md) first. Cleaning made each table
correct; now decide which tables the report gets. Work from the profile: `relations[]`, column kinds,
dates and amounts per table, and the findings F21, F22, F29, M02, F28.

1. **Draft the design** (in your head, then as a `preview`): the business processes, one fact per process
   with its grain, the dimensions, and for every source table where it ends up – *fact*, *dimension*,
   *merged into <dimension>*, *staging only*, *left out (why)*. Use the guide's detection rules:
   header + lines → one line-level fact; a key with dates in 3+ tables → process fact; lookup chains →
   flatten; one-to-one tables and primary-flag details (F29) → merge; repeated attributes (M02) → new
   dimension; status/priority/channel/codes (F28) → junk dimension; two columns pointing at the same
   dimension (ship-to/bill-to city, several dates) → role-playing with inactive relationships; name joins
   → surrogate keys; a user-to-region sheet → security role.
2. **Ask** (AskUserQuestion, a single-select first): "Use the proposed star schema (<n> facts, <m>
   dimensions) (Recommended)" with the design in `preview` (one line per model table: name · grain ·
   built from) · "Choose design decision by design decision" · "Keep one table per sheet (no reshaping)".
   With "decision by decision": one multiSelect per group (max 4 options each) – *facts* (line-level
   fact, process fact, split repeated attributes), *dimensions* (each flattening/merge), *small flags*
   (junk dimension, code names), *roles and security* (role-playing, RLS role). Each option says what it
   changes for the user ("orders per category can be counted directly", "one customer table instead of
   five").
3. Write the design to `choices.json` → `design`: `facts[]` (name, grain, sources, keys), `dimensions[]`
   (name, sources, merged lookups, surrogate key yes/no), `staging_only[]`, `left_out[]` with reasons,
   `roles[]`. Cleaning choices from step 4 stay attached to the source tables; the build applies them in
   the staging queries before the merges.
4. Run the guide's checklist (§9) on the design and tell the user any point that is not met, with the
   reason (e.g. "City stays its own table because targets are set per city").
5. **Human review** ([references/model-review.md](references/model-review.md)): grain, join paths, metric
   formulas, history, access and names are business meaning, not something the profile can decide. First
   **measure the evidence** for every drafted point (the guide's evidence column: one number per point) in
   **one** call: `node .claude\skills\pipeline-power-bi\scripts\source-stats.js runs\<run-id> --raw --queries runs\<run-id>\evidence-queries.json`
   (profile table names, M conditions in `where`, `join` for paths, `by` for splits – its header has the
   format). Write a script by hand only for what it names as unsupported.
   Then show the drafted answer with its number and let the user confirm, change or leave it open; write
   the result to `choices.json` → `design.review` with `evidence` `{value, how}`. In fast mode the evidence
   is measured too – the open points then reach the hand-over with their size. Open points go into the
   overview page and the hand-over.

## Step 5 – The model (one or two AskUserQuestion calls, glossary included)

Relationships, date and measures now follow the design from step 4b: facts relate to dimensions on the
surrogate or natural keys the design names; the profile's `relations[]` between tables that were merged
away are dropped.

1. *Relationships* (multiSelect): one option per `relations[]` entry with `preferred: true` (max 4 per
   question), label "Sales → Customer on customer_id", description: many-to-one, matched ids, orphans
   (and whether F11/F18 fix them). `matchedBy: text` = the tables share a name column (CustomerName)
   instead of an id – say so; it works, but a renamed customer breaks the link. `needsUniqueTarget` =
   the target has repeated names; the relationship needs its F13 step kept. Relations of an appended
   source (F21) become one relationship from the combined table; relations of a left-out copy (F22) are
   dropped. Recommended when ≥ 95 % of the ids match after the chosen fixes.
   One-to-one relations between two dimensions: describe them and recommend **not** relating them
   (merge or keep apart) unless the user asks.
2. *Date table:* "Yes – a calendar table linked to <fact>[<date>] (Recommended)" · "No". With more date
   columns in the fact, the others are inactive relationships (tmdl-templates.md section 7).
3. *Incomplete last month* (only with an M01 finding): the three variants from the catalog.
4. *Measures* (multiSelect, up to 4 per question, recommended ones first): **first the KPIs of
   `analysis.dashboard_plan`** (with their period comparisons), their DAX draft fixed to the model's table
   and column names, each option saying which dashboard visual it fills; a KPI the user unticks is a
   visual the dashboard loses – say which, and update `dashboard_plan`. Then proposals from the columns –
   sum of each amount column ("Total amount"; with F14 *flag*: only rows with `amount issue = "ok"`, say
   so), row count of the fact ("Orders"), distinct count of each dimension key ("Customers"), average per
   row ("Average order value"), share of a flag ("Paid share"), latest complete month and previous month
   for the main amount when there is a date table, and – with at least 2 × 3 complete months of data – the
   last 3 complete months vs the 3 before with growth % (modeling-guide.md §5 template, with its filter
   contract). All measures go into `_Measures` with display folders.
5. *Business terms (glossary):* every measure that goes on the report gets a **term** – the business word
   for it ("Revenue", "Active customer") with a one-sentence definition in the user's words. Draft the
   definitions from the formulas and the review answers (step 4b.5) and ask them **in the same call as the
   measures** (not a call of its own): one single-select "Use the drafted business terms (Recommended)"
   (`preview` with term · definition · measure for the recommended measures) · "I'll rewrite some" (then
   ask in chat which). A measure the user unticks in that call drops its term. Write
   `choices.json` → `glossary[]` (`term`, `definition`, `owner` if given, `examples`) and the term on the
   measure (`build.measures[].term`, written to the model as `annotation Term`). A term that two measures
   claim, or a definition the formula does not match, goes back to the user.

## Step 6 – Extras (one AskUserQuestion call, multiSelect)

The run always ends with an **overview page** (`overview.html`, step 8.7) and a **DAX check file**
(`checks.dax`) – they are part of the hand-over, not extras. Ask about the rest (two questions, max 4
options each, recommended ones first):

1. *Report and documentation* (multiSelect): "Dashboard pages – the **pbip-layout** skill (Recommended)" –
  then **always** ask which template and which pages with pbip-layout's step 3 questions. The
  **dashboard plan** (`analysis.dashboard_plan`) decides the recommendation: its template first and its pages
  marked "(Recommended)". Check the plan against the designed model first: a page or visual the model can no
  longer fill (a dropped KPI or dimension) leaves the plan with its reason. Then show the **final plan**
  (per page: visual → KPI → measure) in the page question's `preview`. Without a plan (declined), recommend
  the template from the model: leads/campaigns, opportunities or a ledger with account types → Business,
  order lines with products and customers → Generic layout (the AdventureWorks template – always called
  "Generic layout" in questions and previews, its colours "Generic colors"). **Always ask the colours, also in fast mode**
  (fast-mode.md: template colours · saved profile · hex codes · screenshot, with the follow-up in chat),
  and the title as in `/messy-pipeline` section 2b. Save the template to
  `extras.layout_template`, the page keys to `extras.layout_pages`, the colours and title to a pbip-layout
  profile (`runs/<run-id>/layout-profile.json`, `extras.layout_profile`). The Business template's build
  steps are in build-steps.md, step 8.6 ·
  "Data catalog, lineage page and dbdiagram model – the **pbip-catalog** skill (Recommended)" (needs
  Python + openpyxl) · "Governance and handover – the **pbip-governance** skill (Recommended)": PII
  audit (visible personal data), RLS inventory, data sources, handover Markdown and an Azure DevOps wiki
  bundle · "Obsidian note" (only when `pipeline.config.json` has `obsidian.enabled: true` – say the vault path).
2. *Check and publish* (multiSelect): "Open in Power BI Desktop, refresh and check the numbers
   (Recommended)" (only if Desktop is installed; skip it when free memory is below 1.5 GB and say why) ·
   "Publish the overview page as a private page I can share" (only when the Artifact tool is available).

Without the dashboard the report gets one simple page (a card per measure and a table of the main fact)
so it opens.

## Step 7 – Review before the build

Show all choices compact with `node .claude\skills\pipeline-power-bi\scripts\run-summary.js runs\<run-id>`
(do not assemble it by hand): the design first (facts with grain, dimensions, staging only, left out), then
per source one line (`Sales: 9 steps – F08 order_date (day-first), F09 amount … · not kept: F14 amount`),
then relationships, measures, roles, extras and the review points. Ask:
"Build the project (Recommended)" · "Change the cleaning of a table" (ask which, then repeat step 4 for
it) · "Change the model, a measure or extras" · "Stop here (choices are saved)". Repeat until "Build" or "Stop".
**Adding or changing a measure** on a built run (a new business question, a period comparison, a fix):
follow build-steps.md → *Add or change a measure* – the measure goes in the spec with its filter contract
and an expected value from the source files, is tested with `measure-test.js` before it is saved, and is
proved again in `checks.dax` after the rebuild.

## Step 8 – Build

**Read [references/build-steps.md](references/build-steps.md) before the build** – it holds the commands,
flags and details of the eleven parts below, and the drift check for new files. What must hold in every run:

1. Power BI Desktop is closed (`Check-Tools.ps1 -DesktopOnly` – not the full check again); the files are copied to `data/` when `copy_files`.
2. **Expected values** come from the source files with the kept fixes, never from the model:
   `source-stats.js runs\<run-id> --queries <file> --apply` replays the build spec's steps on the exported
   rows and writes `checks[]` (and grounded questions' `expected`) in one call; `build-docs.js` writes
   `expected-values.md` and `checks.dax`.
3. **The model is generated, not hand-written:** the build spec in `choices.json` → `build`
   ([references/build-spec.md](references/build-spec.md)), always with `"naming": "snake_case"` – every
   table, column and measure in the model is snake_case (`dim_customer`, `customer_id`, `fact_sales`,
   `total_sales`, `dim_date`, `_measures`); `rebuild.js` renames the spec with `snake-names.js` first,
   so readable names written in the spec are converted consistently (DAX, relationships, checks, questions), the report scaffolded once with
   `powerbi-report-author scaffold`, then **`node .claude\skills\pipeline-power-bi\scripts\rebuild.js runs\<run-id>`** –
   model, hand-over files, model context, model health, grounded answers, handover and overview in order,
   stopping at the first failure. The same command after every later change (`--resume`).
4. **Stale numbers are not handed over:** `rebuild.js` names checks (`stale`) and questions (`staleQuestions`)
   whose table or measure changed after their expected value was computed – recompute them, then
   `rebuild.js … --checks-updated`.
5. **Validate** the TMDL (powerbi-modeling-mcp `ConnectFolder`, then `Disconnect` – an open connection locks
   the folder) and the report (`powerbi-report-author validate`, once). No build is done with errors.
6. **The other skills are loaded, not imitated** (pbip-layout, pbip-catalog, pbip-governance – parallel Skill
   calls). A visible column the PII audit flags goes back to the user: hide, keep or remove;
   `pii_not_personal[]` for reviewed false positives.
7. **Overview page** (`overview.html`; published as `overview.page.html` only when the user chose it).
8. **`checks.dax`** – one `EVALUATE` with a Difference per check.
9. **Grounded-answer test** – 3–5 business questions with expected numbers from the source files.
10. **Model context** (`model-context.md`) for AI assistants.
11. **Model health** (`model-health.md`) – the warnings are asked at the hand-over (step 10), in the same
    call as the open decisions, not in a round of their own; a DAX warning is fixed at once, never asked.

**New versions of the source files** (`--resume <run-id>` → "New files"): run the drift check first –
[references/build-steps.md](references/build-steps.md), last section.

## Step 9 – Check the numbers

- **The user never fills in "In Power BI" by hand** – `record-checks.js` writes it, the Difference column and
  one result line ("✅ 41/41 checks and 4/4 grounded answers: Difference 0 – no errors", or ❌ with the rows
  that are not 0) into `expected-values.md` and `grounded-answers.md`, saves `check-results.json` and
  rebuilds `overview.html`. A later rebuild writes the saved result back, marked ⚠️ outdated when the model
  changed since.
- **A – Claude runs the checks (default, with Desktop):** open `<Name>.pbip`, ask the user to click
  **Refresh** (and approve the file access prompt for the folder). Run the text of `checks.dax` and of
  `grounded-answers.dax` with powerbi-modeling-mcp `dax_query_operations`, save each tool result as it came
  (JSON) to `runs/<run-id>/checks.result.json` and `grounded.result.json`, then
  **`node .claude\skills\pipeline-power-bi\scripts\record-checks.js runs\<run-id> --checks runs\<run-id>\checks.result.json --grounded runs\<run-id>\grounded.result.json`**.
  A query error in a step: read the error (it names the step, e.g. `F08 Parse order_date`), fix the step,
  rebuild, refresh again.
- **B – the user runs them (no MCP connection):** the user pastes `checks.dax` into Desktop → DAX query
  view → Run, right-clicks the result → **Copy table**, and pastes it into the chat; same for
  `grounded-answers.dax`. Save each paste as it is to `checks.result.txt` / `grounded.result.txt` in the run
  folder and run the same `record-checks.js` command with those files (tab-separated, Danish or English
  number format).
- Tell the user the result line in one sentence. Then confirm each role row once with Modeling →
  **View as** → the role + *Other user*. A question with a difference is handled like any other
  difference (below).
- **The DAX guide is always handed over – never ask, never skip.** It is the run's own guide to `checks.dax`
  and `grounded-answers.dax`: the report name, run id, the number of checks, the key expected numbers and
  why, and every grounded question with its expected answer. Write it in English (principle 7): put
  `choices.json` → `dax_guide` = `{ "lang": "en",
  "why": { "<check name>": "<why this number, plain words>" }, "questions": { "1": "<short question>" } }`
  (the why/questions text in English, for the key checks), then run
  **`node .claude\skills\pipeline-power-bi\scripts\build-dax-guide.js runs\<run-id>`**. It writes
  `runs/<run-id>/checks.dax_grounded-answers.dax guide.html` next to `checks.dax`, `grounded-answers.dax` and
  the run's other files. **No copy to Downloads** (never pass `--downloads`) – all three stay in the run
  folder. Give the full path of the guide in the run folder in the hand-over. Run it
  again after every rebuild that changes a check or a question (`rebuild.js` refreshes
  it in the run folder as well).
- Every difference is either explained by a choice (cite the fix id) or fixed. A difference you cannot
  explain at once: follow the **reconcile** skill (`.claude/skills/reconcile/SKILL.md`) – split it by the
  dimensions until it sits in one slice and name the rows behind it. After a fix: rebuild, refresh, run
  the checks again and `record-checks.js` again (it rebuilds the overview page).

## Step 10 – Hand-over (5–8 lines)

**First the decisions still open** (principle 1): the open review points (`design.review`), the
`handover_notes` that are choices (a row left out, a value treated a certain way), visible PII the audit
flagged, pbip-layout's `layout-decisions.json`, and the model-health warnings (one multiSelect, e.g.
"Remove the unused fact columns: …"). Ask them with AskUserQuestion (max 4 per call, as few calls as fit): each
question stands on its own, says what was applied, has your recommendation first with "(Recommended)"
and its reason, then 1–3 alternatives with their effect. Keep the answers in `choices.json`; an answer
that differs from what was applied changes the spec or the layout config, then `rebuild.js` (and
pbip-layout's `gen-report.js`) runs again before the hand-over text. A point that is only information
(not a choice) stays a note.

What was built and the result of the check; links relative to the repository root to
`runs/<run-id>/pbip/<Name>.pbip`, `overview.html` (or its published link), `checks.dax`, the DAX guide
(always – its full path in the run folder, step 9),
`grounded-answers.md` (with the open review points from `design.review`), `model-context.md`,
`model-health.md` (and what the user chose to remove),
`cleaning-log.md`, `expected-values.md`, and what the chosen skills made (`layout-mapping.md`,
`pbip/docs/catalog.xlsx`, `pbip/docs/descriptions.xlsx` (name and description of every measure, column and table – all are described in the model), `lineage.html`, `model.dbml`, `governance/handover.md` and the wiki zip, the
Obsidian note); the governance flags in one line (visible personal data, RLS roles); how to change a choice later: `/pipeline-power-bi --resume <run-id>` → "Change the cleaning of a
table" → rebuild, or in Power BI Desktop → Transform data → *Applied steps* → right-click a step →
Delete (every step is named after its fix). Where to point the files: Transform data → Manage parameters
→ `SourceFolder`. For Excel: the queries find sheets and Excel tables by name, so renaming a sheet or
table in the workbook breaks the refresh – keep the names, or tell the skill on a `--resume`.

## Self-improvement

This skill is never finished. Improve it as you use it.

- When the user corrects how a step was done, update the reference file that step reads (or this
  SKILL.md) so the correction sticks – not only for this run. A correction to a cleaning step goes into
  `references/fix-catalog.md`; to the design, `references/modeling-guide.md`; to the build,
  `references/build-steps.md`.
- When a correction is a hard rule ("always X", "never Y"), add it to Principles above.
- Keep the skill small: when you add something, cut whatever no longer changes what the agent does.

## Reference files

| Step | Read |
|---|---|
| 1 | [references/run-files.md](references/run-files.md) – run folder and `choices.json` |
| Fast mode | [references/fast-mode.md](references/fast-mode.md) |
| 4 | [references/fix-catalog.md](references/fix-catalog.md) – every fix: recommended or not, variants, the M step, whether it changes the numbers – **only** when the user chooses "step by step" |
| 4b | [references/modeling-guide.md](references/modeling-guide.md) – star schema rules and checklist; [references/model-review.md](references/model-review.md) – the six review points and their evidence |
| 8 | [references/build-steps.md](references/build-steps.md) – commands, flags, the other skills, drift check (also before a `--resume` that rebuilds); [references/build-spec.md](references/build-spec.md) – the `build` spec. **Not** [references/source-model.md](references/source-model.md) in a normal build: `build-model.js` writes all M and TMDL from the spec – read it only for a load or refresh error, or to write an `M` step or op by hand |
| Any script | [references/scripts.md](references/scripts.md) – what each script does |
| PBIP/TMDL load errors | `../supabase-medallion-powerbi/references/tmdl-templates.md` (sections 1, 2, 4, 6–11) and `../supabase-medallion-powerbi/references/troubleshooting.md` |

Other skills used: `analysis-planning`, `pbip-layout`, `pbip-catalog`, `pbip-governance`, `reconcile` (all in `.claude/skills/`).

**After changing any script of this skill, or `parse_pbip.py`/`build_catalog.py`, run**
`node .claude\skills\pipeline-power-bi\tests\run-tests.js` (and
`python -m unittest discover -s .claude\skills\pbip-catalog\tests` and
`node .claude\skills\pipeline-power-bi\tests\golden-run.js` – the whole chain on the demo and messy retail
seed 7919, compared with `tests/golden/`; after an intended output change rerun it with `--update` and review
the snapshot diff) – all must pass, also in CI (`.github/workflows/tests.yml`). `--quick` is for use
while working; a change is only done when the full run passes **and every new path has a test of its
own** – a new fix, variant, source kind, op or flag gets a check in `run-tests.js` that fails without the
change (prove it: run the new check against the old script once). A new fix id in the profiler goes into
the fix-coverage test's `STEPS` (or `COVERAGE` with the place that handles it) in the same change.
