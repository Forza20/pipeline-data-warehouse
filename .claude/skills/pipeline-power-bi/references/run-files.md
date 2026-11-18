# Run folder and `choices.json`

The files a run writes, and the shape of `choices.json`. Read when step 1 creates the run folder, and
whenever a step writes `choices.json`. The `build` key is in [build-spec.md](build-spec.md).

## Run folder

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

## `choices.json`

`analysis` is written by the analysis-planning skill in step 2b, always – its SKILL.md has the full shape,
including `analysis.dashboard_plan` (template, pages with visual → KPI, KPIs with definition and DAX draft,
left out, status).

```json
{
  "run_id": "2026-11-06_pbi_sales", "name": "Sales", "source_folder": "runs/2026-11-06_pbi_sales/data/",
  "copy_files": true, "report_culture": "en-US", "currency": "USD", "report_language": "en",
  "analysis": { "purpose": "…", "audience": "sales managers", "questions": [], "kpis": [], "dimensions": [],
                "time_grain": "month", "comparisons": [], "tables": [], "template_hint": "adventureworks", "asked": 6,
                "dashboard_plan": { "status": "approved", "template": "adventureworks", "pages": [], "kpis": [], "left_out": [] } },
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
  "extras": { "layout": false, "layout_template": "adventureworks", "catalog": false, "desktop": true },
  "status": { "profile": "done", "questions": "done", "build": "pending", "verify": "pending" }
}
```
