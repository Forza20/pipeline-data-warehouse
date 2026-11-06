---
description: Set up the pipeline-data-warehouse test bench (messy dataset → Supabase medallion warehouse → Power BI report → catalog, scored against an answer key). Checks and – only with your consent – installs the programs it needs, asks for your Supabase project, GitHub account, currency and culture, and verifies everything.
---

You are setting up **pipeline-data-warehouse** for the person in front of you. Talk to them in English, in
plain language; they may not know the tools by name. Work through the steps in order and show a short
status line after each one. Never install anything, create anything on GitHub or Supabase, or write a
password anywhere without their explicit yes. Arguments: `$ARGUMENTS` (ignored).

## 1. Where are we?

1. The working folder must be the root of this repository (it holds `pipeline.config.example.json` and
   `.claude/commands/messy-pipeline.md`). If not: stop and ask them to open this folder in VS Code (or
   `cd` into it) and start Claude Code there, so the repository's permissions and skills apply.
2. If `pipeline.config.json` exists, setup has run before: show its content (no secrets are in it) and
   ask with AskUserQuestion: "Repair (check everything, change nothing that works) (Recommended)" ·
   "Set up again from scratch" · "Stop". Overwrite nothing without the answer.
3. Platform: Windows 10 or 11 with Windows PowerShell 5.1 or later. Power BI Desktop and the dataset
   generator need Windows. On another OS: explain this and stop.

## 2. Programs – check first, install only what they choose

Check every item (version or "missing") without installing anything, then show one table:

| Program | Needed for | Check | Install command (Windows, winget) | Size |
|---|---|---|---|---|
| Git | datasets repo, skill fixes | `git --version` | `winget install --id Git.Git -e` | ~300 MB |
| GitHub CLI | creating the private datasets repo, login | `gh --version`; `gh auth status` | `winget install --id GitHub.cli -e` | ~40 MB |
| Node.js (18+) | report validation, project site, scoring | `node --version` | `winget install --id OpenJS.NodeJS.LTS -e` | ~100 MB |
| Python 3.12 + openpyxl | data catalog (Excel) | `& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -c "import openpyxl"` (also try `py -3.12`) | `winget install --id Python.Python.3.12 -e --scope user`, then `<python> -m pip install openpyxl` | ~100 MB |
| PostgreSQL client (psql 15+) | loading CSV files into Supabase | `Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe"` or `psql --version` | `winget install --id PostgreSQL.PostgreSQL.17 -e --override "--mode unattended --disable-components server,pgAdmin,stackbuilder"` | ~150 MB |
| Power BI report CLI | validating the report files | `powerbi-report-author --version` | `npm install -g @microsoft/powerbi-report-authoring-cli` (needs Node.js) | ~30 MB |
| Power BI Desktop (optional) | opening the finished report, screenshots | `Get-Command PBIDesktop -ErrorAction SilentlyContinue`, or the Microsoft Store app | `winget install --id Microsoft.PowerBI -e` | ~700 MB |

Also check two things inside Claude Code that winget cannot install:
- **Supabase connector:** the Supabase MCP tools respond (`list_projects`). If not: they connect Supabase
  under claude.ai → Settings → Connectors, restart Claude Code, and run this command again.
- **Power BI authoring plugin:** the skills `powerbi-authoring:powerbi-report-cli` and
  `powerbi-authoring:semantic-model-authoring` are listed. If not, they type in Claude Code:
  `/plugin marketplace add microsoft/skills-for-fabric`, then `/plugin install powerbi-authoring@fabric-collection`,
  and restart Claude Code.

If something is missing, ask with AskUserQuestion (multiSelect; max 4 options per question – use more
questions if more is missing): "Which of these should I install now?" One option per missing program,
with what it is needed for and its size in the description. Then:
- Install only the chosen ones, one command per tool call, and check each with its version command.
  winget may show a Windows prompt (UAC) – tell them to accept it.
- A program installed in this session is often not on PATH until Claude Code restarts: use the full path
  (e.g. `C:\Program Files\Git\cmd\git.exe`) for the rest of setup and tell them to restart afterwards.
- A required program they did not choose: say which pipeline steps cannot run without it. If Git, Node.js,
  Python, psql or the report CLI is still missing, stop setup here with the list – nothing is half-done.
  Power BI Desktop is optional: without it the run finishes, only without screenshots.
- `gh auth status` not logged in: ask them to run `gh auth login` themselves (it opens a browser) and wait.

## 3. Their settings → `pipeline.config.json`

Ask with AskUserQuestion (each question standing on its own):
1. **Supabase project:** call `list_projects` and offer up to 4 projects (name + region; status must be
   `ACTIVE_HEALTHY`). Say what the pipeline will create there: two login roles (`powerbi_reader`,
   `pipeline_loader`), four helper functions in `public`, and three schemas per run named
   `mp_<domain>_s<seed>_bronze|silver|gold`. Nothing else is touched. A free project (500 MB) holds about
   3 runs; older runs are removed at the start of a new run, with their consent.
2. **Currency and culture** of the generated data and the Power BI model: "USD, en-US (Recommended)" ·
   "EUR, en-IE" · "GBP, en-GB" · Other (any ISO currency code + .NET culture name, e.g. "DKK, da-DK").
3. **GitHub:** owner = `gh api user --jq .login` (confirm it), datasets repository name "messy-datasets
   (Recommended)" or their own. It should be **private**: it holds the answer keys the runs are scored
   against (step 5 explains why and lets them choose).
4. **Obsidian notes:** "No (Recommended)" · "Yes – I will give the vault path". With yes, ask for the path in
   chat and check the folder exists.
5. **dbdiagram.io data model** (a second AskUserQuestion call): "Yes – write `model.dbml` for dbdiagram.io
   (Recommended)" · "No". With yes, every run writes the data model as DBML that can be pasted into
   dbdiagram.io (free, in the browser); with no, the catalog skips it.

Pooler host: the Session pooler host in Supabase → Connect. Try `aws-0-<region>.pooler.supabase.com` and
`aws-1-<region>.pooler.supabase.com` (region from `get_project`) in step 4.3; if neither works, ask them to
copy the host from Connect → Session pooler.

Write `pipeline.config.json` in the repository root with the shape of `pipeline.config.example.json`
(`workspace` = the absolute path of this folder; `tools.psql` / `tools.python` = the full paths found in
step 2). It is git-ignored and holds no passwords.

## 4. Supabase

1. Check what exists with one read-only `execute_sql`: the roles `powerbi_reader` / `pipeline_loader` and
   `to_regprocedure('public.<name>(text)')` for `mp_drop_schema`, `mp_grant_reader`, `mp_grant_loader`,
   `mp_revoke_loader`.
2. Whatever is missing: show the files in `supabase/migrations/` in order (0001 → 0003), explain in two
   lines what each does, and ask them to run them in Dashboard → SQL Editor (Claude Code's permission check
   refuses `security definer` functions and role changes, so they run them). Wait, then check again.
3. Passwords: ask them to set both passwords themselves in the SQL Editor (`alter role … with password …`,
   as in the comment at the end of `0001_pipeline_roles.sql`) and to add the loader line to
   `%APPDATA%\postgresql\pgpass.conf`:
   `<pooler host>:5432:postgres:pipeline_loader.<project_ref>:<password>`. Offer to create the empty
   folder/file for them. **Never** ask for a password, read, print or write the pgpass file, or set
   `PGPASSWORD`. Check only with `Select-String -Quiet` that a line containing `pipeline_loader.<project_ref>`
   exists.
4. Test the login: `& "<psql>" "host=<pooler host> port=5432 dbname=postgres user=pipeline_loader.<project_ref> sslmode=require" -w -c "select current_user"`.
   Failure: show the error line and help (wrong host → try the other pooler host; password → re-check the
   pgpass line; the file must have no BOM). Save the working host in the config.
5. Safety test: `select public.mp_drop_schema('public')` must **fail** with "is not a pipeline schema".

## 5. Private datasets repository

1. `gh repo view <owner>/<datasets_repo>`. If it does not exist, show the command and ask before running it:
   `gh repo create <owner>/<datasets_repo> --private --description "Seeded messy datasets and answer keys for pipeline-data-warehouse"`.
   If the permission check refuses it, give them the command to run and wait.
2. Clone it into `datasets\` (git-ignored) with a sparse checkout, so the answer keys never sit on disk:
   `git clone <url> datasets`, then `git -C datasets sparse-checkout set --no-cone /runs/ /README.md /.gitattributes`.
3. An empty repo gets a first commit: `.gitattributes` with `* -text` (keeps the CSV files byte-identical)
   and a two-line `README.md`; push it.
4. Check the visibility: `gh repo view <owner>/<datasets_repo> --json visibility`. Private → set
   `github.datasets_visibility = "private"` in the config and go on. **Public** → do not stop; explain first,
   in plain language, then let them choose:
   - *What is in it:* every run commits its dataset **and its answer key** (`answers/<run-id>/` – the error
     types that were injected and the numbers the warehouse should end up with). The whole test rests on the
     agents not seeing the answer key while they work.
   - *Private (recommended):* only they can read it, so the score shows what the skills really found.
   - *Public – the risks:* (1) the test can be invalidated: an agent being tested could find the answer key on
     GitHub (a web search, `gh`, a link) – it has a rule not to look, but a private repository makes it
     impossible instead of just forbidden; (2) the score loses its value, because "8/8 errors found" only means
     something when the answers were hidden; (3) anyone can read the expected numbers of every run, and
     others using the same seed can copy them instead of testing their own skills. The data is synthetic and
     holds no passwords or personal data, so it is not a security problem – the risk is to the test.
   Then ask with AskUserQuestion, the explanation summed up in each option's description: "Make it private
   (Recommended)" – run `gh repo edit <owner>/<datasets_repo> --visibility private --accept-visibility-change-consequences`
   after their yes (if the permission check refuses it, give them the command or the GitHub path Settings →
   General → Danger Zone → Change visibility, and wait); "Keep it public – I accept the risk"; "Use another
   repository" (back to step 5.1 with a new name). Save the choice as `github.datasets_visibility`
   (`"private"` or `"public-accepted"`).

## 6. Skills and agents

The skills ship in `.claude/skills/` (project skills; Claude Code loads them when it starts in this folder):
`messy-dataset`, `supabase-medallion-powerbi`, `pbip-layout`, `pbip-catalog`, `pbip-governance`,
`reconcile`, `pr-review`. The agents are in `.claude/agents/`, the run command in `.claude/commands/messy-pipeline.md`.
- Check every skill folder has a `SKILL.md` and every agent file valid front matter.
- If `~/.claude/skills/` has skills with the same names, say so: inside this folder the project skills are
  used, and the agents read the skill files by path from `.claude/skills/`.

## 7. Verify

1. Generator: `& .claude\skills\messy-dataset\scripts\New-MessyDataset.ps1 -Seed 1 -PlanOnly` prints a plan.
2. `select public.mp_drop_schema('public')` failed in 4.5; the four helpers exist; both roles exist.
3. psql login worked (4.4).
4. `powerbi-report-author --version`, `node --version`, `<python> -c "import openpyxl"` all work.
5. `datasets\` is a sparse clone of the datasets repository; private, or public with the risk accepted
   (`github.datasets_visibility`).
6. `pipeline.config.json` is complete and git-ignored (`git check-ignore pipeline.config.json`).

Finish with a short report: a table (item → OK / missing + what to do), and the next steps:
1. **Restart Claude Code** (new agents and skills load at start; new programs reach PATH).
2. Start a test run with `/messy-pipeline` (or `/messy-pipeline retail 42 --rows 5000` for a quick one).
