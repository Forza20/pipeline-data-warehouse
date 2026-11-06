---
name: pbip-layout
description: Applies the saved "Sales overview" dashboard layout (dark KPI tiles, trend with forecast, monthly cards, category bars, top-10 table, highlight tiles) to a Power BI PBIP project and connects it to the project's own measures. ALWAYS trigger when the user writes `apply "layout.md"` (also without quotes, e.g. "apply layout.md") together with a PBIP file/folder or a PBIP project open in Power BI Desktop, and when a pipeline agent (e.g. `layout-applier`) is asked to apply the layout – see "Pipeline mode".
---

# Apply layout.md to a PBIP project

The layout is described in [layout.md](layout.md). The generator [scripts/gen-layout.js](scripts/gen-layout.js)
builds the page from a configuration file; [config.example.json](config.example.json) is the original
configuration. DAX templates for missing measures are in [measures.md](measures.md). Colour keys and
ready-made variants are in [colors.md](colors.md). The user's standing choices (colours, KPIs, sections,
title) can be saved as a profile: [profile.md](profile.md).

Work with the user in their language (English by default).

## Prerequisites
- Load the skills `powerbi-authoring:semantic-model-authoring` (measures) and
  `powerbi-authoring:powerbi-report-cli` (PBIR, validate, preview) and follow their rules.
- `powerbi-report-author` CLI installed (`npm install -g @microsoft/powerbi-report-authoring-cli@latest`).
- The project must be PBIP in PBIR format (the folder `<Name>.Report/definition/pages`). If it is a .pbix:
  ask the user for File → Save as → *.pbip, and stop.

## Workflow

1. **Find the project.** Use the uploaded/named path, otherwise search for `*.pbip` in the user's folders.
   Note the `.Report` folder.

2. **Connect to the model.** If the project is open in Power BI Desktop: use powerbi-modeling-mcp
   (`ListLocalInstances` → `Connect`). Otherwise `ConnectFolder` on `<Name>.SemanticModel/definition`. List
   tables, columns, measures and relationships. If the MCP server does not connect: read the TMDL files
   directly (see "Without powerbi-modeling-mcp").

   **Profile:** if the user has a profile (a `.json` following [profile.md](profile.md), e.g. named or
   uploaded), read it now. What the profile fixes is not asked in steps 3 and 4. Say briefly which choices
   come from the profile.

3. **Colours (only with a user present).** Ask with AskUserQuestion whether the user has colour codes (a
   `.md` file or hex codes) or a screenshot of a website/brand the colours should come from. With neither,
   use *Standard* from colors.md.
   - Make at most 2 variants that change only colours. The placement is fixed (layout.md), so the variants
     must not promise a different arrangement of KPIs or charts. Use e.g. *Standard* and *Brand*, or *Dark*
     and *Brand*.
   - **Screenshot instead of hex codes:** the user can paste a screenshot of a website, a logo or a brand
     page. Measure the colours in the image instead of guessing:
     ```
     powershell -NoProfile -ExecutionPolicy Bypass -File "<skill folder>/scripts/palette.ps1" -Path "<image>"
     ```
     It returns the most used colours with their share and a suggestion for every `colors` key, already
     adjusted to readable contrast. The path of a pasted image is in the message (`[Image: source: …]`). If
     there is no file (only an image in the chat), read the colours visually and say they are estimated.
     Show the suggestion as colour swatches in the HTML preview (step 5), and mention when the accent colour
     was made lighter or darker to stay readable (`accentAdjusted`). A screenshot dominated by a large photo
     can skew the background: then offer an adjusted palette from the header, buttons and text as well.
     Details: colors.md → "From a screenshot".
   - Set the colours with the `colors` keys in colors.md. Derive the missing shades from the primary and
     accent colour by the rule under "Brand".
   - Check the contrast (colors.md → Contrast). If a colour is too light as a tile background, use it as the
     accent instead.
   - With custom colours the other report pages get the same colours through a theme (`theme`, on by
     default). Ask only if the report has pages the user may want to keep as they are.
   *In pipeline mode:* skip this step. Use the profile's colours if there is a profile (see Pipeline mode),
   otherwise *Standard* (no `colors`).

4. **Map the slots.** Use the table "Slots to connect to the model" in [layout.md](layout.md). For each slot,
   find the best existing measure/column; use the fallback when data is missing (e.g. no returns → margin %
   or active customers). Run DAX queries to know the values (total, categories, latest month). Check e.g.
   whether a "line_total" is before or after discount, and whether cost is per unit.
   **The user chooses the KPI tiles** (only with a user present):
   - Show the proposal for KPI 1–4 from the table, and a list of the model's other measures that return one
     number: name, value and display folder. Leave out helper measures (`_cm`, `_pm`, `_label`, `_color`,
     `_spark`).
   - Ask with AskUserQuestion (multiSelect) which 1–4 KPIs to show, and whether the text under the number is
     the measure name or the user's own text (max ~20 characters). The order is the order the user picks.
   - If the user picks a number the model does not have (e.g. "average order value"), propose DAX from
     measures.md and create it in step 6. Do not guess business rules: ask if the definition is unclear.
   - The tiles are spread evenly across the row: 1–4 tiles, never gaps. `kpis` in config.json has one entry
     per chosen KPI, in the chosen order.
   **The user also chooses the sections** (same AskUserQuestion round, only with a user present): number of
   monthly cards (0–3), number of highlight tiles (0–2), and whether the bar chart and top table are shown.
   The answer goes into `sections` in config.json. What is left out makes room for the rest (profile.md,
   last point). Default: everything.
   *In pipeline mode:* use the profile's `kpis` and `sections`, otherwise the proposal KPI 1–4 and all
   sections, without asking.

5. **Show the mapping and the previews, and get approval.** Write config.json (step 7) for each colour
   variant, and make an HTML preview with the generator itself. It writes no report files in this mode, and
   the placement is the same as in Power BI:
   ```
   node "<skill folder>/scripts/gen-layout.js" "<.Report folder>" "<config.json>" --preview "<scratchpad>/layout-<variant>.html"
   ```
   Show a table: slot → measure/column → value (with the chosen KPIs), and which new measures will be
   created. Show the previews too. If the session can publish pages (the Artifact tool), publish them as
   private pages; otherwise give the file paths. Ask with AskUserQuestion about the mapping and the variant.
   Do not build before approval. The numbers in the preview are placeholders – say so.
   *In pipeline mode:* do not ask and make no previews – write the table to a file and continue (see below).

6. **Create missing measures** via MCP from [measures.md](measures.md) (month axis column,
   `_cm`/`_pm`/`_label`/`_cm_color` per monthly card, margin, top texts). Format `#,0` / `0.0%` (amounts with
   the model's currency). Test all of them with one combined `EVALUATE ROW(...)`. If the data ends in the
   middle of a month: monthly cards, sparklines and trend use whole months only (`_spark` measures in
   measures.md), so the lines do not end with an artificial drop.

7. **Write config.json** in the scratchpad with the same structure as [config.example.json](config.example.json).
   Fields are written `Table[Field]`. The chosen colour variant goes into `colors` (keys: colors.md); without
   `colors`, *Standard* is used. Chosen sections go into `sections`, the theme into `theme`, and title/subtitle
   into `title`/`subtitle` (the fields are described in profile.md). `topN.function`: 2 = distinct count, 0 = sum
   (OrderBy must be a column aggregation, not a measure). TopN keeps ties, so the table can show more than
   10 rows – mention it in the report (or `layout-mapping.md`), or add a tiebreaker measure. `navLabels` gives
   short button texts (max ~8 characters). If `table.gradientMeasure` is a rate where high is bad (return
   rate, churn, cancellations), set `table.gradientHigherIsWorse: true` – otherwise the best rows turn red.
   Also save a copy as `<project folder>/docs/layout-config.json` (create `docs/`), so pbip-catalog can tag
   the fields with their slot on the dashboard.

8. **Generate and validate.**
   ```
   node "<skill folder>/scripts/gen-layout.js" "<.Report folder>" "<config.json>"
   powerbi-report-author validate "<.Report folder>"
   ```
   The page gets the id `8d1e4c7a2b5f9e3d6c10`, the name "Dashboard" and is placed first. A rerun overwrites
   only this page. Fix every error in the generated files. The error `PBIR_JSON_FILE_NO_SCHEMA` on
   `.pbip`/`definition.pbir` comes from Desktop itself and can be ignored.

9. **Show it in Desktop and take a screenshot** following powerbi-report-cli's preview rules (`--status` →
   open/reload → `--screenshot`). With `hasUnsavedChanges: true`: ask the user to save (Ctrl+S) – Desktop may
   then overwrite the report files, so run step 8 again afterwards. Review the screenshot and fix errors
   (empty visual, clipped text, wrong colours). Check especially that the KPI and highlight tiles have the
   `dark` colour from the config (default `#333333`), and that the colours match the approved preview.
   `cardVisual` draws its own white tile ("Multi-card layout → Background"); the generator switches it off
   with `objects.layout.backgroundShow = false` (`fillCustom.transparency = 100` alone does not work). If the
   tiles are still white boxes with a dark border, note it under "Open points" in `layout-mapping.md` – or,
   with a user present: have the user switch the background off on one tile in Desktop, save, compare
   `visual.json` before/after, and fix `card()` in `scripts/gen-layout.js` with the property Desktop wrote.
   *In pipeline mode:* ask the user nothing – stop and report back (see below).

10. **Report** briefly: what was built, which numbers are where, new measures, and any deviations from the
    layout and the chosen colour variant. If the user chose colours, KPIs or sections without a profile:
    offer to save the choices as a profile (profile.md), e.g. `profiles/<name>.json` in the user's project.
    KPIs are saved by measure name (`measure`), so the profile also fits other models with the same names.

11. **Offer a data catalog.** Ask whether the skill `pbip-catalog` should run now (data catalog in Excel,
    lineage and – optionally – a dbdiagram.io model, from the project and `docs/layout-config.json`). On yes:
    load `pbip-catalog` with the Skill tool, or follow `.claude/skills/pbip-catalog/SKILL.md` in the repo.
    *In pipeline mode:* do not ask – write in `layout-mapping.md` that the catalog can run afterwards.

## Fixed rules
- All numbers as whole numbers (no K/M) – the generator sets `labelDisplayUnits` = 1.
- Never change existing pages; only the dashboard page and `pages.json`. Exception: with custom colours the
  generator registers a theme (`StaticResources/RegisteredResources/pbip-layout-theme.json` and `customTheme`
  in `definition/report.json`) that the other pages follow. Without colours it is removed again.
- Never publish to Fabric without an explicit instruction.

## Pipeline mode (run by an agent without a user)

Applies when the skill is run by a subagent, e.g. `layout-applier` in `/messy-pipeline`, or when the task
says "pipeline mode". A subagent cannot ask the user, so:

- **Profile:** if the task or `run.json` (`profile`) has a profile path, use that profile for colours,
  theme, KPIs, sections and title (profile.md). Otherwise *Standard*: no `colors`, the proposal KPI 1–4 and
  all sections. Write in `layout-mapping.md` which profile was used, and which profile measures the model
  lacked.
- **Step 3 (colours):** do not ask; use the profile or *Standard*. Make no HTML previews.
- **Step 5 (approval):** write the mapping table (slot → measure/column → value → new measures → fallback
  used) to `layout-mapping.md` in the run folder, and continue without asking. Always choose the slot
  mapping listed first in the table in layout.md; use a fallback only when the model lacks data, and say which.
- **Step 9 (Desktop):** first check that Desktop is closed before writing files. If Desktop is open with
  unsaved changes, or opening/the screenshot fails (memory, sign-in): do not retry, do not write further, and
  finish with status `waiting_for_user` and the reason. The calling orchestrator asks the user.
- **No AskUserQuestion** anywhere. Every doubt goes to an "Open points" list in `layout-mapping.md` together
  with the choice you made.
- **Skills:** load `powerbi-authoring:semantic-model-authoring` and `powerbi-authoring:powerbi-report-cli`
  with the Skill tool. If they are not in the session: follow this file alone and note it in `layout-mapping.md`.
- **Formatting:** the "whole numbers" rule applies to the dashboard page, even if other pages in the project
  use millions. Mention the difference in `layout-mapping.md`; do not change the other pages.

### Without powerbi-modeling-mcp

When the MCP server does not connect (in and outside pipeline mode):

- **Model:** read tables, columns, measures and relationships directly in
  `<Name>.SemanticModel/definition/*.tmdl` and `tables/*.tmdl`.
- **Values (step 4):** if DAX cannot run, take the control values from the source. For a PBIP built with
  `supabase-medallion-powerbi`: SQL on the gold schema via the Supabase MCP, or the project's
  `expected-values.md`.
- **New measures (step 6):** write them directly in `tables/_Measures.tmdl` (or the existing measure table)
  with **Desktop closed**: tab indentation, one new GUID per `lineageTag`, names in quotes when they contain
  spaces, multi-line DAX one level deeper than the properties. Check afterwards that no lineageTag repeats
  and that no line is indented with spaces.
- **Test:** instead of `EVALUATE ROW(...)`: open in Desktop (step 9) and compare cards and table with the
  control values from the source.
