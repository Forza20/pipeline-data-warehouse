---
name: pipeline-power-bi
description: Turn CSV files and Excel workbooks (.xlsx/.xlsm – every sheet or Excel table becomes a table) the user attaches into a cleaned Power BI project (PBIP with TMDL) without manual Power Query work. Also takes the user's own Power BI project (.pbip, or a .pbix saved as .pbip) and cleans the CSV/Excel files it reads, or adds dashboard, catalog and governance to it; without own data it offers the demo files or a new messy dataset. Profiles every file and sheet, proposes the cleaning steps per table (title lines, total rows, spaces, "N/A" text, case variants, mixed date/number/boolean/id formats, duplicates, anomalies, wide month columns, orphan keys, data types, readable names) and lets the user switch each one on or off before it writes the Power Query steps, relationships, date table and measures. Optional dashboard layout and data catalog. No database, no Supabase, no GitHub. Use it when the user wants a Power BI report from CSV or Excel files, asks to clean CSV or Excel data for Power BI, wants Power Query steps written for them, or types /pipeline-power-bi.
---

# pipeline-power-bi – from CSV and Excel files to a cleaned Power BI project

The user attaches CSV files and/or Excel workbooks. A CSV file is one table; in a workbook every sheet
(tab) is one table – or, when a sheet holds a formatted Excel table, that Excel table is. This skill
measures what is wrong in each of them, **proposes** a fix for every
problem, and writes only the fixes the user keeps as named Power Query steps in a PBIP project. The
user never edits Power Query by hand, and every proposal is a choice they can switch on or off – now,
at the review before the build, and on any later run.

Talk to the user in their language (the language they write in), in plain words: say "table" and
"cleaning step", not "partition" or "M expression". All files the skill writes are in English unless the
user picks another report language.

Arguments: file paths or a folder – CSV, Excel, a `.pbip` project or a `.pbix` (optional – otherwise ask),
`demo` for the demo files, `--name <report name>`, `--resume <run-id>`, `--fast` (see Fast mode).

## Principles

1. **The user decides, every time.** Nothing is cleaned, renamed, removed or modelled without the user's
   choice. Every question has the recommended option first, marked "(Recommended)", with what it does,
   how many rows it touches and whether it changes the numbers. "Accept all recommended" is one click
   for those who want speed; "choose one by one" and "skip" are always offered next to it. In fast mode
   the user decides once, for the whole run.
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

## Fast mode (`--fast`)

For a demo or a first look. With `--fast` in the arguments, or when the user picks "Accept all
recommended in every step" in step 1, the user has made one choice for the whole run: every question takes
its recommended option, and nothing more is asked until the hand-over. Only these are still asked:

- the path of the files when none was given (the report name is not asked: `--name`, else the folder name);
- a run folder that already exists (step 1.4), and Power BI Desktop being open (step 8);
- installing a missing program (step 0) – never install without a yes.

What each step does instead of asking:

| Step | Fast mode |
|---|---|
| 0 | Run `Check-Tools.ps1 -Catalog` (Node, the report CLI, Desktop, and Python + openpyxl for the catalog and governance). Python missing and not installed: skip both and say so in the hand-over. |
| 1 | Copy the files into the run folder. |
| 2 | Include the recommended sheets; append F21 pairs. Show the overview table, no questions. |
| 3 | The first (recommended) language and number format; proposed names; readable column names. |
| 4 | Every `recommended: true` finding at its default variant. F28 without names keeps the codes. Skip reading fix-catalog.md – the profile's `recommended` and `variant` are enough. |
| 4b | The proposed star schema. Review points are drafted and left **open** (they go into the hand-over). |
| 5 | Relationships with `preferred: true` and ≥ 95 % match, the date table, the default M01 variant, the recommended measures, glossary drafted from the formulas. |
| 6 | Catalog (pbip-catalog) and governance (pbip-governance) always, with AI descriptions written without asking. No dashboard, Desktop check or publishing, unless the user named them in the same message. The overview page and `checks.dax` are always made. A named dashboard uses *Standard* (no colour, section or title questions). |
| 8.6 | Governance's PII audit asks nothing: a visible column flagged as personal data stays as it is and goes into the hand-over as an open point (hide it later with `--resume`). |
| 7 | Show the review summary as a record of the choices, then build without asking. |
| 8.9 | Draft 3 grounded questions from the measures and dimensions yourself. |
| 8.11 | List the model-health warnings in the hand-over; do not rebuild. |
| 9 | Give `checks.dax` and `grounded-answers.dax` to run in Desktop. |

Work in few tool calls: write `choices.json` once after step 5 (not after every table); write the build spec
and `checks[]` in one turn, scaffold the report, then run `rebuild.js` once (it runs build-model, build-docs,
build-context, model health, the grounded answers, the handover and the overview in order); load
`pbip-catalog` and `pbip-governance` in one turn (parallel Skill calls) and run the catalog's
`--missing-only` and governance's `parse_pbip.py` + wiki bundle in one command. The hand-over says the
run used fast mode and how to change a choice: `/pipeline-power-bi --resume <run-id>`.

Ask with AskUserQuestion: at most 4 questions per call, 2–4 options per question (the tool adds "Other"),
each question understandable on its own (name the table and column in it). Use `multiSelect` where
several options can be kept; single-select for variants that exclude each other. **Anything the user has to
type (code names, a threshold, a person's name) is asked as a plain chat message, never as an option** – an
option such as "I'll type them" comes back with no text, because typing is only possible under "Other".

## Files

```
runs/<yyyy-MM-dd>_pbi_<name>/      # git-ignored
    data/                          # copies of the CSV/Excel files (unless the user keeps them in place)
    profile.json                   # Profile-Sources.ps1 output (reads CSV and Excel)
    choices.json                   # every answer – the single source for the build
    cleaning-log.md                # table → step → rows → choice (written at the build)
    expected-values.md             # rows and totals to check the report against
    checks.dax                     # the same checks as one DAX query (Desktop → DAX query view)
    overview.html                  # project overview page (build-overview.js)
    layout-mapping.md              # from pbip-layout (when the dashboard is chosen)
    checks-basis.json              # what the model looked like when checks[] were computed (build-docs.js)
    governance/                    # model.json, <Name>_azdo_wiki.zip (pbip-governance), handover.md (build_handover.py)
    pbip/<Name>.pbip, <Name>.Report/, <Name>.SemanticModel/
```

`choices.json`:
```json
{
  "run_id": "2026-11-06_pbi_sales", "name": "Sales", "source_folder": "runs/2026-11-06_pbi_sales/data/",
  "copy_files": true, "report_culture": "en-US", "currency": "USD", "report_language": "en",
  "tables": {
    "fact_orders": { "include": true, "source": { "kind": "csv", "file": "fact_orders.csv" },
      "table_name": "Sales", "role": "fact", "mode": "one-by-one",
      "fixes": [ { "fix": "F08", "column": "order_date", "keep": true, "variant": "day-first" },
                 { "fix": "F14", "column": "amount", "check": "Zero values", "keep": false } ] },
    "tblKunder": { "include": true, "source": { "kind": "excel table", "file": "salg.xlsx", "sheet": "Kunder", "item": "tblKunder" },
      "table_name": "Customer", "role": "dimension", "mode": "recommended", "fixes": [] },
    "Noter": { "include": false, "source": { "kind": "sheet", "file": "salg.xlsx", "sheet": "Noter", "item": "Noter" } }
  },
  "model": { "relationships": ["Sales[customer_id] -> Customer[customer_id]"], "date_table": true,
             "incomplete_month": "flag", "measures": ["Total amount", "Orders"] },
  "extras": { "layout": false, "catalog": false, "desktop": true },
  "status": { "profile": "done", "questions": "done", "build": "pending", "verify": "pending" }
}
```

## Step 0 – Check the tools (show a short status line after the check)

Windows 10/11 with Windows PowerShell 5.1 (Power BI Desktop needs Windows). Check without installing, in
one call (about 4 seconds; add `-Catalog` when the catalog may be chosen – it also checks Python + openpyxl):
```
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\pipeline-power-bi\scripts\Check-Tools.ps1 [-Catalog]
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
     (the original stays untouched), skip steps 2–5, 7 and 8.1–8.4, and run step 6, step 8.5 (validate),
     8.6 and 8.11 on the copy; there is no build spec, so no overview page, `checks.dax` or model context.
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

## Step 2 – Profile

```
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\pipeline-power-bi\scripts\Profile-Sources.ps1 -Path "<folder or file1,file2>" -OutFile runs\<run-id>\profile.json
```
Read-only; prints one line per table. Then read `profile.json` (per table: `kind` = `csv` / `sheet` /
`excel table`, `file`, `sheet`, `excelTable`, `range`, `hidden`, `isEmpty`, `encoding`, `delimiter`,
`headerRow`, `headerCells`, `dataRows`, `columns[]` with `kind`/`readable`/`min`/`max`/`sum`,
`findings[]` with `fix`, `column`, `rows`, `detail`, `recommended`, `variant`; plus `relations[]`, where
`matchedBy` = `name` or `values`). Read it with `Get-Content -Raw -Encoding UTF8 | ConvertFrom-Json`,
one table at a time – never paste it whole.

Show the user one overview table: file (and sheet / Excel table) → rows · columns · problems found (not
counting F17) · proposed role (fact = the table other tables do not point at, with dates and amounts;
dimension = a table others point at; other).

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
   with the list in the description (`fact_orders` → Sales (fact), `dim_customers` → Customer …) ·
   "Keep the file names" · "I'll type the names" (then ask in chat).
3. *Readable column names (F02) for all tables:* "Yes – order_date becomes Order date (Recommended)" ·
   "Keep the names from the files". This sets F02 for every table; it can still be changed per table.

## Step 4 – Cleaning, table by table ("faneblad for faneblad")

Every included table: each CSV file and each chosen sheet or Excel table. Name the sheet in the
question ("Sheet Salg in salg.xlsx"). Facts first, then dimensions, then the rest. For each table,
**one** AskUserQuestion call:

- Question 1 (single-select): "<table> (<file>, <rows> rows) has <n> proposed cleaning steps. How do you
  want to go through them?" · "Accept the <k> recommended steps (Recommended)" with the step list in the
  description and in `preview` · "Choose step by step" · "No cleaning for this table (only data types)".
- With "accept": keep every finding with `recommended: true` at its default variant, drop the others,
  and write them to `choices.json`. Show one line: "<table>: <k> steps kept, <m> not kept (<names>)."
- With "step by step": the next calls group the findings into questions of at most 4 options, in the
  order of [references/fix-catalog.md](references/fix-catalog.md):
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
   formulas, history, access and names are business meaning, not something the profile can decide. Show
   the drafted answer for each and let the user confirm, change or leave it open; write the result to
   `choices.json` → `design.review`. Open points go into the overview page and the hand-over.

## Step 5 – The model (one or two AskUserQuestion calls)

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
4. *Measures* (multiSelect, up to 4 per question, recommended ones first): proposals from the columns –
   sum of each amount column ("Total amount"; with F14 *flag*: only rows with `amount issue = "ok"`, say
   so), row count of the fact ("Orders"), distinct count of each dimension key ("Customers"), average per
   row ("Average order value"), share of a flag ("Paid share"), latest complete month and previous month
   for the main amount when there is a date table. All measures go into `_Measures` with display folders.
5. *Business terms (glossary):* every measure that goes on the report gets a **term** – the business word
   for it ("Revenue", "Active customer") with a one-sentence definition in the user's words. Draft the
   definitions from the formulas and the review answers (step 4b.5), show them in one AskUserQuestion
   (`preview` with term · definition · measure), and let the user confirm or rewrite them. Write
   `choices.json` → `glossary[]` (`term`, `definition`, `owner` if given, `examples`) and the term on the
   measure (`build.measures[].term`, written to the model as `annotation Term`). A term that two measures
   claim, or a definition the formula does not match, goes back to the user.

## Step 6 – Extras (one AskUserQuestion call, multiSelect)

The run always ends with an **overview page** (`overview.html`, step 8.7) and a **DAX check file**
(`checks.dax`) – they are part of the hand-over, not extras. Ask about the rest (two questions, max 4
options each, recommended ones first):

1. *Report and documentation* (multiSelect): "Sales overview dashboard – the **pbip-layout** skill
  (Recommended)" – then ask its colour/sections/title questions as in `/messy-pipeline` section 2b ·
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
it) · "Change the model or extras" · "Stop here (choices are saved)". Repeat until "Build" or "Stop".

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
   ([references/build-spec.md](references/build-spec.md)): staging per source with its kept steps by fix
   id, the design's tables with their ops and final columns, date, relationships, measures, roles. Then:
   ```
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
   - **pbip-layout**, *pipeline mode* (its SKILL.md section "Pipeline mode"): the user's colour/section/
     title answers from step 6 as a profile, the slot table from its `layout.md`, missing measures from
     its `measures.md`, `docs/layout-config.json`, and **`layout-mapping.md` in the run folder** (slot →
     measure → expected value → fallback → open points). Do this after the model validates.
   - **pbip-catalog**: `build_catalog.py <pbip> --missing-only` (its fast path: only the list of missing
     descriptions, in about a second), then AI descriptions for every missing field (its step 3, with keys
     described from the relationships) and **one** full run with `--ai-descriptions … --html`. Report: counts,
     description status, possible PII, and how much upstream lineage it could trace. With a staging layer
     the trace stops at merges – say how many fields reach the source.
   - **pbip-governance**: `parse_pbip.py <pbip>` (capture stdout from Python, not a PowerShell `>` – that
     adds a BOM), then `generate_azdo_wiki.py <json> --output governance/<Name>_azdo_wiki.zip`. The handover
     Markdown is **not** written by hand: `python .claude\skills\pipeline-power-bi\scripts\build_handover.py runs\<run-id>`
     writes `governance/handover.md` from the model and `choices.json` (model, source, PII audit, RLS,
     decisions = settled `design.review` points, open points = open ones + `handover_notes[]`, left out,
     documentation). Rerun it after every rebuild. Its PII audit must agree with the
     model: a **visible** column flagged as personal data (a person's name such as an account manager)
     goes back to the user as a question – hide it, keep it visible, or remove it – and on hide/remove the
     TMDL is changed and validated again. A flagged column the user says is not personal data (company
     names) goes into `choices.json` → `pii_not_personal[]` ("Customer[Customer name]"), so it is shown as
     reviewed and not asked again.
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
   and a Difference column. Example of the result: [references/checks.example.dax](references/checks.example.dax).
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
11. **Model health** (always): `python .claude\skills\pipeline-power-bi\scripts\model_health.py runs\<run-id>\pbip --profile runs\<run-id>\profile.json`
    → `model-health.md`: unused fact columns, hidden unused columns, near-unique text, dates with times,
    text keys, bidirectional and many-to-many relationships, auto date/time. Offer the warnings as one
    multiSelect ("Remove the unused fact columns: …"); a yes changes the build spec's columns and rebuilds.

## New versions of the source files (`--resume <run-id>` → "New files")

Before the user refreshes with new files, check them against what the model was built for:
`node .claude\skills\pipeline-power-bi\scripts\check-drift.js runs\<run-id> [--path <new file or folder>]`
→ `drift.md`. Exit code 1 = the refresh will fail: a file, sheet, Excel table or selected column is gone,
or a CSV's delimiter, header row or encoding changed. For each break propose the change to the build spec
(a renamed column: the guess it prints; a new sheet name: `item`), rebuild, and validate. Warnings (a
column that changed kind, a new problem type) go to step 4 for that table. Then copy the files to `data/`
when `copy_files` is true, and save the new profile as `profile.json`.

## Step 9 – Check the numbers

- With Desktop: open `<Name>.pbip`, ask the user to click **Refresh** (and approve the file access
  prompt for the folder), then run the DAX checks of source-model.md section 4 with
  `dax_query_operations` and compare with `expected-values.md`. A query error in a step: read the error
  (it names the step, e.g. `F08 Parse order_date`), fix the step, rebuild, refresh again.
- Without Desktop: give the user `checks.dax` (paste into Desktop → DAX query view → Run; every
  Difference should be 0) and `expected-values.md` for the cards.
- Run `grounded-answers.dax` the same way, then confirm each role row once with Modeling → **View as** →
  the role + *Other user*. Fill in "In Power BI" in `grounded-answers.md`. A question with a difference is
  handled like any other difference (below).
- Every difference is either explained by a choice (cite the fix id) or fixed. A difference you cannot
  explain at once: follow the **reconcile** skill (`.claude/skills/reconcile/SKILL.md`) – split it by the
  dimensions until it sits in one slice and name the rows behind it. Write the result into
  `expected-values.md` (column "In Power BI") and rebuild the overview page.

## Step 10 – Hand-over (5–8 lines)

What was built and the result of the check; links relative to the repository root to
`runs/<run-id>/pbip/<Name>.pbip`, `overview.html` (or its published link), `checks.dax`,
`grounded-answers.md` (with the open review points from `design.review`), `model-context.md`,
`model-health.md` (and what the user chose to remove),
`cleaning-log.md`, `expected-values.md`, and what the chosen skills made (`layout-mapping.md`,
`pbip/docs/catalog.xlsx`, `lineage.html`, `model.dbml`, `governance/handover.md` and the wiki zip, the
Obsidian note); the governance flags in one line (visible personal data, RLS roles); how to change a choice later: `/pipeline-power-bi --resume <run-id>` → "Change the cleaning of a
table" → rebuild, or in Power BI Desktop → Transform data → *Applied steps* → right-click a step →
Delete (every step is named after its fix). Where to point the files: Transform data → Manage parameters
→ `SourceFolder`. For Excel: the queries find sheets and Excel tables by name, so renaming a sheet or
table in the workbook breaks the refresh – keep the names, or tell the skill on a `--resume`.

## Reference files

- [references/fix-catalog.md](references/fix-catalog.md) – every fix: recommended or not, variants, the
  M step, and whether it changes the numbers. Read before step 4.
- [references/modeling-guide.md](references/modeling-guide.md) – how to turn cleaned tables into a star
  schema: grain, line-level and process facts, flat dimensions, junk and role-playing dimensions,
  surrogate keys, what to leave out, security, date, staging, review checklist. Read before step 4b.
- [references/source-model.md](references/source-model.md) – folder parameter, the four parse functions, the
  CSV and Excel table/partition templates, staging queries and star-schema patterns (section 2c), date
  table and DAX checks. Read before step 8.
- [scripts/Profile-Sources.ps1](scripts/Profile-Sources.ps1) – the read-only profiler for CSV and Excel (Windows
  PowerShell 5.1; Excel need not be installed).
- [scripts/build-model.js](scripts/build-model.js) + [references/build-spec.md](references/build-spec.md) –
  the model generator and its spec (choices.json → `build`). Read the spec reference before step 8.
- [scripts/pbip_sources.py](scripts/pbip_sources.py) – the CSV/Excel files behind the user's own Power BI
  project (step 1), read-only; refuses a `.pbix` with how to save it as `.pbip`.
- [scripts/Check-Tools.ps1](scripts/Check-Tools.ps1) – step 0's checks of Node, the report CLI, Desktop and
  Python in one call (JSON); installs nothing.
- [scripts/build-docs.js](scripts/build-docs.js) – `cleaning-log.md`, `expected-values.md` and `checks.dax`
  from the profile, the choices, `checks[]` and the generated model (step 8.4); marks checks made stale by a
  later design change (`checks-basis.json`, `--checks-updated`).
- [scripts/build_handover.py](scripts/build_handover.py) – `governance/handover.md` from the model and the
  choices (step 8.6), with pbip-governance's PII heuristic and role parser.
- [scripts/build-overview.js](scripts/build-overview.js) – the overview page (and optional Obsidian note)
  from the run folder.
- [scripts/rebuild.js](scripts/rebuild.js) – the run's scripts in order after a change (model → docs →
  context → health → grounded answers → handover → overview), stopping at the first failure; one JSON result.
- [scripts/run-summary.js](scripts/run-summary.js) – the compact summary of a run's choices for `--resume`,
  step 1.4 and step 7 (Markdown, or `--json`).
- Other skills used: `pbip-layout`, `pbip-catalog`, `pbip-governance`, `reconcile` (all in `.claude/skills/`).
- [tests/run-tests.js](tests/run-tests.js) – 123 checks of the profiler, the model generator, the hand-over files (build-docs, stale checks and questions, build_handover), rebuild.js, run-summary.js, the drift check, model health, model context, the grounded-answer test, the catalog's fast first run, own-project sources and the overview
  page on the fixtures in `tests/fixtures` (`tests/make-fixtures.py` recreates them). **After changing any
  script of this skill, or `parse_pbip.py`/`build_catalog.py`, run** `node .claude\skills\pipeline-power-bi\tests\run-tests.js`
  (and `python -m unittest discover -s .claude\skills\pbip-catalog\tests`) – all must pass. `--quick` runs 96
  of the 123 checks in about half the time (no drift or Python checks) for use while working; a change is
  only done when the full run passes.
- `../supabase-medallion-powerbi/references/tmdl-templates.md` – shared PBIP/TMDL templates (sections
  1, 2, 4, 6–11) and `../supabase-medallion-powerbi/references/troubleshooting.md` for PBIP/TMDL load
  errors.
