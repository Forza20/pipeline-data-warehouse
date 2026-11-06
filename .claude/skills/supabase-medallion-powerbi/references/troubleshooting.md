# Troubleshooting: error → cause → fix

Grouped by phase. Each entry was hit in a real build.

## Loading CSV into Supabase

| Symptom | Cause | Fix |
|---|---|---|
| Table Editor import "succeeds" but the table is empty, or columns stay NULL | Headers do not match column names exactly (e.g. `CID` vs `cid`) | Lower-case the header line, then import again |
| Import aborts with a type error | One value does not fit the column type (text in an integer column, bad date) | Read the error banner; import as `text` in bronze and cast in silver |
| Row count is one higher/lower than `wc -l` | The file has no trailing newline (or has a blank last line) | Compare with `lines - 1` and `lines`; check the last line |
| `winget install PostgreSQL...` fails with "Installer hash does not match" | Stale package manifest | Install psql from the vendor's installer (command-line tools only), or use the Table Editor |
| `psql` login fails through the pooler | User name lacks the project ref | Use `postgres.<project-ref>` (or `<role>.<project-ref>`) |
| `psql` "not recognized" although PostgreSQL was installed | Installer does not add `bin` to PATH | Call `C:\Program Files\PostgreSQL\<version>\bin\psql.exe` by full path |
| `psql -w` fails with "no password supplied" | No matching line in the password file | Add `<host>:5432:postgres:<role>.<project-ref>:<password>` to `%APPDATA%\postgresql\pgpass.conf` (`~/.pgpass`); host, port, db and user must match exactly |
| `\copy` fails: "COPY FROM not supported with row-level security" | Target table has RLS and the role is not its owner | Copy into a temp table, then `insert into … select * from temp` (template in the SQL reference) |
| Creating the RPC upload endpoint is refused by an agent's permission check ("Security Weaken") | Automated modes treat a new public write endpoint as a security risk | Load with psql and a loader role instead |
| No psql, no Python, and the file is too big for an MCP `insert` | Tooling missing on the machine | Token-protected RPC + `curl` (`sql-templates.md` → *Loading without psql*); drop the endpoint afterwards |
| `curl` to the RPC returns PGRST202 "Could not find the function … without parameters" | Request body is not valid JSON (e.g. an awk escaping error), so PostgREST sees no named parameters | Inspect the body file; escape `"` (and `\` if present) in every line |

## Silver / gold

| Symptom | Cause | Fix |
|---|---|---|
| Fewer silver rows than bronze | Dedupe keeps latest row per key (intended) or NULL keys were filtered | Report the difference and why |
| Orphan keys in the fact | Business-key formats differ between systems | Normalise keys in silver (`replace`, `substring`, prefixes) |
| Security advisor: "Function Search Path Mutable" | Procedure without fixed `search_path` | `alter procedure ... set search_path = ''` and schema-qualify names |
| Surrogate keys change between refreshes | Gold built as views with `row_number()` | Materialise gold as tables loaded by a procedure |
| *UNION types text and numeric cannot be matched* in a summary insert | `null` in the first `union all` branch is typed `text` | `null::numeric` in the first branch |
| Quality test fails although the data looks right | Expected value taken from another layer (raw CSV count vs deduplicated gold) | Recompute the expectation on the layer the test reads |
| Sums per sales rep (or any bridge member) add up to far more than the total | Plain join through a many-to-many bridge | Allocation column `1/n` + allocated measure (`sql-templates.md` → *Bridge with allocation*) |
| Revenue roughly 2–3× what the business expects | Cancelled/returned orders counted as revenue | Status rule in the base revenue measure (decision R3-7) |
| Distinct customer count far too low | One "Unknown" member for many missing ids | Inferred member per id (decision R2-4) |
| MCP `execute_sql` / `apply_migration` returns `declined` | The user's permission settings block the call (often `drop`, `grant`, policies) | Do not retry; save the step as a migration file, give the SQL inline for the SQL Editor, verify with a read-only query |
| Security advisor: "RLS enabled, no policy" on bronze/silver | Intended – only the owner reads those layers | No action; aim for zero findings on gold |

## Power BI connection

| Symptom | Cause | Fix |
|---|---|---|
| "The remote certificate is invalid according to the validation procedure" | Supabase root CA not trusted by Windows | Download the certificate (Project Settings → Database → SSL Configuration), install to *Current User → Trusted Root Certification Authorities*, restart Power BI |
| Login fails / "password authentication failed" | Pooler user name without project ref, or Windows credentials chosen | `powerbi_reader.<project-ref>`, credential type *Database* |
| Connection works but every table has 0 rows | RLS enabled with no policy for the role (default-deny) | `create policy ... for select to powerbi_reader using (true)` per table |
| Cannot reach the direct host | Direct host is IPv6-only on many plans | Use the session pooler host (port 5432) |

## Opening the PBIP

| Symptom | Cause | Fix |
|---|---|---|
| "ReportDefinition: Required artifact is missing in ...definition.pbir" | `.pbip` copied without its `.Report`/`.SemanticModel` folders (e.g. downloaded alone) | Open the `.pbip` inside the project folder; download the whole repo/zip |
| "Property 'description' is unknown and is not expected" (inner exception names `SingleColumnRelationship`) | `///` description in front of a relationship | Remove the `///` line; descriptions are not supported on relationships |
| Any TMDL load error after editing | Spaces instead of tabs, unquoted names, duplicate `lineageTag`, or Desktop was open during the edit | Check indentation and quoting; close Desktop before editing |
| Desktop crashes rendering: "Cannot read properties of undefined (reading 'customTheme')" | Report has no base theme | Add the theme file under `StaticResources/SharedResources/BaseThemes` and reference it in `report.json` |
| Desktop opens nothing / double-click does nothing | A hung `PBIDesktop.exe` without a window, or a nearly full disk | Reboot; free disk space |
| Entry file reappears as `<Name>1.pbip`, `report.json` turns into `definition/pages/...` | Desktop saved the project in its newer format | Normal. Rename the entry file back while Desktop is closed; commit the new format |
| Edits to TMDL/PBIR disappeared | Desktop was open and saved over them | Close Desktop (choose *Don't save*) before editing; re-apply edits |

## Report visuals

| Symptom | Cause | Fix |
|---|---|---|
| Dark KPI tiles render white with a thin dark frame; labels missing | `cardVisual` draws its own inner tile over the container background; white labels on white | `layout.backgroundShow = false` with selector `id: default` (*Layout med flere kort → Baggrund* off); `fillCustom.transparency = 100` alone is not enough |
| Small sparkline/area charts show an axis title (e.g. `month_start`) even with the axis hidden | `showAxisTitle` defaults to on | Set `showAxisTitle: false` on `categoryAxis` and `valueAxis` |
| Line chart shows an unwanted vertical slider | Zoom slider shows on both axes by default | `zoom.showOnValueAxis: false` |
| "This month vs last month" cards all show a big red drop | The data ends mid-month | Compare the latest *complete* month (see the measure template) |
| Numbers shown as K/M when whole numbers are wanted | Display units default to auto | `labelDisplayUnits = 1` on the value / labels |
| Card shows "1tusind" / "20tusind" for counts | Auto display units on a count | `labelDisplayUnits '1'`, `labelPrecision 0L` (`tmdl-templates.md` → *Formatting defaults*) |
| Card value cut off at the top; measure name repeated under the value | `cardVisual` label shown below the value in a low card | `label.show = false` (the title names the KPI), `layout.paddingUniform = 0D` |
| Text card ends in "…" | Text measure too long for the card | Shorten the measure (≈ 35 characters at 14 pt in 300 px) |
| Bar data labels show full numbers (74.374.711) although display units are set to millions | `labels.labelDisplayUnits` given as a quoted string (`'1000000'`) – data labels expect a number | `"Value": "1000000D"` on `labels`; cards use the quoted form |
| Bars in alphabetical order | No `sortDefinition` – the category is the default sort | `sortDefinition` on the measure, `Descending`, `isDefaultSort: true` |
| Axis titles show column names (`category`, `team`) on bar charts | `showAxisTitle` defaults to on | `showAxisTitle: false` on both axes; let the visual title name them |

## Environment

| Symptom | Cause | Fix |
|---|---|---|
| Random failures: "thread could not start", ECANCELED writes, installers failing with 1603 | System drive almost full | Check free space early (PowerShell `Get-PSDrive C`); ask the user before deleting anything; old installer caches in `%TEMP%\WinGet` are safe candidates |
| `powerbi-report-author` not found | Node.js missing or not on PATH | Reinstall Node.js LTS; refresh PATH in the shell. If installing is not possible (full disk, no rights): JSON + field-reference check in PowerShell (`tmdl-templates.md` → *Validation without Node*) and a screenshot from the user |
| User cannot open a file linked in chat ("it is in the output logs") | Link relative to the wrong folder | Link relative to the workspace root, add the full path; paste short SQL inline |
| Git push asks for credentials / fails non-interactively | Credential helper (e.g. GitHub CLI) removed | Push from VS Code Source Control, or reinstall the credential helper |
