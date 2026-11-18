---
name: analysis-planning
description: Interview the user about the analysis a Power BI report must support – purpose and audience, the business questions and KPIs, how to slice and compare over time – before the semantic model is designed. One question at a time, 5–7 questions, each with 3 options built from the user's own tables and columns plus free text, then a dashboard plan the user approves – which pbip-layout template pages, which KPI in which visual, and each KPI's definition and DAX draft. Writes choices.json → analysis (with dashboard_plan), which decides the recommended tables, facts, measures, period comparisons, dashboard pages and grounded questions later. Always loaded by pipeline-power-bi in step 2b, on every path (also fast mode and "Keep my model"); can also run alone on a profile.json. Use it when the user wants to plan the analysis or the report's KPIs before modelling, or types /analysis-planning.
argument-hint: "[runs/<run-id>] [--fast]"
---

# analysis-planning – what the report must answer, before the model is built

Files show what the data *is*; only the user knows what the report is *for*. This skill asks that before
the cleaning and the star schema, so every later recommendation points at the analysis the user needs
instead of at the shape of the files. It decides nothing itself: its answers only change which option is
marked "(Recommended)" later, and the user still confirms each step.

Talk in the user's language, in plain words ("number", "split by", not "measure", "dimension"). Write the
answers in English, like the rest of `choices.json`.

**It always runs in a pipeline-power-bi run** – every path: normal, fast mode (short version), the "Keep my
model" path, and a `--resume` whose `choices.json` has no `analysis` (or no `dashboard_plan`). Its last
part, the **dashboard plan** (below), turns the answers into the recommended pages, visuals and KPIs.
**Make it visible:** start with one line naming it ("Analysis planning (the analysis-planning skill): 5–7
short questions, one at a time, then a dashboard plan you approve.") and end with the plan, so the user can
see that it ran and what it decided.

## Input

- `runs/<run-id>/profile.json` (from pipeline-power-bi step 2) – tables, columns with `kind`, `min`/`max`,
  `relations[]`. Read it one table at a time (`Get-Content -Raw -Encoding UTF8 | ConvertFrom-Json`).
- `runs/<run-id>/choices.json` – which tables are included (`include`), and `fast`. If `analysis` is
  already there (`--resume`), show it in one line and ask nothing, unless the user asks to change it.

Standalone (no run): ask for the path of a `profile.json` or a folder of CSV/Excel files and run
`Profile-Sources.ps1` from pipeline-power-bi first; write the answers to `analysis.json` next to it.

**"Keep my model" path** (no `profile.json`): build the options from the model in `runs/<run-id>/pbip/`
instead – tables, columns with their data type, measures and relationships from
`<Name>.SemanticModel/definition/tables/*.tmdl` and `relationships.tmdl`. Existing measures are the number
candidates (name them as the model does); the dimension tables' text columns are the split candidates; the
date table gives the time range. Everything else below is the same.

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
(`"source": "drafted"`); pipeline-power-bi asks about the drafted points at the hand-over (step 10). The
dashboard plan is drafted too and shown (not asked) – step 6's one dashboard question in fast mode
pre-ticks its template and pages.

## The dashboard plan (right after the interview)

Turn the answers into a concrete recommendation: which dashboard pages, which visual shows which KPI, and
each KPI's exact definition. **Only the visuals of the pbip-layout templates** are used – never invent a
visual the template has not got:
- AdventureWorks: pages and template fields in `../pbip-layout/layout.md` (→ *Pages*, *Template fields →
  the model*) – e.g. the Exec Dashboard's 4 KPI tiles (`Total Revenue`, `Total Orders`, `Total Profit`,
  `Return Rate`), the revenue trend, "orders by category", the 3 monthly KPIs vs last month, the top table.
- Business: modules, pages and their KPIs in `../pbip-layout/layout-business.md` (→ *Pages and modules*,
  *Required per module*).

How to draft it:
1. **Template** from `template_hint` and the audience (sales → AdventureWorks; marketing/sales pipeline/
   finance → Business).
2. **Pages:** recommend a page when it shows at least one KPI or split the user chose and the data has
   what the page needs (layout.md → Pages, last column). A page the data cannot fill (a map without a
   location, Customer Detail without customers) goes to `left_out` with the reason – never recommended.
3. **Visuals → KPIs:** for every recommended page, list its KPI-carrying visuals and put one of the user's
   KPIs (or a split) in each; a slot nothing fits stays empty with what fills it otherwise (the template's
   fallback, e.g. "orders → number of bookings") or "left out". The first KPI goes in the first tile.
4. **KPIs:** per KPI – `name` (the user's word), `definition` (their definition from the interview: which
   column, which rows count), `dax` (a draft on the source tables' columns, e.g.
   `CALCULATE ( SUM ( orders[amount] ), orders[status] IN { "Paid", "Shipped" } )` – names are made
   snake_case and fixed to the model in step 5), `visuals` (where it stands) and `comparison` (from
   `comparisons`: vs last month, same month last year, last 3 vs previous 3 complete months, or none).
   A comparison the user chose becomes its own KPI (`revenue_ly`, `revenue_yoy_pct`).

Show the plan in **one AskUserQuestion** (single-select) with the plan in `preview` – per page: the visuals
and the KPI in each, then the KPIs with definition and DAX draft, then what is left out:
"Use this dashboard plan (Recommended)" · "Change it" (ask in chat what to change, then show it again) ·
"No dashboard – only the model". In fast mode show it as text and apply it.

The plan is a **draft**: pipeline-power-bi step 5 makes its KPIs the recommended measures, and step 6 checks
it against the finished model and shows the final version (pages the model cannot fill after all, KPIs the
user dropped in step 5). When the user changes a KPI or page later, update `dashboard_plan` too.

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
  "asked": 6,
  "dashboard_plan": {
    "status": "approved",
    "template": "adventureworks",
    "pages": [
      { "key": "exec", "why": "headline revenue per region and the monthly trend",
        "visuals": [ { "visual": "KPI tile 1 (Total Revenue)", "kpi": "Revenue" },
                     { "visual": "Revenue trend", "kpi": "Revenue", "split": "date month" },
                     { "visual": "Orders by category", "kpi": "Orders", "split": "customers.region" },
                     { "visual": "KPI tile 4 (Return Rate)", "kpi": null, "note": "left out – no returns in the data" } ] }
    ],
    "kpis": [ { "name": "Revenue", "definition": "sum of orders.amount, paid orders only",
                "dax": "CALCULATE ( SUM ( orders[amount] ), orders[paid] = TRUE () )",
                "visuals": ["exec: KPI tile 1", "exec: Revenue trend"], "comparison": "previous month" } ],
    "left_out": [ { "page": "map", "reason": "no location column" } ]
  }
}
```

`dashboard_plan.status`: `approved` (the user picked the plan), `changed` (approved after changes),
`drafted` (fast mode), `declined` (no dashboard).

- `source`: `user` (picked or typed), `drafted` (not asked – fast mode or over the limit).
- `tables`: the source tables (profile keys) the KPIs and splits need.
- `template_hint`: `adventureworks` (orders/products/customers), `business` (marketing/sales/finance
  modules), or `null`.

Before the dashboard plan, show the analysis in 3–5 lines – purpose · audience · numbers · split · time.
The dashboard plan's question is the only confirmation; every later step still asks.

## What the answers change in pipeline-power-bi

They change only which option is recommended and its order; they never skip a question or remove an option.

| Step | With `analysis` |
|---|---|
| 2 (sheets) | Tables in `analysis.tables` are recommended; a table no KPI or split needs is not, with the reason "not used by the analysis". |
| 4 | Fixes on the KPI and split columns are named first in each table's step list. |
| 4b | Facts are drafted around the KPIs' columns; dimensions around `analysis.dimensions`; a source no KPI or split uses is drafted as *left out (not used by the analysis)*. Review points on KPI definitions take the user's definition as the drafted answer. |
| 5 | `dashboard_plan.kpis` become the first, recommended measures (named as the user named them, the DAX draft fixed to the model, the definition as the glossary entry); `comparisons` decide the period measures; the date table follows `time_grain`. |
| 6 | `dashboard_plan` decides the recommended template and pages (pre-ticked in pbip-layout's questions); the plan is checked against the model and shown in its final form. |
| 8.6 | pbip-layout maps each visual to the KPI the plan put there before any other match; a deviation is a decision in `layout-decisions.json`. |
| 8.9 | `analysis.questions` become the grounded-answer questions (rephrased with the glossary terms), topped up with drafted ones to 3–5. |

A later answer that contradicts the analysis (the user drops a KPI's measure in step 5): update
`analysis` too, so the summary and the hand-over stay true.
