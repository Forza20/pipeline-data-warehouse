# Overview page (Phase 9)

One self-contained HTML page that shows the whole build at a glance: the sources, the four layers with
their gates, what was flagged, and who consumes the result. Template: `references/overview-template.html`.

## How to make it

1. Copy the template to `<project>/docs/overview.html`.
2. Replace **only** the JSON inside `<script id="overview-data">`. Do not change the HTML, CSS or script.
3. Every number comes from this build: a SQL count on the schemas, a file count, a line in the quality
   checks or the decision log, or a count in the PBIP files. Never estimate. If a number is not known,
   leave the item out instead of writing a guess.
4. Write the labels in the user's language (the page uses `lang="en"`; change it to the language of the labels, e.g. `da`).
5. Tell the user where the file is. It opens in any browser; it needs no server. If the session can
   publish pages (an Artifact tool), publish it as a private page and give the link.

## The four gates

The page numbers the gates the same way every time, so they must mean this:

| Gate | Between | Passes when | Source of the evidence |
|---|---|---|---|
| 1 | landing → bronze | every file is read: header and column count as expected | row-count check (Phase 1) |
| 2 | bronze → silver | rows in bronze = lines in the files − header | row-count check, raw_lines check |
| 3 | inside silver | parsing and row rules: 0 unparsed values; suspicious rows **flagged**, not deleted | silver checks, `amount_issue` / date status counts |
| 4 | silver → gold | keys unique, no orphans, all quality checks = 0 | `quality_checks.sql` (Phase 4) |

`flag.rows` is the number of rows silver flagged (anomalous amounts, derived or invalid dates …), shown as
the red pill under silver. Use 0 to hide it.

## JSON keys

```json
{
  "title": "Sales · medallion in Supabase",
  "subtitle": "From source files to Power BI.",
  "frameTitle": "supabase · project «<name>» · <prefix>*",
  "sources": {
    "files": [ { "type": "csv", "count": 6 }, { "type": "xlsx", "count": 1 } ],
    "systems": 4, "systemsLabel": "systems", "formatsLabel": "in 2 formats"
  },
  "layers": {
    "landing": { "n": 42, "unit": "files",  "desc": "raw, as delivered" },
    "bronze":  { "n": 42, "unit": "tables", "desc": "every row as received" },
    "silver":  { "n": 53, "unit": "tables", "desc": "cleaned, typed and combined" },
    "gold":    { "n": 24, "unit": "tables", "desc": "star schema" }
  },
  "flag": { "rows": 29, "label": "flagged" },
  "consumers": [
    { "icon": "report",  "n": 4,  "label": "report pages", "desc": "Power BI · 42 visuals" },
    { "icon": "measure", "n": 46, "label": "measures",     "desc": "_Measures" },
    { "icon": "people",  "n": 1,  "label": "reader role", "desc": "powerbi_reader · RLS" }
  ],
  "footer": [
    { "icon": "check",    "text": "<b>45 checks</b> at 4 control points" },
    { "icon": "decision", "text": "<b>22 decisions</b> logged" },
    { "icon": "equal",    "text": "<b>0 differences</b> from control values" }
  ],
  "note": "Source: SQL counts on bronze/silver/gold, quality_checks.sql and the PBIP files."
}
```

- `consumers[].icon`: `report`, `measure`, `people`, `cube`, `page`.
- `footer[].icon`: `check`, `decision`, `equal`, `clock`. Only `<b>` is kept in `text`.
- Counts per layer: `select count(*) from information_schema.tables where table_schema = '<schema>' and
  table_type = 'BASE TABLE'` (bronze may include `raw_lines`; say so in `desc` if it matters).
