---
name: schema-dummy-data
description: Turn a client's schema – an Excel workbook with one sheet per table (column names in row 1, optionally a few example rows the client filled in) or a CSV/XLSX long list of table/column names – into a realistic, deterministic dummy-data XLSX with one sheet per table, so pipeline-power-bi can build a demo dashboard before real customer data is allowed. The client's example rows are kept and used as inspiration for the rest (same value lists and frequencies, number ranges, id/code formats continued, date period, share of empty cells); without them it guesses from the column names (id, date, amount, email, name, city, status, ...). Detects primary/foreign keys from naming conventions and links a fact to a dimension by a shared name column when the fact has no id. Does not inject errors – messy-dataset does that. Use when the user has only a schema or a few example rows (no real data yet), wants dummy/fake/synthetic data for a Power BI demo, or types /schema-dummy-data.
---

# schema-dummy-data – schema in, demo-ready dummy data out

A consultant often gets a client's table and column names before they are allowed to see real
rows. This skill fills that schema with realistic, made-up values so the file can be handed
to **pipeline-power-bi** as if it were the client's own export – no real customer data involved.

It is the mirror image of `messy-dataset`: that skill injects *known* errors to test a cleaning
pipeline; this one produces *clean*, consistent data to test or demo the model and dashboard.
Do not combine the two goals in one run – ask the user if they want error injection instead and
point them at `messy-dataset`.

## Step 1 – Get the schema file

Ask for the path to the client's schema file (same "Copy as path" instructions as
pipeline-power-bi step 1) unless it was already given. Two shapes are read, detected
automatically:

**A. One sheet per table (recommended – the client fills it in).** An XLSX where every sheet is a
table: sheet name = table name, row 1 = column names, and – optionally – one or more rows the
client filled in. A CSV in this shape is one table named after the file.

| CustomerID | CustomerName | Segment | PaymentTerms |
|---|---|---|---|
| 1001 | Meridian Group | Enterprise\|Mid-Market\|SMB | Net 30 |

**B. Long list** (CSV with comma, semicolon or tab, or the first sheet of an XLSX), one row per
column, headers `table`/`tabel`, `column`/`kolonne`, optional `type`/`datatype` and
`example`/`eksempel` (`A|B|C` = pick from these, one number = values around it, one code like
`SO-10023` = same letters with new digits).

If the user asks what to send the client, give them this text (translate as needed):

> Fill in one or more rows under the column names in each sheet. Use made-up but realistic
> values – not real customers or orders. Where a column has a fixed set of values, write them all
> separated by | (e.g. Enterprise|Mid-Market|SMB).

**The client's rows are removed from the output.** They are only inspiration for the generated
rows (same values, ranges, formats, period). Keys start where the samples start. Pass
`-KeepSampleRows` only when the user asks to keep them as the first rows of each table.

## Step 2 – Ask locale, then run

One AskUserQuestion (single-select, recommended first): "Danish names, cities and DKK
(Recommended)" · "English/international names, cities and USD". If the client's sample rows or
column names are clearly in one language (international cities, English labels), recommend that
one instead and say why. Then run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\schema-dummy-data\scripts\New-DummyData.ps1 -SchemaPath "<path>" -OutDir "<folder>" -Locale da|en [-Seed <n>] [-EndDate yyyy-MM-dd] [-RowsFact <n>] [-RowsDim <n>] [-Rows "table=n,table2=n2"] [-Format xlsx|csv|both] [-OutName <file.xlsx>] [-KeepSampleRows] [-PlanOnly]
```

Default `-OutDir`: the user's Downloads folder (`%USERPROFILE%\Downloads`, "Overførsler"), so the
result can always be opened there – unless the user names another folder. Never write into a
folder of real data.

Run with `-PlanOnly` first (fast, no files written). The JSON has `inputShape`, `period` and
`periodFrom` (`sample rows`, `endDate` or `default`), and per table `role`
(fact/dimension/date), `rows`, `sampleRows`, `primaryKey`, `foreignKeys` (a `via: "name"` entry is
a name link) and `columns[].kind`, plus `unmatchedColumns`, `hints` and `sampleWarnings`.
Show the user one line per table before writing files:
"<table> (<role>, <n> rows, <k> from the client)<; key <pk>><; links to <table> via <fk>>", and
mention lookups and derived columns (`lookup <- ...`, `derived: quantity x unit_price`) and what
the sample rows decided (`sample list (3 values)`, `sample range 980..15000.75`,
`sample code ORD#####`, `+ 38% empty`, a period taken from the sample dates) so they know the
numbers add up.

- **unmatchedColumns** got a generic placeholder (`Priority 7`). With shape A: ask for a filled-in
  row, or add values yourself in a copy of the sheet. With shape B: add an `example`. Or accept
  the placeholder for a first look.
- **hints**: a column where the client wrote only one value (every row gets it, or the standard
  list is kept) – suggest writing all values separated by `|`.
- **sampleWarnings**: a client row that points at something the other table does not have (an
  order for a customer that is not in the customer sheet) – that row's link will break; tell the
  user which value.
- If a key or link looks wrong (e.g. a fact's key detected as a customer id), stop and fix the
  schema naming before generating.

Defaults cover most schemas: 1000 fact rows, 30 dimension rows (never fewer than the client's
rows; closed lists like regions get their natural size, a date table gets one row per day), two
full years ending last month – or, with sample dates, the months the samples span. Offer
`-Rows "table=n,..."` only if a table should be bigger or smaller. `seed` and `endDate` are
printed in the JSON – passing both back regenerates a byte-identical file.

Without `-PlanOnly`, the script writes **one XLSX with a sheet per table** to `-OutDir`, named
`<schema name>_dummy.xlsx` (or `-OutName`): numbers as numbers, dates as real Excel dates, header
row bold, frozen and filtered. `-Format csv` writes one CSV per table instead (UTF-8, comma, `\n`
line endings – same CSV rules as `messy-dataset`); `both` writes both. About 7 s for 1000 fact rows.

## Step 3 – Hand off to pipeline-power-bi

Point the user at the XLSX as their own file: `/pipeline-power-bi` → "My own files" → paste the
path of `<name>_dummy.xlsx` (every sheet becomes a table). Say plainly that:

- apart from the client's own sample rows, the numbers and names are made up and mean nothing –
  only the **shape** (tables, columns, relationships) and the style of the values match the
  client's schema;
- the data is internally consistent – every foreign key and name link exists in its dimension,
  totals equal quantity × price, email matches name, country and region match city, sales grow
  over time – so the dashboard's measures and relationships can be checked, but the levels are
  invented;
- `unmatchedColumns` are generic placeholders – a filled-in example row or an `example` fixes them;
- put "example data" on the dashboard when it is shown to the client;
- when the real data arrives later, the consultant reruns `pipeline-power-bi` on the real files –
  this skill's output is never mixed with real rows in the same run.

## Called from pipeline-power-bi (pipeline mode)

When pipeline-power-bi loads this skill (its step 1, "Only a schema or a few example rows"), run steps
1–2 as above with these changes, then return to pipeline-power-bi:

- `-OutDir runs/<run-id>/source/` and `-Format xlsx` – not Downloads; the run reads the file from there.
- The locale question is skipped when pipeline-power-bi runs in fast mode: take the recommendation.
- Skip step 3's hand-off text; give back only the XLSX path and the `-PlanOnly` lines. Pipeline-power-bi's
  hand-over says the numbers are made up and adds "example data" to the dashboard title.

Alone (`/schema-dummy-data`), the skill needs no other skill and works as written above.

## How the generator decides things

[references/pattern-dictionary.md](references/pattern-dictionary.md) lists every column-name
pattern and what it generates, in Danish and English, how sample rows refine it, and how
primary/foreign keys, name links and the fact/dimension split are detected. Read it before
changing [scripts/New-DummyData.ps1](scripts/New-DummyData.ps1), or when a user asks why a column
came out a certain way.

## Reference files

- [scripts/New-DummyData.ps1](scripts/New-DummyData.ps1) – the generator (Windows PowerShell 5.1,
  no external modules; reads CSV via `Import-Csv`, XLSX via raw OOXML zip/XML parsing and writes
  XLSX the same way, so Excel need not be installed).
- [references/pattern-dictionary.md](references/pattern-dictionary.md) – the full column-name →
  generator table, sample-row rules, key detection, name links, lookups/derived numbers, and the
  table classifier.
- [tests/run-tests.ps1](tests/run-tests.ps1) – run after any change to the script
  (`powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\schema-dummy-data\tests\run-tests.ps1`,
  about 2 minutes).
