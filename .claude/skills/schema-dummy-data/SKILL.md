---
name: schema-dummy-data
description: Turn a client's table/column schema (a CSV or XLSX listing which tables and columns will exist – no real rows) into realistic, deterministic dummy-data CSV files, so pipeline-power-bi can build a demo dashboard before real customer data is allowed. Infers a generator per column from its name (id, date, amount, email, phone, name, city, country, status, category, ...), detects primary/foreign keys from naming conventions (id, <table>_id) and samples foreign keys with a realistic skew instead of uniformly. Does not inject errors – messy-dataset does that instead, for testing cleaning logic rather than demos. Use when the user has only a schema (no real data yet), wants dummy/fake/synthetic data for a Power BI demo, or types /schema-dummy-data.
---

# schema-dummy-data – schema in, demo-ready dummy data out

A consultant often gets a client's table and column names before they are allowed to see real
rows. This skill fills that schema with realistic, made-up values so the files can be handed
to **pipeline-power-bi** as if they were the client's own export – no real customer data involved.

It is the mirror image of `messy-dataset`: that skill injects *known* errors to test a cleaning
pipeline; this one produces *clean*, consistent data to test or demo the model and dashboard.
Do not combine the two goals in one run – ask the user if they want error injection instead and
point them at `messy-dataset`.

## Step 1 – Get the schema file

Ask for the path to the client's schema file (same "Copy as path" instructions as
pipeline-power-bi step 1) unless it was already given. Accepted shapes, a **long list** – one row
per column:

| table / tabel | column / kolonne | type / datatype (optional) | example / eksempel (optional) |
|---|---|---|---|
| dim_customer | customer_id | id | |
| dim_customer | segment | string | Privat\|Erhverv |
| fact_orders | order_ref | string | SO-10023 |

CSV (comma, semicolon or tab) or XLSX (first sheet), headers case-insensitive, Danish or English.
`type` is a hint used only when the column name matches no known pattern. `example` beats the name:
`A|B|C` = pick from these values, one number = values around it, one code like `SO-10023` = same
letters with new digits. Both are optional – suggest an `example` for any column the run flags as
unmatched (Step 2).

A schema shaped as **one sheet per table with a header row** (no long list) is not read directly –
ask the user to paste it into the long-list shape first, or reshape it yourself into a temporary
CSV (table, column) before running the script.

## Step 2 – Ask locale, then run

One AskUserQuestion (single-select, recommended first): "Danish names, cities and DKK
(Recommended)" · "English/international names, cities and USD". Then run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\schema-dummy-data\scripts\New-DummyData.ps1 -SchemaPath "<path>" -OutDir "<folder>" -Locale da|en [-Seed <n>] [-EndDate yyyy-MM-dd] [-RowsFact <n>] [-RowsDim <n>] [-Rows "table=n,table2=n2"] [-PlanOnly]
```

Run with `-PlanOnly` first (fast, no files written). The JSON has per table `role`
(fact/dimension/date), `rows`, `primaryKey`, `foreignKeys` and `columns[].kind`, plus
`unmatchedColumns`. Show the user one line per table before writing files:
"<table> (<role>, <n> rows)<; key <pk>><; links to <table> via <fk>>", and mention lookups and
derived columns (`lookup <- ...`, `derived: quantity x unit_price`) so they know the numbers add
up. Unmatched columns: name them, say they got a generic placeholder, and offer to add an `example`
in the schema and rerun – or accept the placeholder for a first look. If a key or link looks wrong
(e.g. a fact's key detected as a customer id), stop and fix the schema naming before generating.

Defaults cover most schemas: 1000 fact rows, 30 dimension rows (closed lists like regions get
their natural size, a date table gets one row per day), two full years ending last month. Offer
`-Rows "table=n,..."` only if a table should be bigger or smaller. `seed` and `endDate` are
printed in the JSON – passing both back regenerates byte-identical files.

Without `-PlanOnly`, the script writes one CSV per table into `-OutDir` (UTF-8, comma-separated,
`\n` line endings – same CSV rules as `messy-dataset`). About 4 s for 1000 fact rows.

## Step 3 – Hand off to pipeline-power-bi

Point the user at `-OutDir` as their own files: `/pipeline-power-bi` → "My own files" → paste the
folder path. Say plainly that:

- the numbers and names are made up and mean nothing – only the **shape** (tables, columns,
  relationships) matches the client's real schema;
- the data is internally consistent – every foreign key exists in its dimension, totals equal
  quantity × price, email matches name, country matches city, sales grow over time – so the
  dashboard's measures and relationships can be checked, but the levels are invented;
- `unmatchedColumns` are generic placeholders – add an `example` and rerun if it matters;
- when the real data arrives later, the consultant reruns `pipeline-power-bi` on the real files –
  this skill's output is never mixed with real rows in the same run.

## How the generator decides things

[references/pattern-dictionary.md](references/pattern-dictionary.md) lists every column-name
pattern and what it generates, in Danish and English, and how primary/foreign keys and the
fact/dimension split are detected. Read it before changing
[scripts/New-DummyData.ps1](scripts/New-DummyData.ps1), or when a user asks why a column came out
a certain way.

## Reference files

- [scripts/New-DummyData.ps1](scripts/New-DummyData.ps1) – the generator (Windows PowerShell 5.1,
  no external modules; reads CSV via `Import-Csv`, XLSX via raw OOXML zip/XML parsing, the same
  technique pipeline-power-bi's `Profile-Sources.ps1` uses, so Excel need not be installed).
- [references/pattern-dictionary.md](references/pattern-dictionary.md) – the full column-name →
  generator table, the key-detection rules, lookups/derived numbers, and the table classifier.
- [tests/run-tests.ps1](tests/run-tests.ps1) – run after any change to the script
  (`powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\schema-dummy-data\tests\run-tests.ps1`).
