# Format: catalog.xlsx, lineage.md and model.dbml

## Keys
| Type | Key | Example |
|---|---|---|
| Table | `<table>` | `fact_sales` |
| Column | `<table>[<column>]` | `fact_sales[order_date]` |
| Measure | `<table>[<measure>]` | `_Measures[Revenue]` |

The same format as the fields in pbip-layout's `config.json`. The key is used to merge edits between runs –
if a field is renamed in the model, the old row lands on the **Removed** sheet, so the description does not
disappear silently.

## Editable columns (teal)
| Column | Use |
|---|---|
| Description | Business description. Written back as `///` when Status = Approved. |
| Owner | Data owner / responsible person. |
| Sensitivity | E.g. Public, Internal, Confidential, PII. Pre-filled "Possible PII - assess" from the column name – not for a column with `annotation PII = not personal` in TMDL (reviewed; "Possible PII" then says "No (reviewed: not personal)"). |
| Upstream source | Where the data comes from before Power BI. Filled automatically (see below); your own text is kept. |
| Status | `Missing` · `Translate` · `AI suggestion` · `From model` · `Edited` · `Approved` |

`Description source` (Excel / TMDL / AI) shows where the text came from in this run.

### Upstream source (automatic)
| Origin | Example text |
|---|---|
| File (Excel/CSV) | `Silver_Excel.xlsx › CUST_MASTER › CustomerName` (append of several sheets: `ORDERS_2025 + ORDERS_2026`) |
| Database without SQL | `gold.dim_customers.country (PostgreSQL)` |
| Database with `--sql` | `silver.erp_loc_a101.cntry ← bronze.erp_loc_a101.cntry (derived: case when …)` |
| Surrogate key | `Surrogate key generated in Power Query` / `Surrogate key from dim_customer (generated in Power Query)` |
| Calculated in Power Query | `Calculated in Power Query (fact_sales): Number.Round([Quantity] * [UnitPrice], 2)` |
| Fixed list (`#table`) | `Fixed list in Power Query` / `Lookup in fixed list in Power Query (dim_channel)` |
| Calculated column (DAX) | `Calculated column (DAX) in Power BI` |

Tables get the source file and sheet (`Silver_Excel.xlsx › products, subcategories`), the SQL layers
(`silver.crm_prd_info, silver.erp_px_cat_g1v2 ← bronze.… (filter: …)`), or for bridge tables the sheets the
rows come from (`… › campaign_skus (keys looked up in dim_campaign, dim_product)`).

The column **Upstream source (auto)** keeps the automatic text of the run. On the next run, Upstream source is
updated only if it is empty or still equals the last automatic text – if you wrote something yourself, it is kept.

### Status life cycle
```
Missing ──AI suggestion──► AI suggestion ──user edits──► Edited ──► Approved ──writeback──► (TMDL ///)
          TMDL ///  ──► From model ──────────────────────────────► Approved
```
Precedence on every run: text in Excel (status ≠ From model / Translate) > TMDL `///` > AI suggestion. Rows
with `From model` always follow the model, so changes in TMDL come through.

**Translate**: the TMDL description is not in English. This is decided by a word count (`needs_translation`)
of English and Danish function words and words with æ/ø/å. The row is added to `missing_descriptions.json`
with the field `translate`. An English AI suggestion replaces the original text (status `AI suggestion`,
source `AI (translated from TMDL)`). Only the write-back of an approved row changes the model.

## Sheets
- **Overview** – counts, description status, source of the dashboard slots, instructions.
- **Tables** – type (Fact/Dimension/Date/Bridge/Measures/Helper), source, source objects, upstream queries, storage.
- **Columns** – data type, key field, calculated, possible PII, origin (source object.column), Power Query steps, DAX.
- **Measures** – DAX, direct dependencies, all source columns (transitively), used by.
- **Dashboard** – one row per field per slot on the pbip-layout page (KPI 1–4, Trend, Monthly card 1–3, Bars
  per category, Top 10 table, Highlight 1–2).
- **Relationships** – cardinality, cross filter, active/inactive.
- **Sources** – data sources, parameters and shared Power Query queries.
- **Changes** – new and changed fields since the previous `catalog.json` in the same `docs/` folder. Columns:
  Change (New/Changed), Sheet, Key, Field, Before, After. These fields are compared: tables (Type, Source
  objects, Description, Status), columns (Data type, Format, Hidden, Origin, Upstream source (auto),
  Description, Status) and measures (DAX, Format, Folder, Hidden, Description, Status). The sheet exists only
  when there are changes.
- **Removed** – fields from the previous catalog that no longer exist.

The columns `Dashboard slot` (bound directly to a visual) and `Dashboard (indirect)` (part of it through measure
dependencies) make it possible to filter on everything that affects the dashboard.

## lineage.md
1. **Overview** – data source → shared queries → tables → report pages.
2. **Dashboard slots** – one graph per slot: slot ← measure ← dependent measures ← columns ← origin, plus a
   table with the Power Query steps per column.
3. **Column lineage per table** – collapsible tables with origin and steps.

Mermaid uses only `flowchart LR` (supported by Azure DevOps wikis). `--fence azdo` (default) gives
`::: mermaid`, `--fence github` gives ```` ```mermaid ````.

## lineage.html (optional, `--html`)
One self-contained HTML page with table-level lineage. It works offline and needs no server. The template is
`assets/lineage-template.html`, and the data is inserted as JSON in `<script id="lineage-data">`.

- **Columns = layers**, left to right: files (CSV/Excel sheets), database schemas sorted by name
  (raw/landing → bronze → staging → silver → gold; other schemas after their sources), Power Query queries,
  Power BI tables and report pages. When tables in the same schema build on each other, the schema is split
  into steps (`mp_x_gold · step 2`).
- **Groups**: tables in a column are grouped by the table they feed ("feeds dim_customer").
- **Dashed red border**: the table is not used further by the SQL files or Power Query that were read, or a
  Power BI table is not used on any report page. Without report pages the model tables are not marked.
- **Click** a table to highlight its whole path upstream and downstream. Click again or press Esc to remove
  the highlight. Hover over a table to see the full name, type, description and number of connections.
- The database layers need `--sql`. Without SQL the page shows only Power Query → model → pages. Temp tables
  get their own column ("temp tables"), and CTEs are followed like subqueries. Dynamic SQL
  (`execute format(…)`), `MERGE` and `UPDATE` break the trail as in Upstream source. The table before the
  break is then shown as "not used further".

## model.dbml (dbdiagram.io, optional)
Written unless `--no-dbml` is given.

| Power BI | DBML |
|---|---|
| Tables | `Table` with `headercolor` per type and `TableGroup` (Fact / Bridge / Dimension / Date / Measures / Helper) |
| Measure table | `Table` where every measure is a "column" of type `measure`; DAX and dashboard slot in `note` |
| Calculated columns | Ordinary column, `note: 'Calculated (DAX): …'` |
| Hidden columns | Included, marked `Hidden` in the note (the hidden placeholder in the measure table is left out) |
| Key | `[pk]` on the `isKey` column or the one side of a relationship |
| Relationships | `Ref` with `>` (many-to-one), `-` (one-to-one), `<>` (many-to-many). Inactive and two-way relationships are a comment on the `Ref` and in the table's `Note` (DBML has no dashed lines) |
| Table description | `Note` with description, type, source, source objects, Power Query queries, inactive relationships and dashboard slots |
