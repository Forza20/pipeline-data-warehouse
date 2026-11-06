---
name: power-bi-skill-log
description: Log what the user learned in a Power BI session (DAX, M/Power Query, data modelling, reporting) as a dated entry in the Obsidian note "Power BI Learning/Power-BI-Skill-Log.md", with the exact code and why it works, and tick the competence in the note's overview. Use when the user asks to log, save or note down a DAX formula, a learning, a solved problem or a session in Obsidian, the skill log or "logbogen", or ends a Power BI session with "log det".
---

# Power BI skill log

Vault: `obsidian.vault` in `pipeline.config.json` of the pipeline-data-warehouse repository (or `OBSIDIAN_VAULT`,
or `--vault`). Note: `Power BI Learning/Power-BI-Skill-Log.md`. New entries go directly under
`<!-- CLAUDE_START -->`, newest first. The script does the insert; never edit the note by hand for a new entry.

Install for all projects (Windows), so the skill is found outside this repository too:
`New-Item -ItemType Junction -Path "$HOME\.claude\skills\power-bi-skill-log" -Target "<repo>\.claude\skills\power-bi-skill-log"`.

## Steps

1. Collect from the conversation (ask only for what is missing and cannot be inferred):
   - `titel` – short, e.g. "YoY-vækst med SAMEPERIODLASTYEAR"
   - `kategori` – `DAX`, `M`, `Datamodellering` or `Rapportering`
   - `kontekst` – the task in one or two sentences
   - `laering` – what the user learned, in their terms
   - `kode` – the exact code as implemented (copy it, do not retype or "improve" it); `sprog` if not DAX
   - `teknisk_note` – why it works (e.g. why `ALL` resets the filter context), two to four sentences
   - `measure` – the measure name, if it is one; links its note in the DAX Measure Oversigt
   - `dato` – only if not today
   Write in Danish, as the rest of the vault.
2. Write the fields as UTF-8 JSON to a file in the scratchpad (never pass code on the command line).
3. Run:
   ```
   python "<this skill folder>\scripts\skill_log.py" add "<entry.json>"
   ```
   It creates the note if it is missing, inserts the entry, ticks the kategori in *Overblik over kompetencer*
   and updates `indlaeg`/`senest` in the frontmatter.
4. If the code is a measure in a model that is synced to the vault, offer to run
   `tools/dax-vault.py sync` in the pipeline-data-warehouse repository so its note is current.
5. Commit and push the vault (`git -C "<vault>"`) only when the user asks.
6. Report in one or two lines: the entry title, the date, whether a competence was ticked.

## Never
- Never invent a learning, code or date the conversation does not contain.
- Never remove or rewrite earlier entries or the user's own edits.
