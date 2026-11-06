---
description: Run the pipeline-data-warehouse test - messy dataset → Supabase medallion warehouse → Power BI dashboard → data catalog - and score the result against the answer key
argument-hint: "[domain] [seed] [--rows N] [--errors 1,3,5] [--resume <run-id>]"
---

You are the orchestrator of pipeline-data-warehouse. Working directory: the repository root. Talk to the
user in English, in plain language. Arguments: `$ARGUMENTS`

Parse the arguments: optional domain (`retail|hotel|saas`), optional seed (integer), `--rows N` (default
20000), `--errors 1,3,5` (default: chosen by the seed), `--resume <run-id>`. Anything else: stop and ask what
was meant.

## 1. Pre-checks (short)

- `pipeline.config.json` exists. If not: stop and tell the user to run `/pipeline-data-warehouse` first.
  Read it; every path, id and setting below comes from it (`<project_ref>`, `<pooler_host>`, `<psql>`,
  `<python>`, `<owner>/<datasets_repo>`, `<currency>`, `<culture>`).
- Programs: `git --version`, `node --version`, `powerbi-report-author --version`, `& "<python>" -c "import openpyxl"`,
  `Test-Path "<psql>"`. Anything missing: stop, name it, and offer to install it with the command from
  `/pipeline-data-warehouse` step 2 – **ask first**, install only on yes.
- Supabase project `<project_ref>` is `ACTIVE_HEALTHY` (`list_projects`), and `public.mp_drop_schema`,
  `mp_grant_reader`, `mp_grant_loader`, `mp_revoke_loader` exist (`select to_regprocedure('public.<name>(text)')`).
  Missing: point to `supabase/migrations/` (the user runs the files in the SQL Editor) and stop.
- psql login: `%APPDATA%\postgresql\pgpass.conf` has a line containing `pipeline_loader.<project_ref>` (test
  with `Select-String -Quiet`, never print the file), then
  `& "<psql>" "host=<pooler_host> port=<pooler_port> dbname=postgres user=pipeline_loader.<project_ref> sslmode=require" -w -c "select current_user"`.
  Fails: ask the user to fix the password or the pgpass line, and stop.
- `datasets\` is a clone of `<owner>/<datasets_repo>` and the repository is private
  (`gh repo view <owner>/<datasets_repo> --json visibility`). Public: stop – the answer keys must not be
  readable.
- Power BI Desktop: if it is open (`Get-Process PBIDesktop -ErrorAction SilentlyContinue | ? MainWindowTitle`),
  ask the user to save and close it.
- **Decide Desktop yourself – do not ask.** Free memory (`Win32_OperatingSystem.FreePhysicalMemory`) below
  1.5 GB, or Power BI Desktop not installed → set `steps.layout.skip_desktop = true` (with the reason) when
  you create `run.json`. The layout step then ends without a screenshot; the scorecard notes it as a remark.
- Ask the user nothing else technical unless a step is really blocked – apart from sections 2b and 2c.

## 2. run.json

- `--resume <run-id>`: read `runs\<run-id>\run.json` and continue from the first step that is not `done`. A
  step with `waiting_for_user`: show its `reason`, help the user resolve it, then set it back to `pending`
  and continue.
- New run: seed = argument or a random integer 1–999999. Get the plan from the generator:
  `& .claude\skills\messy-dataset\scripts\New-MessyDataset.ps1 -Seed <seed> -PlanOnly` (plus `-Domain` /
  `-Errors` if given). `run_id = <yyyy-MM-dd>_<domain>_s<seed>` (today's date). If `runs\<run_id>\` already
  exists: ask whether to resume it or stop. Create `runs\<run_id>\` with `medallion\`, `pbip\`, `screenshots\`
  and `run.json`:

```json
{
  "run_id": "<run_id>", "domain": "<domain>", "seed": <seed>, "rows": <rows>, "errors": [<errors>],
  "schema_prefix": "mp_<domain>_s<seed>_", "currency": "<currency>", "culture": "<culture>",
  "paths": {
    "dataset": "datasets/runs/<run_id>",
    "medallion": "runs/<run_id>/medallion",
    "pbip": null
  },
  "steps": {
    "publish": { "status": "pending" }, "medallion": { "status": "pending" },
    "layout": { "status": "pending" }, "catalog": { "status": "pending" }, "score": { "status": "pending" }
  }
}
```

Show the user: run-id, domain, seed, rows, the number of error types (not which ones – the list is in
run.json for the agents that need it).

## 2b. Questions before the start (layout and medallion)

The agents cannot ask the user, so ask here, **all before step 3**, with AskUserQuestion (max 4 questions
per call, 2–4 options each; the tool adds "Other" itself; the recommended option first, marked
"(Recommended)"). Make every question stand on its own. Only for a new run, or a resumed run whose
`run.json` has no `questions_asked`. Never mention which error types are injected, and ask the same
questions whatever the dataset holds. When done, set `"questions_asked": "<timestamp>"`.

**Layout (one call):**
1. *Colours:* "Standard (Recommended)" · "Saved profile" (only if `profiles\default.json` exists; show its
   name and colours) · "Hex codes" · "Screenshot of a website". For hex codes: take them from the answer or
   ask in chat, and map them to the keys in `.claude\skills\pbip-layout\colors.md`. For a screenshot: ask for
   the file path in chat (an image pasted into the chat has a path too), run
   `powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\pbip-layout\scripts\palette.ps1 -Path "<image>"`,
   and show the palette it finds (colors.md → "From a screenshot"). A screenshot dominated by a large photo
   can skew the background colour: then offer an adjusted palette built from the header, buttons and text,
   next to the script's suggestion, with a preview of both.
2. *Sections* (multiSelect): monthly cards, highlight tiles, bar chart, top-10 table – all selected is the
   default.
3. *Title:* "Sales overview (Recommended)" or the user's own text (Other).
4. *Save as default:* "Only this run (Recommended)" · "Save as `profiles\default.json`".
Write the answers as a profile (`pbip-layout\profile.md`) to `runs\<run_id>\profile.json` and set `run.json`
→ `"profile": "runs/<run_id>/profile.json"`; also copy it to `profiles\default.json` when asked. Answer
"Standard" with no other change: write no profile (saved profile: set `profile` to `profiles/default.json`).

**Medallion:**
1. First call, one question: "Use the skill's recommendation for every decision (Recommended)" · "I want to
   answer myself". With the first answer, write `"medallion_answers": "recommended"` and go on.
2. Otherwise read `.claude\skills\supabase-medallion-powerbi\references\decision-interview.md` and ask these
   questions, 4 per call: R1-4, R2-1, R2-2, R2-3, R2-4, R2-5, R2-6, R3-1, R3-2, R3-3, R3-4, R3-5, R3-6, R3-7.
   Each question: its title and one line on why it matters; options = "The skill's recommendation
   (Recommended)" with the recommendation in the description, then the bank's options (at most 3, letter +
   short text + consequence). Say once that an answer applies only if the data has the problem. R1-1, R1-5,
   R1-6 and R4-1–R4-3 have fixed answers and are not asked.
3. Write `"medallion_answers": {"R1-4": "rec", "R2-2": "A", …}` (`rec` = the skill's recommendation; a
   free-text answer is stored as text).

## 2c. Clean-up of old runs (before the start)

Supabase keeps `supabase.keep_runs` runs (default 3), this one included. The permission check refuses
`mp_drop_schema` calls, so the user runs the clean-up at the start, not in the middle of step 2. Only for a
new run, or a resumed run whose `run.json` has no `retention`.
1. One read-only `execute_sql`: the `mp_%` schemas, grouped by prefix (`mp_<domain>_s<seed>_`). Match each
   prefix to `runs\*\run.json` by `schema_prefix`; order by `steps.publish.finished` (this run is the newest).
   Every prefix beyond the newest `keep_runs − 1` others is old; a prefix with no `run.json` is listed but
   never dropped – mention it.
2. No old prefix: set `"retention": {"status": "nothing to drop"}` and go on.
3. Otherwise write `runs\<run_id>\retention.sql`: one `select public.mp_drop_schema('<schema>');` per existing
   schema of each old run, then the check `select nspname from pg_namespace where nspname like '<prefix>%';`
   (expect 0 rows). Ask with AskUserQuestion (which run, which schemas, that it cannot be undone, the file
   path): "I have run it in the SQL Editor (Recommended)" · "Keep the old runs".
4. "Run": verify with the check query (0 rows), then delete each old `runs\<old-id>\` folder (it is only
   local; tell the user). Set `"retention": {"status": "done", "dropped": ["<old-id>", …]}`. "Keep": set
   `"retention": {"status": "kept", "runs": ["<old-id>", …]}`.
Retention is part of the start, like the questions; it is not counted as a stop for the user.

## 2d. Show the choices

Show the user in 3–5 lines: profile (or Standard), sections, title, the medallion answers that differ from
the recommendation, and the retention result. Then start step 3 without waiting.

## 3. Run the agents, one at a time

With the Agent tool, in this order, each given **only** the path `runs\<run_id>\run.json`:
`dataset-publisher` → `medallion-builder` → `layout-applier` → `catalog-builder`. Skip a step whose status
is `done`. `catalog-builder` needs `layout` = `done`; it does not need Desktop. After each agent: read
`run.json` again.
- `failed`: stop, show `error`, and suggest `/messy-pipeline --resume <run_id>` after the fix.
- `waiting_for_user`: show `reason` and what the user must do (e.g. run a SQL file in the SQL Editor). Wait
  for the answer, verify, set the step to `done` (or `pending` to rerun it) and continue. Never perform a
  call an agent was refused on its behalf.
- Never pass the answer key or anything from it to an agent.

## 4. Scorecard (`runs\<run_id>\scorecard.md`) – only when medallion is `done`

Set `steps.score` to `running`. Fetch the answer key into your context only (never write it under `runs\` or
`datasets\`):
```
git -C datasets fetch -q origin
git -C datasets show origin/main:answers/<run_id>/expected_findings.json
```
The values file is read by `tools/score.js` (section 3), not by you. The rules behind the expected numbers:
`.claude\skills\messy-dataset\references\answers-format.md` – read only its "Reference rules" and "Typical
explained deviations" sections, and only when a difference needs explaining.

**Keep the context small:** read only the sections of the agents' docs you need (Grep, then Read with
offset/limit); no full dumps of large tool results; use `git -q` where it exists.

**Format** (`tools/build-site.js` and `tools/update-vault.js` read it): the first paragraph starts with
`**Result: <result>** – <one-sentence summary>`; the sections are `## 1. Errors found` … `## 6. Result`; in
section 1 the "Injected?" column says `yes` or `no` and the verdict column uses ✅ (found), ✔ (not applicable –
checked), ⚠ (partly) or ❌ (missed); section 3 is the table from `tools/score.js`.

Sections:
1. **Errors found** – a table with one row per catalogue type 1–13: injected? / found in `model-decisions.md`
   or `data-quality.md`? / count found vs answer key / verdict (✅ found, ✔ not applicable – checked).
   Requirement: 100 % of injected types found. Types not injected: logged as "not applicable – checked" and
   not invented (an invented finding is an error).
2. **Technical** – quality checks all 0 (`docs\quality-results.md`, and rerun one count yourself); PBIP
   validates (`powerbi-report-author validate`); in one `execute_sql` call on the gold schema: RLS on every
   table, select right and a policy for `powerbi_reader`, no `security definer` functions in the run's
   schemas, `pipeline_loader` has no rights left on bronze. Do not call `get_advisors` (its output covers
   every schema in the project).
3. **Numbers** – run `node tools/score.js runs/<run_id>`. It compares the agent's
   `medallion\docs\expected-values.json` with the answer key and prints the table (key → answer key → gold →
   difference → explanation `**?**`). Check one or two of the agent's numbers with your own SQL on
   `<schema_prefix>gold` (e.g. `clean_revenue` and one month); a mismatch with the file is a technical error.
   Paste the table and replace each `**?**` with the logged decision that explains it (cite the id, e.g.
   R2-5) using the rules in `answers-format.md`; an unexplained difference counts as an error.
   **A difference you cannot explain at once:** follow `.claudeskillseconcileSKILL.md` with the two sides – the answer-key
   value with its reference rule, and your SQL on gold – split it by the dimensions until it sits in one
   slice (status, month, key, date status …), and name each cause with the rows behind it. Save the page as
   `runs\<run_id>\reconcile-<key>.html` and cite it. A difference with no cause left after reconcile is an
   error. Never show answer-key rows to an agent.
4. **Layout** – validation result, `layout-mapping.md`, and your own review of the screenshot (Read it).
   A unit difference between the dashboard and other pages is a remark, not an error.
5. **Catalog** – from `catalog-report.md` and your own spot checks: `catalog.xlsx`, `lineage.md` and – when
   `catalog.dbml` is true in the config – `model.dbml` exist; table/measure/relationship counts equal the TMDL; every dashboard slot in
   `layout-config.json` tagged; the `Revenue` lineage reaches a CSV column; description status and "possible
   PII". A missing file or a count mismatch is a technical error; a lineage gap or missing descriptions is a
   remark.
6. **Result** – *Passed* (100 % found, 0 technical errors, all differences explained), *Passed with remarks*
   (that, but with remarks such as a missing screenshot or a lineage gap), or *Failed*.

Set `steps.score` to `done` with `result`.

## 5. Suggestions for the skills, numbered

For every miss, unexplained difference or rough edge: a numbered suggestion with skill, file, section, the
new text (verbatim), and the reason with numbers from this run. Then ask: "Approve numbers (e.g. 1, 3) or
none." On approval:
1. Edit the skill in `.claude\skills\<skill>\` on a branch `pipeline/<run_id>` of this repository, and commit
   (message in a file, `git commit -q -F <file>`, ending with the user's usual attribution if any).
2. **Review before merge:** follow `.claudeskillspr-reviewSKILL.md` on `git diff main...pipeline/<run_id>`, with the
   repository's own conventions as the standards (the SKILL.md files, README). Save the page as
   `runs\<run_id>\pr-review.html`. *Approve*: `git switch -q main`, `git merge -q --ff-only pipeline/<run_id>`,
   delete the branch. *Changes requested*: fix the high-risk findings on the branch and review again (at most
   2 rounds); if one is still open, do not merge – show it to the user with the page and ask.
3. **Pushing:** only if `origin` is a repository the user can write to
   (`gh repo view --json viewerPermission` → `ADMIN`/`MAINTAIN`/`WRITE`) and they say yes. Otherwise keep the
   fix local and tell them they can share it upstream with a pull request. Never force-push.

## 5b. Overview (always)

1. Update `runs\overview.md` (local, git-ignored): one row per run, newest first – date, run-id (link to its
   `scorecard.md`), domain, seed, rows, error types (count: list), found (n/n), unexplained differences,
   technical errors, stops for the user, result. Below the table: "Error types never tested at full size: …"
   (types 1–13 not injected in any run with ≥ 20,000 rows) and "Stops for the user per run: …".
2. **Project site:** run `node tools/build-site.js runs\<run_id>` (one call). It writes `runs\<run_id>\site.html`
   (overview, architecture, lineage, call graph, data model, data quality, runs, catalog). If the Artifact
   tool is available, publish the file with it (`icon` "diagram", a one-sentence `description`); otherwise
   tell the user to open the file in a browser. If the script reports warnings, mention them in one line;
   never hand-edit the generated page.

## 5c. Obsidian (only when `obsidian.enabled` is true in the config)

1. Run `node tools/update-vault.js runs\<run_id> [--site <project-site URL>]`. It writes the run note in
   `<vault>/<folder>/Runs/<run-id>.md` and rebuilds the run list in `<vault>/<folder>/Pipeline.md`.
2. For every approved and merged suggestion: append one line under "## Fixes from runs" in that skill's note
   (`<vault>/<folder>/Skills/<skill>.md`, created if missing) and under "## Fixes" in the run note.
3. If the vault is a git repository, ask before committing or pushing it.

## 6. Finish (5–8 lines)

run-id, result, the most important findings, and links relative to the repository root to
`runs/<run_id>/scorecard.md`, `runs/<run_id>/screenshots/dashboard.png` (if any),
`runs/<run_id>/pbip/<Name>.pbip` and `runs/<run_id>/pbip/docs/catalog.xlsx`, the project site, and – when
`catalog.dbml` is true – how to open `model.dbml` in dbdiagram.io (Create diagram → paste the file, or
Import → DBML).
