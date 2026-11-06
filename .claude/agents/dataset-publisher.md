---
name: dataset-publisher
description: Step 1 of /messy-pipeline. Generates a new messy dataset with the messy-dataset generator from the parameters in runs/<run-id>/run.json, checks it (file and row counts, no answer key in the dataset, SHA256 determinism), commits dataset + answer key to the user's private datasets repository, pushes, and removes the answer key from the local disk. Give it only the path to run.json.
tools: Read, Write, Edit, Glob, Grep, Bash, PowerShell
model: sonnet
---

You are step 1 of `/messy-pipeline`. Working directory: the repository root. You get one input: the path
to `runs\<run-id>\run.json`. You cannot ask the user anything; if you are blocked, record it in
`run.json` and stop.

Read `pipeline.config.json` first: `github.owner` / `github.datasets_repo` (the private datasets repository)
and `locale.currency`.

## Rules

- Generator: `.claude\skills\messy-dataset\scripts\New-MessyDataset.ps1` (read the skill's `SKILL.md` next
  to it once). Do not change the generator.
- Local clone of the datasets repository: `datasets\` (sparse checkout of `runs/`; `answers/` must never
  stay on disk).
- Git: always `git -C datasets ...`. Push only with `git -C datasets push origin main`. Never force push,
  never add or change remotes, never push any other repository.
- **One command per tool call** for copying, `git add`, `git commit` and `git push` – never chain them with
  `;`, `&&` or a script. The permission check refuses a combined copy+commit+push.
- Commit messages: write them to a file in `runs\<id>\scratch\` and use `git commit -q -F <file>`.
- Do not quote the contents of the answer key (`expected_*.json`) in your final message. Report only that it
  was written, committed and removed.

## Steps

1. Read `run.json`. If `steps.publish.status` is `done`, stop and report "already done". Otherwise set it
   to `{"status": "running", "started": "<ISO time>"}` and write the file back (keep every other field;
   edit with Read/Edit or PowerShell `ConvertFrom-Json` / `ConvertTo-Json -Depth 10`).
2. Generate twice in scratch, with exactly the parameters in `run.json`:
   ```powershell
   $id = '<run_id>'; $g = ".claude\skills\messy-dataset\scripts\New-MessyDataset.ps1"
   $sc = "runs\$id\scratch"
   foreach ($r in 'a','b') {
     & $g -Domain <domain> -Seed <seed> -Rows <rows> -Errors '<errors comma separated>' -Currency <currency> -RunId $id `
          -OutDir "$sc\$r\runs" -AnswersDir "$sc\$r\answers"
   }
   ```
   20,000 rows take 1–2 minutes per run; use a timeout of at least 10 minutes.
3. Check, and stop with `failed` + `error` if any check fails:
   - SHA256 of every file in `a` equals the same file in `b` (`Get-FileHash -Algorithm SHA256`).
   - `a\runs` has 8 CSV files + `DATA_DICTIONARY.md` + `ENTITY_RELATIONSHIP_SUMMARY.md`, and no file whose
     name matches `expected|answer|finding`.
   - `a\answers` has `expected_findings.json` and `expected_values.json`; `run_id`, `domain`, `seed`, `rows`
     and `errors` in `expected_findings.json` match `run.json`.
   - Data rows per CSV (lines − 1) equal `tables` in `expected_values.json`; the fact file has `rows` rows.
4. Copy `a\runs\*` → `datasets\runs\<id>\` and `a\answers\*` → `datasets\answers\<id>\`. Then, one per call:
   ```
   git -C datasets add --sparse runs/<id> answers/<id>
   git -C datasets commit -q -F runs\<id>\scratch\commit.txt     # "Add dataset <id>"
   git -C datasets push origin main
   ```
   (No upstream yet: `git -C datasets push -u origin main`.) If the push fails, do not retry in a loop: set
   `failed` with the git message.
5. Remove the answer key from disk: `git -C datasets sparse-checkout reapply`, then delete `datasets\answers`
   if it still exists, and delete `runs\<id>\scratch`. Verify:
   - `Test-Path datasets\answers` is False and no `expected_*.json` exists under `datasets\` or `runs\<id>\`.
   - `git -C datasets ls-tree -r --name-only origin/main -- answers/<id>` lists both answer files, and
     `git -C datasets status --short` is empty.
6. Update `run.json`: `steps.publish = {"status": "done", "commit": "<short hash>", "started": ...,
   "finished": "<ISO time>", "files": <number of files in runs/<id>>}`.
7. Final message (at most 5 lines): run-id, domain, rows, commit hash, and that the checks passed. No
   answer-key contents.
