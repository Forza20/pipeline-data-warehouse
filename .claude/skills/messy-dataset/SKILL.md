---
name: messy-dataset
description: >
  Generate a deliberately messy, deterministic test dataset (retail, hotel or SaaS) with a known answer
  key, for testing data-modelling skills and pipelines end to end. A Windows PowerShell 5.1 generator
  writes CSV files plus a data dictionary, injects 7-10 error types from a catalog of 13 (mixed ID and
  date formats, duplicates without timestamps, orphan keys, many-to-many fanout, wide month columns,
  revenue on cancelled rows, amount anomalies, bad dates, an incomplete last month, versioned prices,
  conflicting sources, a data dictionary that lies) and writes the answer key to a separate folder.
  Use it whenever the user or a pipeline agent (dataset-publisher in /messy-pipeline) wants a new
  messy dataset, a dirty CSV test set, a seeded synthetic dataset with expected findings, or wants to
  regenerate or explain one.
---

# messy-dataset

Generates a dirty dataset whose problems are known in advance, so a modelling run can be scored
against an answer key. Same parameters → byte-identical files.

## Run the generator

```powershell
$g = ".claude\skills\messy-dataset\scripts\New-MessyDataset.ps1"   # project skill; or ~/.claude/skills/... if installed globally
& $g -Seed 42 -PlanOnly                                   # which domain + errors the seed picks (JSON)
& $g -Domain hotel -Seed 42 -RunId 2026-10-30_hotel_s42 `
     -OutDir <dataset folder> -AnswersDir <answers folder>
```

| Parameter | Default | Notes |
|---|---|---|
| `-Domain` | chosen from the seed | `retail`, `hotel`, `saas` (`references/domains.md`) |
| `-Seed` | random, printed | all randomness comes from one `System.Random($Seed)` |
| `-Rows` | 20000 | fact rows in the file, duplicates included |
| `-Errors` | 7–10 chosen from the seed | e.g. `1,3,5` or `"1,3,5"`; `none` = clean data |
| `-OutDir` / `-AnswersDir` | required | must be separate folders, neither inside the other |
| `-RunId` | `<domain>_s<seed>` | written into the answer files |
| `-EndMonth` | `2026-09` | last month of the data; fixed so output does not depend on today's date |
| `-Currency` | `USD` | ISO code used in the data dictionary labels and the `1234.50 <code>` amount format (e.g. EUR, GBP, DKK); the numbers do not change |

The seed always draws the domain and the error set first, then `-Domain` / `-Errors` override them,
so a run is reproducible from the parameters in `expected_findings.json`. 20,000 rows take about
1–2 minutes on a small machine; 2,000 rows about 10 seconds.

Output:
- `-OutDir`: 8 CSV files, `DATA_DICTIONARY.md`, `ENTITY_RELATIONSHIP_SUMMARY.md`. **No answer data.**
- `-AnswersDir`: `expected_findings.json` (what was injected, with counts) and `expected_values.json`
  (reference numbers). Formats and the reference rules: `references/answers-format.md`.

CSV rules: UTF-8 without BOM, `\n` line endings, comma separator, header in line 1, fields that contain
a comma are double-quoted, no field contains a double quote (so a simple regex splitter works).

## Keep the answer key away from the model builder

The point of the dataset is that the builder finds the problems itself. Whoever builds the model must
not read `-AnswersDir`, `expected_*.json` or this skill's `references/error-catalog.md` /
`answers-format.md` before the run is scored. In `/messy-pipeline` the publisher pushes the answers
to the repo and deletes them locally; only the orchestrator reads them, after the build.

## Verify a generated dataset

1. Run twice with the same parameters into two scratch folders and compare `Get-FileHash -Algorithm
   SHA256` of every file – all must match.
2. No file in `-OutDir` whose name matches `expected|answer|finding`.
3. Every CSV line has as many fields as the header (split with `("[^"]*"|[^,]*),` on `line + ','`).
4. Row counts match the `tables` block in `expected_values.json`.

## Reference files

- `references/domains.md` – tables and columns per domain, and the shared role contract.
- `references/error-catalog.md` – the 13 error types: how each is injected and how to detect it.
- `references/answers-format.md` – `expected_findings.json`, `expected_values.json` and the reference
  rules behind every expected number.
