---
name: analysis-planning
description: Interview the user about the analysis a Power BI report must support – purpose and audience, the business questions and KPIs, how to slice and compare over time – before the semantic model is designed. One question at a time, 5–7 questions, each with 3 options built from the user's own tables and columns plus free text. Writes the answers to choices.json → analysis, where they decide which tables, facts, measures, period comparisons, dashboard template and grounded questions are recommended later. Loaded by pipeline-power-bi in step 2b (after the profile, before the cleaning); can also run alone on a profile.json. Use it when the user wants to plan the analysis or the report's KPIs before modelling, or types /analysis-planning.
argument-hint: "[runs/<run-id>] [--fast]"
---

# analysis-planning – what the report must answer, before the model is built

Files show what the data *is*; only the user knows what the report is *for*. This skill asks that before
the cleaning and the star schema, so every later recommendation points at the analysis the user needs
instead of at the shape of the files. It decides nothing itself: its answers only change which option is
marked "(Recommended)" later, and the user still confirms each step.

Talk in the user's language, in plain words ("number", "split by", not "measure", "dimension"). Write the
answers in English, like the rest of `choices.json`.

## Input

- `runs/<run-id>/profile.json` (from pipeline-power-bi step 2) – tables, columns with `kind`, `min`/`max`,
  `relations[]`. Read it one table at a time (`Get-Content -Raw -Encoding UTF8 | ConvertFrom-Json`).
- `runs/<run-id>/choices.json` – which tables are included (`include`), and `fast`. If `analysis` is
  already there (`--resume`), show it in one line and ask nothing, unless the user asks to change it.

Standalone (no run): ask for the path of a `profile.json` or a folder of CSV/Excel files and run
`Profile-Sources.ps1` from pipeline-power-bi first; write the answers to `analysis.json` next to it.

## Build the options from the data first

Before the first question, read the profile and draft, in one pass:

- **Number candidates** – amount, quantity, price and cost columns (`kind` number, not ids) per likely fact;
  row counts of facts ("orders", "tickets"); distinct counts of keys ("customers").
- **Split candidates** – text columns with few distinct values (region, channel, category, status), the
  columns of tables other tables point at (`relations[]`), and the date columns.
- **Time** – the date range per fact (`min`/`max`): under 3 months → day/week; up to 2 years → month;
  longer → month and year. Year-over-year only with ≥ 13 months; "last 3 vs previous 3 months" with ≥ 6.
- **Audience guess** – the table and column names (ledger/account → finance; orders/customers/products →
  sales; leads/campaigns → marketing; tickets → service).

Every option names real tables and columns ("Revenue = sum of `orders.amount`"), never generic text.

## The interview

AskUserQuestion, **one question per call, one call per turn**, 5–7 questions in all. Each question has
exactly **3 options**, the recommended one first with "(Recommended)" and its reason in the description;
the tool adds "Other", where the user types their own answer – say once, in the first question, that
"Other" is free text. A question stands on its own (name the table and column in it). The next question
builds on the answers so far.

Cover these three topics, in this order:

1. **Purpose and audience** (1–2 questions) – who opens the report, and which decision it feeds
   ("Sales managers following monthly revenue per region (Recommended)" · "Finance checking margin per
   product" · "Management: one page with 3–4 headline numbers").
2. **Business questions and KPIs** (2–3 questions) – the 3–5 questions the report must answer, and the
   headline numbers with their definition (which column, which rows count: paid only? without
   cancelled?). Use multiSelect for "which numbers"; single-select for a definition.
3. **Split and time** (1–2 questions) – which columns to split by (multiSelect), the time grain and the
   comparison (vs previous month, year-over-year, last 3 vs previous 3 complete months, none).

**Vague answer** ("better overview", "everything"): ask one follow-up that turns it into a number or a
question ("Which one number would you look at first?") – inside the limit of 7. Stop at 7 even if
curiosity remains; draft the rest yourself and mark it `"source": "drafted"`.

**Fast mode** (`--fast`, or `"fast": true` in `choices.json`): one AskUserQuestion call with three
questions – purpose, the top number, the main split – each with 3 options from the data. Draft the rest
(`"source": "drafted"`); pipeline-power-bi asks about the drafted points at the hand-over (step 10).

## Write the answers

`choices.json` → `analysis` (merge, keep everything else):

```json
"analysis": {
  "purpose": "Follow monthly revenue per region and find regions falling behind",
  "audience": "sales managers",
  "questions": [ { "text": "Which region had the highest revenue last complete month?", "source": "user" } ],
  "kpis": [ { "name": "Revenue", "definition": "sum of orders.amount, paid orders only", "columns": ["orders.amount", "orders.paid"], "source": "user" } ],
  "dimensions": [ { "column": "customers.region", "source": "user" }, { "column": "orders.channel", "source": "drafted" } ],
  "time_grain": "month",
  "comparisons": ["previous month", "last 3 vs previous 3 complete months"],
  "tables": ["orders", "customers"],
  "template_hint": "adventureworks",
  "asked": 6
}
```

- `source`: `user` (picked or typed), `drafted` (not asked – fast mode or over the limit).
- `tables`: the source tables (profile keys) the KPIs and splits need.
- `template_hint`: `adventureworks` (orders/products/customers), `business` (marketing/sales/finance
  modules), or `null`.

Then show the plan in 3–5 lines – purpose · audience · numbers · split · time – and go on. No extra
confirmation question: every later step still asks.

## What the answers change in pipeline-power-bi

They change only which option is recommended and its order; they never skip a question or remove an option.

| Step | With `analysis` |
|---|---|
| 2 (sheets) | Tables in `analysis.tables` are recommended; a table no KPI or split needs is not, with the reason "not used by the analysis". |
| 4 | Fixes on the KPI and split columns are named first in each table's step list. |
| 4b | Facts are drafted around the KPIs' columns; dimensions around `analysis.dimensions`; a source no KPI or split uses is drafted as *left out (not used by the analysis)*. Review points on KPI definitions take the user's definition as the drafted answer. |
| 5 | The KPIs become the first, recommended measures (named as the user named them, with their definition as the glossary entry); `comparisons` decide the period measures; the date table follows `time_grain`. |
| 6 | `template_hint` decides the recommended dashboard template; pages that show the KPIs and splits are recommended. |
| 8.9 | `analysis.questions` become the grounded-answer questions (rephrased with the glossary terms), topped up with drafted ones to 3–5. |

A later answer that contradicts the analysis (the user drops a KPI's measure in step 5): update
`analysis` too, so the summary and the hand-over stay true.
