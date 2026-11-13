# pipeline-data-warehouse

A test bench for Claude Code skills that build a data warehouse. Every run:

1. **generates a deliberately messy dataset** (retail, hotel or SaaS – duplicates, mixed formats, orphan keys,
   many-to-many bridges, lying documentation …) together with a hidden answer key,
2. **builds a medallion warehouse** (bronze → silver → gold star schema) in your Supabase project and a Power
   BI project (PBIP/TMDL),
3. **applies a dashboard layout** to the report, in your colours,
4. **writes a data catalog** (Excel), data lineage (Mermaid + an HTML page) and – optionally – a
   [dbdiagram.io](https://dbdiagram.io) model,
5. **scores everything against the answer key** and proposes concrete fixes to the skills.

Each step is a Claude Code subagent that follows a skill; the orchestrator never shows the answer key to the
agents being tested.

## What you need

| | |
|---|---|
| Windows 10 or 11 | Power BI Desktop and the dataset generator are Windows-only |
| [Claude Code](https://claude.com/claude-code) | in the terminal, VS Code or the Claude desktop app (not the chat on claude.ai: the skills need your files, PowerShell and Power BI Desktop) |
| A Supabase project | the free plan is enough (about 3 runs at a time); the pipeline only creates `mp_*` schemas, two roles and four helper functions |
| A GitHub account | for a repository that holds the datasets and answer keys – private is strongly recommended (setup explains why) |
| Programs | Git, GitHub CLI, Node.js, Python 3.12 + openpyxl, the PostgreSQL client (psql), the Power BI report CLI; Power BI Desktop is optional. The setup command checks them and installs only the ones you choose. |
| Claude Code add-ons | the Supabase connector (claude.ai → Settings → Connectors) and the Power BI authoring plugin from [microsoft/skills-for-fabric](https://github.com/microsoft/skills-for-fabric) |

## Quick start

```
git clone https://github.com/<owner>/pipeline-data-warehouse.git
cd pipeline-data-warehouse
claude                                   # start Claude Code here (or open the folder in VS Code or the Claude desktop app)
```

Then, in Claude Code:

1. `/pipeline-data-warehouse` – setup. It checks your programs (and asks before installing anything), asks
   for your Supabase project, currency and culture, GitHub account and whether you want Obsidian notes and the
   dbdiagram.io model, guides you through the Supabase roles and passwords, creates your private datasets
   repository and verifies everything. Your answers are saved in `pipeline.config.json` (git-ignored).
2. Restart Claude Code.
3. `/messy-pipeline` – a run (about 45 minutes with 20,000 rows). Before it starts it asks about the
   dashboard colours (standard, hex codes or a screenshot of a website), sections and title, and whether the
   warehouse decisions follow the skill's recommendations or your own answers. Quick test:
   `/messy-pipeline retail 42 --rows 5000`. Resume a stopped run with `/messy-pipeline --resume <run-id>`.

Results are in `runs/<run-id>/` (git-ignored): `scorecard.md`, the PBIP (`pbip/<Name>.pbip` – open it in Power
BI Desktop and refresh with the `powerbi_reader` login), `pbip/docs/catalog.xlsx`, `lineage.md`, `lineage.html`,
`model.dbml` and a project site `site.html`.

### Without Supabase: `/pipeline-power-bi`

Have CSV files or Excel workbooks and want a cleaned Power BI report, without a database? Type
`/pipeline-power-bi` and attach the files (or give their folder). In a workbook every sheet – or the Excel
table on it – becomes a table, and you choose which sheets to include. It needs no setup command, no Supabase and no GitHub, only Windows, Node.js,
the Power BI report CLI and, to load the data, Power BI Desktop.

**Your own data, the demo or a messy dataset.** Typed without a path, the skill asks which data to use:

| Choice | What you give | What happens |
|---|---|---|
| Your own files | the path of CSV files, Excel workbooks or their folder | profiled and cleaned into a new Power BI project |
| Your own Power BI project | the path of a `.pbip` (a `.pbix`: first File → Save as → *.pbip in Power BI Desktop) | the CSV/Excel files it reads are found and cleaned into a new project – or your model is kept and gets dashboard, catalog, governance and model health. Your own project is never changed. |
| The demo | nothing (`/pipeline-power-bi demo`) | two small CSV files with known totals |
| A messy dataset | nothing | a new retail, hotel or SaaS dataset (2,000 rows) with an answer key you can score against afterwards |

Give a path, not an upload: the chat does not accept `.xlsx` or `.pbix` files as attachments. In File
Explorer, hold Shift, right-click the file, choose *Copy as path* and paste it. A project that reads from a
database (SQL Server, SharePoint …) needs CSV or Excel exports of those tables.

**Try it in about 20 minutes.** Clone the repository, start Claude Code in the folder (type `claude` in a
terminal there, or open the folder in VS Code or the Claude desktop app) and type
`/pipeline-power-bi demo --name Demo --fast`. The `demo/` folder holds two small, made-up CSV files full of typical
problems ([demo/README.md](demo/README.md) lists them). `--fast` accepts every recommended choice and asks
nothing more; leave it out to answer each question yourself. The
skill checks the programs it needs first and installs only the ones you say yes to. You also need the Power BI
authoring plugin: `/plugin marketplace add microsoft/skills-for-fabric`, then
`/plugin install powerbi-authoring@fabric-collection`, and restart Claude Code.

How long it takes:

| Run | Time |
|---|---|
| Fastest: `--fast` (one question: the dashboard pages; dashboard, catalog and governance) | about 8 minutes + the dashboard step (estimate) |
| Quick: answer the questions, untick the dashboard, catalog and governance | 10–12 minutes |
| Full: every extra accepted | 20–30 minutes |
| Refresh and `checks.dax` in Power BI Desktop | about 5 minutes more |
| First time: installing the plugin, Node.js, the report CLI and Power BI Desktop | 10–20 minutes more |

Going through the cleaning steps one by one instead of "Accept all recommended" adds 5–10 minutes. Power BI
Desktop needs about 1.5 GB of free memory; with less, the skill skips the check in Desktop and gives you
`checks.dax` to run yourself.

1. It profiles every file: title lines, total rows, spaces, "N/A" text, case variants, mixed date, number,
   true/false and id formats, duplicates, anomalies, wide month columns, orphan keys.
2. It proposes the cleaning steps **table by table**. For each table you accept the recommended steps with one
   click, tick the steps you want one by one, or skip the table. Every proposal shows how many rows it touches
   and whether it changes the totals.
3. It proposes a star schema – one fact per business process at its lowest grain, flat dimensions,
   test rows and copies left out, codes given names, a security role from a user-to-region sheet – and you
   accept the whole design or decide point by point (`references/modeling-guide.md` holds the rules).
4. It asks about relationships, a date table and measures, and about extras (dashboard, catalog, check in Power
   BI Desktop). Before the build it shows all your choices, and you can change any of them.
5. It writes the PBIP. Every cleaning step is a named Power Query step (`F08 Parse order_date` …), so you can
   still switch one off in Power BI under *Applied steps*.

Results are in `runs/<date>_pbi_<name>/`: the PBIP, `overview.html` (sources → staging → star schema → report),
`cleaning-log.md` (what was and was not cleaned), `expected-values.md` and `checks.dax` (paste it into Power BI's
DAX query view after a refresh; every difference should be 0). `/pipeline-power-bi --resume <run-id>` reopens
your choices. The model is generated from the choices by `scripts/build-model.js`, so a changed choice is a rerun,
not a hand edit.

To skip the approval prompt for the profiler, add
`"PowerShell(powershell -NoProfile -ExecutionPolicy Bypass -File *Profile-Sources.ps1*)"` to `permissions.allow` in
`.claude/settings.json` (or your own `settings.local.json`). After changing the skill's scripts, run its tests:
`node .claude/skills/pipeline-power-bi/tests/run-tests.js` (all 103 checks, 25–30 seconds). Add `--quick` for
83 checks in about 15 seconds while you work: it skips the drift checks and the Python checks (model health, grounded answers, catalog). Run the full
set before a commit. The first run after a change to the profiler takes about 15 seconds longer, because it
compiles the profiler's C# code once.

## Passwords and data

- You choose the passwords of the two database roles yourself in the Supabase SQL Editor. They are never
  written to this repository, never pasted into the chat, and psql reads the loader's password from your own
  `pgpass.conf`.
- Supabase objects are guarded: helper functions refuse any name that is not a pipeline schema
  (`mp_<domain>_s<seed>_bronze|silver|gold`), so your other data cannot be touched by a clean-up.
- The answer keys live only in your private datasets repository and are read into memory for scoring.

## Repository layout

```
.claude/
  commands/pipeline-data-warehouse.md   setup
  commands/messy-pipeline.md            the run (orchestrator)
  agents/                               dataset-publisher, medallion-builder, layout-applier, catalog-builder
  skills/                               the skills (see below); pipeline-power-bi runs on its own
  settings.json                         permissions for this folder only
supabase/migrations/                    roles and guarded helper functions (run once in the SQL Editor)
tools/                                  score.js, build-site.js, sample-sql.js, update-vault.js
profiles/                               saved dashboard profiles (colours, KPIs, sections, title)
pipeline.config.example.json            the shape of your pipeline.config.json
```

| Skill | What it does |
|---|---|
| `messy-dataset` | seeded, deterministic messy datasets with an answer key (13 error types, any currency) |
| `supabase-medallion-powerbi` | CSV → Supabase bronze/silver/gold → star schema → PBIP/TMDL, with a logged decision interview |
| `pbip-layout` | the AdventureWorks report template (8 pages – the user chooses which), mapped to the model's own measures and columns; colours from hex codes or a screenshot change colours only |
| `pbip-catalog` | data catalog (Excel), lineage (Mermaid/HTML), dbdiagram.io model (optional) |
| `pbip-governance` | the PBIP parser `pbip-catalog` builds on, PII heuristics |
| `reconcile` | finds where two numbers that should agree diverge (used when scoring) |
| `pr-review` | reviews a skill fix before it is merged |
| `pipeline-power-bi` | CSV files and Excel workbooks → profile → cleaning steps you switch on or off per table/sheet → PBIP/TMDL with named Power Query steps (no database) |

## Licence

MIT – see `LICENSE`. Some skills are adapted from other MIT-licensed projects; see `NOTICE.md`.

## Obsidian: DAX notes and skill log

With `obsidian.vault` set in `pipeline.config.json`:

- `python tools/dax-vault.py sync <pbip> --vault <vault>` writes one note per measure (`type: dax-measure`) with status and
  checks for Dataview; `status` and `list` update and show them.
- The `power-bi-skill-log` skill adds dated entries (what was learned, the exact code, why it works) to
  `Power BI Learning/Power-BI-Skill-Log.md`. To use it in every project, link it into your user skills:
  `New-Item -ItemType Junction -Path "$HOME\.claude\skills\power-bi-skill-log" -Target "<repo>\.claude\skills\power-bi-skill-log"`.
- `pipeline-power-bi` also writes `model-context.md` (definitions for AI assistants), `model-health.md` (size and
  performance) and, before a refresh with new files, `check-drift.js` → `drift.md` (what would break). Business terms
  (`choices.json` → `glossary`) become `DAX/Begreber` notes in the vault on `dax-vault.py sync`; `certify` records who
  approved a measure's definition.
