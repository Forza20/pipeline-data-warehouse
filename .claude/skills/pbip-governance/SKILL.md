---
name: pbip-governance
description: Analyze Power BI PBIP projects for governance, data lineage, and handover documentation. Parses TMDL semantic models and PBIR reports, detects PII columns, and exports Azure DevOps wiki bundles.
---

# PBIP Governance & Lineage Inspector

Analyze Power BI Project (PBIP) folders to produce governance and handover documentation. This skill parses the TMDL semantic model definition and PBIR report JSON, identifies potential PII columns, maps data lineage from source to visual, and generates Azure DevOps wiki bundles ready for `Publish code as wiki`.

## When to use this skill

Trigger when the user:
- Asks to document, analyze, or audit a Power BI PBIP project or folder
- Wants to generate handover documentation from a Power BI model
- Mentions TMDL, PBIR, semantic model inspection, or Power BI governance
- Needs a data lineage report, PII audit, or RLS inventory for a Power BI model
- Wants to export Power BI documentation to Azure DevOps wiki
- Uploads a folder ending in `.SemanticModel` or containing `.tmdl` files

Do NOT use for: PBIX binary files (see fallback section), live workspace queries, or Power BI Service REST API tasks.

## What the skill does

Given a PBIP folder path, produces:

1. **Model summary** — tables, columns, measures, relationships, RLS roles
2. **PII audit** — heuristic match against DA/EN field names (email, cpr, navn, adresse, løn, etc.)
3. **Data source inventory** — extracted from Power Query M expressions
4. **Data lineage** — source → table → report visual mapping
5. **Handover Markdown** — single file for quick handover
6. **Azure DevOps wiki bundle** — zipped folder with `.order` files, Mermaid diagrams, collapsible DAX sections, PII warning badges, ready for `Publish code as wiki`

## Workflow

### Step 1 — Locate the PBIP folder

Ask the user for the PBIP folder path if not provided. The folder must contain:
- `<name>.SemanticModel/definition/` with `.tmdl` files (or legacy `model.bim`)
- `<name>.Report/definition/` with `page.json` + `visual.json` files (or legacy `report.json`)

If the user provides a `.pbix` file (binary), explain that PBIX parsing is not supported in this skill — offer the fallback HTML tool in `assets/pbip-inspector.html` and recommend converting to PBIP via `File → Save As → Power BI Project`.

### Step 2 — Run the parser

Execute `scripts/parse_pbip.py` with the PBIP folder as argument. It emits a JSON structure to stdout with keys `model` (tables, relationships, roles, expressions, dataSources) and `report` (pages). Capture this as structured data.

The parser is shared with the `pbip-catalog` skill (`.claude/skills/pbip-catalog/`), which also needs these fields: `///` descriptions, Power Query `steps`/`references` per partition and shared query, `column.lineage`/`column.origin`, DAX `dependencies`, relationship cardinality and `visual.fieldRefs`. Keep them backwards compatible when changing the parser.

```bash
python3 scripts/parse_pbip.py "/path/to/pbip/project" --output model.json
```

Use `--output` to save the JSON: the script writes it as UTF-8 itself. A shell redirect (`> model.json`)
works too, but PowerShell's `>` and `Out-File` change the encoding (BOM or ANSI) and break characters
such as `→` and `æ`.

### Step 3 — Ask what output the user wants

Default to offering three options:
1. **Quick summary** — inline markdown summary in chat (for small models)
2. **Handover Markdown file** — single `.md` saved to `/mnt/user-data/outputs/`
3. **Azure DevOps wiki bundle** — zip with folder structure, `.order` files, Mermaid diagrams

For option 3, run `scripts/generate_azdo_wiki.py` which builds the bundle.

### Step 4 — Governance flags

Always surface these prominently, even in the quick summary:
- **PII count** — number of columns matching the PII heuristic (see `references/pii_patterns.md`)
- **RLS roles** — list names and table filter counts
- **Hidden PII columns** — flag if a PII-candidate column is visible (not hidden) as a higher governance risk

Use `:warning:` badges in Markdown output for PII and RLS sections.

## Output structure (Azure DevOps wiki bundle)

The wiki bundle follows `Publish code as wiki` conventions:

```
/
├── .order                  (top-level page order)
├── Home.md                 (landing page with [[_TOC_]] + overview)
├── Governance.md           (PII + RLS with :warning: badges)
├── Lineage.md              (Mermaid flowchart: source → table → visual)
├── Data-Sources.md
├── Tables.md               (index)
├── Tables/
│   ├── .order
│   └── <TableName>.md      (one page per table)
├── Report-Pages.md         (index)
├── Report-Pages/
│   ├── .order
│   └── <PageName>.md
└── README.md               (publish instructions)
```

Key wiki-specific features:
- `[[_TOC_]]` token for auto-generated tables of contents (Azure DevOps specific)
- `:::mermaid ... :::` fence (not triple-backtick) — this is the officially documented AzDO syntax
- Mermaid diagrams use `flowchart LR` only — Azure DevOps wiki does NOT support `erDiagram` or `classDiagram`
- Collapsible DAX sections via `<details><summary>` HTML tags
- Emoji shortcodes: `:warning:`, `:key:`, `:lock:`, `:eye:`, `:white_check_mark:`, `:shield:`, `:link:`

## Key parsing details

### TMDL tables
Each `.tmdl` file under `SemanticModel/definition/tables/` defines one table. Properties parsed:
- Table name (from `table <Name>` header)
- `isHidden`, `dataCategory`, description (`///` prefixed lines)
- Columns — name, `dataType`, `isHidden`, `isKey`, calculated vs imported
- Measures — name, full DAX expression (can span multiple indented lines), `displayFolder`, `formatString`, description
- Partitions — name, `mode` (import/directQuery/dual), M expression

### TMDL relationships
Found in `relationships.tmdl` or embedded in `model.tmdl`. Format:
```
relationship <guid>
    fromColumn: Table.Column
    toColumn: OtherTable.OtherColumn
    crossFilteringBehavior: bothDirections
    isActive: false
```

### PBIR visuals
Each visual has its own `visual.json` under `Report/definition/pages/<page>/visuals/<visual>/`. Extract:
- `visualType`
- Title from `objects.title[0].properties.text.expr.Literal.Value`
- Fields from `query.queryState.<role>.projections[].field.Column/Measure`

### M expression source detection
See `scripts/parse_pbip.py` — supports SQL Server, Snowflake, ADLS, Databricks, Postgres, MySQL, Oracle, Web/REST, SharePoint, OData, Excel/CSV files, Dataflows.

## PII heuristic

Simple substring match (case-insensitive) against column names. Full pattern list in `references/pii_patterns.md`. Flag false positives are expected — always remind the user to review manually. Do NOT claim a column IS PII; say "potential PII" or "PII candidate".

A column the user has reviewed as **not** personal data (company names, shop cities) gets
`annotation PII = not personal` in its TMDL (indented under the column, like the other annotations). The
parser exposes column annotations (`column.annotations`), `column_pii_reason(column, table)` returns ''
for such a column, and the wiki lists it once as "reviewed" instead of flagging it on every run. The
pbip-catalog skill honours the same annotation. Add it only after the user has said so.

## Fallback: standalone HTML tool

The file `assets/pbip-inspector.html` is a self-contained browser-based version of this tool. Offer it when:
- The user wants to share the tool with a colleague who doesn't have this skill
- The user wants to run the analysis offline without Claude
- Code execution is unavailable

To present it, copy to `/mnt/user-data/outputs/` and use `present_files`. It runs entirely in-browser with no server or uploads.

## Limitations (be upfront about these)

- **PBIX binary files are not supported** — direct user to save as PBIP first
- **DAX dependency graph** — the parser now emits direct dependencies per measure (`dependencies`); transitive closure and dashboard tagging live in the `pbip-catalog` skill
- **Column lineage through Power Query** — `column.lineage` / `column.origin` follow renames, joins (also to local steps), added columns, split columns, unpivots and navigation via regex; `Table.Combine` follows the first input only and custom functions are not expanded
- **VertiPaq stats** — column cardinality and size need Analysis Services access, not available from the file system alone
- **Very complex M expressions** — source detection uses regex, not a full M parser; obscure source functions may show as "Other"
- **TMDL parser is hand-written** — unusual indentation patterns may truncate multi-line DAX; recommend verifying measures output on first run

## Language

Match the user's language. The user is likely bilingual DA/EN — if they write in Danish, respond in Danish; if English, respond in English. Output files (Markdown, wiki) should also match the user's working language, but table/column names and DAX are always preserved verbatim.
