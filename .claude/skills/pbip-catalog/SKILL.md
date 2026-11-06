---
name: pbip-catalog
description: Builds a data catalog (Excel), data lineage (Markdown + Mermaid) and – optionally – a data model for dbdiagram.io (DBML) for a Power BI PBIP project, typically right after pbip-layout. Fields on the dashboard page are tagged with their slot (KPI 1, Monthly card 2 …), lineage runs from the data source through Power Query steps and DAX to the visual, and approved descriptions can be written back as `///` in TMDL. ALWAYS trigger when the user writes "Catalog:" followed by a project name, when pbip-layout has finished and the user says yes to a catalog, or when the user asks for a data catalog, lineage, dbdiagram, DBML or dbdocs for a PBIP project.
---

# PBIP Catalog – data catalog, lineage and dbdiagram.io

Work with the user in their language (English by default). Table, column and measure names and DAX/M are
reproduced unchanged.

The skill builds on the shared parser in `pbip-governance/scripts/parse_pbip.py` (TMDL/PBIR → JSON with
Power Query steps, column lineage and DAX dependencies). It is not copied – `build_catalog.py` finds it
itself (repo layout, `.claude/skills/`, `~/.claude/skills/`, `/mnt/skills/user/`, or `--parser` /
`PBIP_PARSER`). Format and columns are described in [format.md](format.md).

## Deliverables (in `<project>/docs/`)
| File | Content |
|---|---|
| `catalog.xlsx` | Sheets: Overview, Tables, Columns, Measures, Dashboard, Relationships, Sources (+ Removed, Changes). Teal columns are for editing. |
| `lineage.md` | Mermaid: table-level overview, one graph per dashboard slot, column lineage per table. Azure DevOps wiki compatible (`::: mermaid`). |
| `model.dbml` | **Optional** (skip with `--no-dbml`): the data model for dbdiagram.io / dbdocs.io with descriptions, DAX and dashboard slots in notes. |
| `catalog.json` | Machine-readable version (pipeline hand-off and diff between runs). |
| `missing_descriptions.json` | Fields without a description + context, for AI suggestions. |
| `lineage.html` | **Optional** (`--html`): table-level lineage as one HTML page. The columns are the layers files → bronze/silver/gold → Power Query → Power BI tables → report pages. Tables that are not used further have a dashed red border, and a click highlights the whole path. See [format.md](format.md). |

## Prerequisites
- Python 3 with `openpyxl`. The commands below say `python3`. On Windows it is often `python` or `py`, and
  `python3` may open the Microsoft Store. Check once with `python --version` (or use the full path) and use
  the command that works for the whole run.
- PBIP in TMDL format (`<Name>.SemanticModel/definition/`). `model.bim` can be catalogued, but write-back
  needs TMDL. If it is a .pbix: ask for File → Save as → *.pbip, and stop.
- Dashboard tagging: `docs/layout-config.json` from pbip-layout. If it is missing but the pbip-layout page
  (id `8d1e4c7a2b5f9e3d6c10`) exists, the slots are derived from the visual positions (layout.md). Otherwise
  the catalog is built without dashboard tags – tell the user.

## Workflow

1. **Find the project.** Use the path from pbip-layout, the uploaded folder or search for `*.pbip`. The
   output folder is `<project>/docs/`. If `catalog.xlsx` exists there (or the user uploads an edited
   version), it is the previous run – it is read and merged, never overwritten blindly (a
   `catalog.backup.xlsx` is made too).

2. **First run.**
   ```
   python3 "<skill folder>/scripts/build_catalog.py" "<project>" [--previous "<edited catalog.xlsx>"] [--sql <folder> ...] [--no-dbml]
   ```
   **Upstream source** is filled automatically from Power Query (file › sheet › column, schema.table.column,
   surrogate keys, calculated columns, fixed lists). If the model reads from a database, look for SQL that
   builds the tables in the repo/upload (e.g. `supabase/migrations/`, `sql/`, `models/`, `*.sql` with
   `CREATE VIEW` or `INSERT INTO … SELECT`) and pass the folders with `--sql`. The column is then followed
   through the layers, e.g. `silver.erp_loc_a101.cntry ← bronze.erp_loc_a101.cntry (derived: case …)`. Say
   which SQL folders were used, or that none was found. Text the user wrote in Upstream source is never
   overwritten.
   Use `--fence github` if lineage.md is shown on GitHub instead of an Azure DevOps wiki. Add `--html` if the
   user asked for the lineage overview as HTML (`docs/lineage.html`); otherwise it is offered in step 4. Add
   `--no-dbml` if the user does not want the dbdiagram.io model.
   The script prints a JSON summary: counts, description status, removed fields, changes since the last run
   (`changesSinceLastRun`) and model descriptions that need translating (`toTranslate`). The changes are on
   the **Changes** sheet, so a new version can be reviewed without reading the whole catalog.

3. **AI suggestions for missing descriptions.** Read `docs/missing_descriptions.json` and write
   `docs/ai_descriptions.json` as `{ "<Key>": "<description>" }`. Rules:
   - 1–2 sentences of plain business English: what the number/field means, unit, filters and time logic
     (e.g. "latest complete month"). Use the context (DAX, origin, Power Query steps, dashboard slot) – do not
     invent business rules that are not in the code.
   - **Keys are always described** from the relationships – never leave them Missing:
     - surrogate key (`*_key` on the one side): "Technical key for <dimension> (generated in gold); used only
       for relationships – do not show it in reports."
     - foreign key (`*_key` on the many side): "Connects <fact/bridge> to <dimension>[<key>]; technical field."
     - business key (`*_id`, `*_no`): "The source system's id for <subject> (e.g. GST-0001); used for lookups
       and reconciliation with the source."
     - placeholder in the measure table: "Hidden placeholder – makes `_Measures` a table; no data."
   - Other technical helper fields are skipped only if nothing meaningful can be said (leave them Missing).
   - Prioritise fields with a dashboard slot, then measures, then visible columns.
   - **Translation:** rows with `"translate"` have a model `///` description in another language (status
     *Translate*). Write it in English with the same content. Add nothing and leave nothing out. Decision ids
     (R2-6), status values (Completed) and field names are kept unchanged. The English text replaces the
     original in the catalog as an *AI suggestion*. Only when the user sets Approved and runs step 5 is the
     model changed.
   Then run again:
   ```
   python3 "<skill folder>/scripts/build_catalog.py" "<project>" --ai-descriptions "<project>/docs/ai_descriptions.json"
   ```
   Precedence: edits in Excel > TMDL `///` > AI suggestion. An AI suggestion never overwrites anything,
   except a non-English TMDL description with status *Translate*.

4. **Report and ask about next steps** (AskUserQuestion, multi-select):
   - "I will edit/approve descriptions in Excel" → ask for the edited `catalog.xlsx` back and go to step 5.
   - "Lineage overview as HTML" → run `build_catalog.py` again with the same arguments plus `--html`. Tell
     the user that `docs/lineage.html` opens in an ordinary browser. If the session can publish pages (the
     Artifact tool), offer to publish it as a private page as well.
   - "Publish on dbdocs.io" → step 6 (only when `model.dbml` was written).
   - "Done".
   Show briefly: number of tables/columns/measures, dashboard fields, description status, possible PII
   columns, and – when `model.dbml` exists – how to open it in dbdiagram.io (dbdiagram.io → Create diagram →
   paste the content of `model.dbml`, or Import → DBML).

5. **Write-back to TMDL (separate step, needs approval).**
   - Always do a dry run first and show the diff:
     ```
     python3 "<skill folder>/scripts/writeback_descriptions.py" "<project>" "<catalog.xlsx>"
     ```
   - Only rows with **Status = Approved** are written. Only `///` lines change – never DAX, M or properties.
   - Ask with AskUserQuestion whether the diff may be written. Ask the user to close the project in Power BI
     Desktop first (otherwise Desktop may overwrite the files).
   - On yes: run again with `--apply`, then run `build_catalog.py` again, so the catalog shows the
     descriptions as written to the model.

6. **dbdocs.io (optional – only on explicit request).** Publishes a hosted page with an ER diagram and a
   searchable catalog from `model.dbml`:
   ```
   npm install -g dbdocs
   dbdocs login                      # or set DBDOCS_TOKEN (dbdocs token -g)
   dbdocs build "<project>/docs/model.dbml" --project "<project name>"
   dbdocs password --set "<password>" --project "<project name>"   # if the page must be protected
   ```
   Needs network access and a dbdocs account. If it fails, deliver the files and explain how the user can run
   the command themselves.

## Fixed rules
- Never change DAX, Power Query or report files. The only write in the project is `///` lines in step 5 after
  approval.
- The PII flag is a name heuristic: write "possible PII", never "is PII".
- Never publish to dbdocs or other services without an explicit request.
- Repeat the caveats: static analysis; column lineage through Power Query is regex-based (complex M
  expressions, `Table.Combine` with several sources and custom functions are followed only partly); the SQL
  lineage (`sql_lineage.py`) is regex-based too. It follows CTEs, temp tables and subqueries in expressions,
  but not dynamic SQL, dbt Jinja and `MERGE`/`UPDATE`, nor `select alias.*` passthrough. Upstream source then
  stops at the last step that could be read.
- After changing the scripts: run the tests, `python -m unittest discover -s "<skill folder>/tests"`. Set
  `PBIP_CATALOG_RUNS` to a folder with pipeline runs, so the tests also check coverage on real data.
